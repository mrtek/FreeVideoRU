import {createEncoder, renderError} from './whitebox_encode.js';

const THREE_URL = new URL('./vendor/three/three.module.min.js', import.meta.url);
// Total budget grows with the frame count and stays under the server's 150 s lease.
const deadlineMs = frames => Math.min(140000, 10000 + 400 * frames);
let threeSource;
function loadThree() {
    if (!threeSource) threeSource = fetch(THREE_URL).then(response => {
        if (!response.ok) throw new Error(`Bundled Three.js: HTTP ${response.status}`);
        return response.text();
    }).catch(error => { threeSource = null; throw error; });
    return threeSource;
}

// Stringified into a blob Worker owned by the opaque-origin iframe. Untrusted
// code never executes on either Window thread, so even top-level while(true)
// can be stopped by destroying the iframe and its descendant Worker.
function sceneWorker() {
    self.onmessage = async event => {
        self.onmessage = null;
        const {threeCode, sceneCode, width, height} = event.data;
        const port = event.ports[0];
        const send = port.postMessage.bind(port);
        const message = error => String(error?.message ?? error).split(/\r?\n/)[0];
        const report = error => send({type: 'error', message: message(error)});
        self.addEventListener('error', event => { event.preventDefault(); report(event.error || event.message); });
        self.addEventListener('unhandledrejection', event => { event.preventDefault(); report(event.reason); });
        const urls = [];
        let renderer;
        try {
            const moduleURL = code => {
                const url = URL.createObjectURL(new Blob([code], {type: 'text/javascript'}));
                urls.push(url);
                return url;
            };
            const THREE = await import(moduleURL(threeCode));
            // Capture host operations before importing the Agent's module.
            const clamp = Math.min;
            const canvas = new OffscreenCanvas(width, height);
            // Whitebox reference frames use full output resolution; avoiding
            // multisample antialiasing keeps software GL within the deadline.
            renderer = new THREE.WebGLRenderer({canvas, preserveDrawingBuffer: true});
            renderer.setSize(width, height, false);
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            const render = renderer.render.bind(renderer);
            const snapshot = canvas.transferToImageBitmap.bind(canvas);
            const module = await import(moduleURL(sceneCode));
            if (typeof module.build !== 'function') throw new Error('Scene must export build(THREE)');
            const state = await module.build(THREE);
            if (!state?.scene?.isScene || !state?.camera?.isCamera || typeof state.update !== 'function')
                throw new Error('build(THREE) must return {scene, camera, update(t)}');
            // Reference-video output is 960x544. Bound scene-requested shadow
            // textures to 1024px to keep software GL and untrusted allocations
            // practical; PCFSoft shadows and the scene's lighting stay enabled.
            state.scene.traverse(object => {
                if (object.shadow?.mapSize) {
                    object.shadow.mapSize.x = clamp(object.shadow.mapSize.x, 1024);
                    object.shadow.mapSize.y = clamp(object.shadow.mapSize.y, 1024);
                }
            });
            if (state.camera.isPerspectiveCamera) {
                state.camera.aspect = width / height;
                state.camera.updateProjectionMatrix();
            }
            port.onmessage = async event => {
                const {type, index, fps} = event.data;
                if (type !== 'frame') return;
                try {
                    await state.update(Math.min(index / fps, 5.0));
                    render(state.scene, state.camera);
                    if (renderer.getContext().isContextLost()) throw new Error('WebGL context lost');
                    const bitmap = snapshot();
                    send({type: 'frame', index, bitmap}, [bitmap]);
                } catch (error) { report(error); }
            };
            port.start();
            send({type: 'ready'});
        } catch (error) { report(error); }
        finally { urls.forEach(url => URL.revokeObjectURL(url)); }
    };
}

function sandboxWindow() {
    addEventListener('message', function initialize(event) {
        if (event.source !== parent || !event.ports[0]) return;
        removeEventListener('message', initialize);
        const port = event.ports[0];
        let worker, workerURL, bridge;
        const stop = () => {
            worker?.terminate();
            bridge?.port1.close();
            if (workerURL) URL.revokeObjectURL(workerURL);
        };
        port.onmessage = event => {
            if (event.data.type === 'cancel') {
                stop();
                port.postMessage({type: 'stopped'});
            } else bridge?.port1.postMessage(event.data);
        };
        port.start();
        try {
            workerURL = URL.createObjectURL(new Blob([event.data.workerCode], {type: 'text/javascript'}));
            worker = new Worker(workerURL);
            bridge = new MessageChannel();
            bridge.port1.onmessage = event => {
                if (!['ready', 'frame', 'error'].includes(event.data?.type)) {
                    event.data?.bitmap?.close();
                    return;
                }
                const {bitmap} = event.data;
                port.postMessage(event.data, bitmap ? [bitmap] : []);
            };
            worker.onerror = event => { event.preventDefault(); port.postMessage({type: 'error', message: event.message}); };
            worker.postMessage(event.data, [bridge.port2]);
        } catch (error) { stop(); port.postMessage({type: 'error', message: error.message}); }
    });
}

function sandboxDocument() {
    // No same-origin permission, network, nested frames, forms or external
    // scripts. Blob Workers inherit this policy, including connect-src 'none'.
    const policy = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; "
        + "connect-src 'none'; img-src blob: data:; media-src 'none'; frame-src 'none'; "
        + "object-src 'none'; base-uri 'none'; form-action 'none'";
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">`
        + `<script>(${sandboxWindow.toString()})();<\/script>`;
}

/**
 * Render an untrusted Three.js ES module entirely in the current browser.
 * onProgress receives {frames, total, progress}; signal cancels with AbortError.
 * Errors expose code: scene_error | scene_timeout | encode_unsupported.
 * Rendering and encoding have a total deadline of 10 s plus 0.4 s per frame (at most 140 s).
 * Only compressed video samples and the first PNG are retained.
 */
