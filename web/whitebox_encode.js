import {AvcMp4Muxer} from './whitebox_mp4.js';
import {normalizeRecording} from './whitebox_recording.js';

export function renderError(code, error) {
    const message = String(error?.message ?? error).split(/\r?\n/)[0];
    return Object.assign(new Error(`${code}: ${message}`), {code});
}

// Shared with the browser codec probe: a real VP9 encoder can exercise this
// path on Chromium distributions that omit their H.264 encoder.
export function createWebCodecsEncoder(canvas, config, output) {
    let failure;
    const encoder = new VideoEncoder({
        output(chunk, metadata) {
            try { output(chunk, metadata); } catch (error) { failure = error; }
        },
        error(error) { failure = error; },
    });
    try { encoder.configure(config); } catch (error) { encoder.close(); throw error; }
    const check = () => { if (failure) throw renderError('encode_unsupported', failure); };
    return {
        async add(index, fps, draw) {
            check();
            draw?.();
            const frame = new VideoFrame(canvas, {
                timestamp: Math.round(index * 1000000 / fps),
                duration: Math.round((index + 1) * 1000000 / fps) - Math.round(index * 1000000 / fps),
            });
            try { encoder.encode(frame, {keyFrame: index % 24 === 0}); } finally { frame.close(); }
            // At most four raw frames may be queued, even on software encoders.
            if (encoder.encodeQueueSize >= 4) await encoder.flush();
            check();
        },
        async finish() { await encoder.flush(); check(); },
        cancel() { if (encoder.state !== 'closed') encoder.close(); },
    };
}

function createRecorder(canvas, fps, frames, mime) {
    // Give recorder initialization a real source rate, and leave time for
    // software encoders. The compressed output is retimed to the requested fps.
    const captureFps = Math.min(fps, 12);
    const stream = canvas.captureStream(captureFps);
    const track = stream.getVideoTracks()[0];
    if (!track?.requestFrame) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('Manual canvas capture is unavailable');
    }
    let recorder;
    try { recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 6000000}); }
    catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
    const parts = [];
    let failure, rejectStop, rejectStart;
    const started = new Promise((resolve, reject) => {
        recorder.onstart = resolve; rejectStart = reject;
    });
    started.catch(() => {});
    // requestFrame() is only a request. Advancing before the capture callback
    // can coalesce or drop frames, especially with asynchronous GPU readback.
    // Observe a clone so the recorder keeps its original track untouched.
    const observer = track.clone();
    let reader, video;
    if (typeof MediaStreamTrackProcessor === 'function') {
        reader = new MediaStreamTrackProcessor({track: observer}).readable.getReader();
    } else {
        video = document.createElement('video');
        video.muted = true; video.playsInline = true;
        video.srcObject = new MediaStream([observer]);
        if (typeof video.requestVideoFrameCallback !== 'function') {
            observer.stop(); stream.getTracks().forEach(t => t.stop());
            throw new Error('Canvas capture frame acknowledgement is unavailable');
        }
        video.play().catch(error => { failure = error; rejectStart(error); rejectStop?.(error); });
    }
    const stopped = new Promise((resolve, reject) => {
        rejectStop = reject;
        recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
        recorder.onstop = resolve;
        recorder.onerror = event => {
            failure = event.error || new Error('MediaRecorder failed');
            rejectStart(failure); reject(failure);
        };
    });
    // Cancellation may stop the recorder after the caller has already rejected.
    stopped.catch(() => {});
    recorder.start();
    return {
        async add(index, fps, draw) {
            if (failure) throw failure;
            const start = performance.now();
            const captured = reader ? reader.read().then(({value, done}) => {
                if (done) throw new Error('Canvas capture ended before the next frame');
                value.close();
            }) : new Promise(resolve => video.requestVideoFrameCallback(resolve));
            track.requestFrame();
            draw();
            await Promise.race([captured, stopped]);
            if (index === 0) await started;
            // Recorder timestamps follow the wall clock; leave a full frame
            // interval for capture, including the final frame before stop().
            // Recorder startup and encoder initialization use distinct queues.
            // Keep the first picture stable until both have had time to start.
            const remaining = (index === 0 ? Math.max(200, 1000 / captureFps) : 1000 / captureFps)
                - (performance.now() - start);
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
            if (failure) throw failure;
        },
        async finish() {
            // The observer and recorder receive the final capture on separate
            // task queues. Let the recorder consume it before requesting stop.
            await new Promise(resolve => setTimeout(resolve, Math.max(200, 1000 / fps)));
            if (recorder.state !== 'inactive') recorder.stop();
            await stopped;
            if (!parts.length) throw new Error('MediaRecorder returned no video data');
            const type = recorder.mimeType || mime;
            const blob = await normalizeRecording(new Blob(parts, {type}), {frames, fps, mime: type});
            return {blob, mime: type};
        },
        cancel() {
            if (recorder.state !== 'inactive') recorder.stop();
            stream.getTracks().forEach(t => t.stop());
            observer.stop();
            reader?.cancel().catch(() => {});
            if (video) { video.pause(); video.srcObject = null; }
            rejectStart(new Error('Recording cancelled'));
            rejectStop(new Error('Recording cancelled'));
        },
    };
}

export async function createEncoder(canvas, {width, height, fps, frames}) {
    let lastError = new Error('No supported browser video encoder');
    if (typeof VideoEncoder === 'function' && typeof VideoFrame === 'function') {
        // Baseline level 3.1 covers 960x544 at 24fps. Higher resolutions can
        // negotiate level 4.2; unsupported configurations fall back to capture.
        for (const codec of ['avc1.42001f', 'avc1.42002a']) {
            const config = {codec, width, height, framerate: fps, bitrate: 6000000,
                latencyMode: 'realtime', avc: {format: 'avc'}};
            try {
                const supported = await VideoEncoder.isConfigSupported(config);
                if (!supported.supported) continue;
                const muxer = new AvcMp4Muxer({width, height, fps});
                const encoder = createWebCodecsEncoder(canvas, config, (chunk, metadata) => muxer.add(chunk, metadata));
                return {...encoder, async finish() {
                    await encoder.finish();
                    return {blob: muxer.finalize(frames), mime: 'video/mp4'};
                }};
            } catch (error) { lastError = error; }
        }
    }
    if (typeof MediaRecorder === 'function' && typeof canvas.captureStream === 'function') {
        for (const mime of ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8']) {
            try {
                if (MediaRecorder.isTypeSupported(mime)) return createRecorder(canvas, fps, frames, mime);
            } catch (error) { lastError = error; }
        }
    }
    throw renderError('encode_unsupported', lastError);
}