export async function renderWhitebox(sceneCode, {
    width = 960, height = 544, frames = 124, fps = 24, onProgress, signal,
} = {}) {
    if (signal?.aborted) throw new DOMException('Whitebox render aborted', 'AbortError');
    if (typeof sceneCode !== 'string' || !sceneCode.trim()) throw renderError('scene_error', 'Empty scene module');
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)
        || width * height > 4096 * 2160 || !Number.isInteger(frames) || frames < 1 || frames > 3600
        || !Number.isFinite(fps) || fps <= 0 || fps > 120)
        throw renderError('scene_error', 'Invalid width, height, frames or fps');
    if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function')
        throw renderError('scene_error', 'This browser requires Worker and OffscreenCanvas WebGL support');
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.hidden = true;
    iframe.srcdoc = sandboxDocument();
    const channel = new MessageChannel();
    const port = channel.port1;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', {willReadFrequently: true, alpha: false});
    let encoder, firstFrame, pending, stopped, initialized = false, settled = false;
    const bitmaps = new Set();
    let fail;
    const failed = new Promise((resolve, reject) => { fail = reject; });
    const reject = error => {
        if (settled) return;
        fail(error);
        pending?.reject(error);
        pending = null;
    };
    const deadline = deadlineMs(frames);
    const timer = setTimeout(() => reject(renderError('scene_timeout', `Scene exceeded the ${Math.round(deadline / 1000)} s rendering deadline`)), deadline);
    const abort = () => reject(new DOMException('Whitebox render aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, {once: true});
    const receive = () => {
        const response = new Promise((resolve, reject) => { pending = {resolve, reject}; });
        response.catch(() => {}); // A prefetched frame can fail while encoding the preceding one.
        return response;
    };
    port.onmessage = event => {
        const data = event.data;
        if (data.type === 'stopped') { stopped?.(); return; }
        if (settled) { data.bitmap?.close(); return; }
        if (data.type === 'error') { reject(renderError('scene_error', data.message)); return; }
        if (pending) {
            if (data.bitmap) bitmaps.add(data.bitmap);
            const next = pending; pending = null; next.resolve(data);
        }
        else data.bitmap?.close();
    };
    port.start();
    try {
        return await Promise.race([failed, (async () => {
            const threeCode = await loadThree();
            if (settled) return;
            const ready = receive();
            iframe.onload = () => {
                try {
                    if (settled) return;
                    iframe.contentWindow.postMessage({threeCode, sceneCode, width, height,
                        workerCode: `(${sceneWorker.toString()})();`}, '*', [channel.port2]);
                    initialized = true;
                } catch (error) { reject(renderError('scene_error', error)); }
            };
            document.body.appendChild(iframe);
            const started = await ready;
            if (started.type !== 'ready') throw renderError('scene_error', 'Invalid sandbox startup response');
            let nonBlack = false;
            const requestFrame = index => {
                const response = receive();
                port.postMessage({type: 'frame', index, fps});
                return response;
            };
            let nextFrame = requestFrame(0);
            for (let index = 0; index < frames; index++) {
                if (settled) return;
                const data = await nextFrame;
                if (settled) return;
                if (data.type !== 'frame' || data.index !== index || !data.bitmap)
                    throw renderError('scene_error', 'Invalid sandbox frame response');
                // Render the next picture while capturing/encoding this one.
                // At most two bitmaps are alive; the Worker never runs ahead.
                if (index + 1 < frames) nextFrame = requestFrame(index + 1);
                const draw = () => {
                    context.drawImage(data.bitmap, 0, 0);
                    if (!nonBlack) {
                        const pixels = context.getImageData(0, 0, width, height).data;
                        for (let p = 0; p < pixels.length; p += 4) {
                            if (pixels[p] > 3 || pixels[p + 1] > 3 || pixels[p + 2] > 3) { nonBlack = true; break; }
                        }
                    }
                };
                try {
                    if (index === 0) {
                        draw();
                        firstFrame = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                        if (!firstFrame) throw renderError('scene_error', 'First-frame PNG capture failed');
                        if (settled) return;
                        encoder = await createEncoder(canvas, {width, height, fps, frames});
                        if (settled) { encoder.cancel(); return; }
                    }
                    try { await encoder.add(index, fps, draw); }
                    catch (error) { throw error.code ? error : renderError('encode_unsupported', error); }
                } finally { data.bitmap.close(); bitmaps.delete(data.bitmap); }
                if (settled) return;
                onProgress?.({frames: index + 1, total: frames, progress: (index + 1) / frames});
            }
            if (!nonBlack) throw renderError('scene_error', 'All rendered frames are black');
            try { return {...await encoder.finish(), frames, firstFrame}; }
            catch (error) { throw error.code ? error : renderError('encode_unsupported', error); }
        })()]);
    } catch (error) {
        throw error.code || error.name === 'AbortError' ? error : renderError('scene_error', error);
    } finally {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        try { encoder?.cancel(); } catch { /* Continue releasing the sandbox. */ }
        iframe.onload = null;
        if (initialized && iframe.isConnected) {
            // A detached Document may leave a running DedicatedWorker alive.
            // Keep its trusted Window active until it has called terminate().
            await new Promise(resolve => {
                const guard = setTimeout(resolve, 1000);
                stopped = () => { clearTimeout(guard); resolve(); };
                port.postMessage({type: 'cancel'});
            });
        }
        port.close(); channel.port2.close();
        iframe.remove();
        bitmaps.forEach(bitmap => bitmap.close()); bitmaps.clear();
        canvas.width = canvas.height = 0;
    }
}
