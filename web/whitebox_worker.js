// Renders the white-model scenes the Agent submits, in this page: asks the server for work, renders the scene in the
// sandbox, and sends back the video (or the reason it failed). Asking at all tells the Agent that a page is open.
import { agentGet, agentHeaders, agentSend } from './agent_session.js';

const ASK_MS = 4000, RETRY_MS = 30000;

export function startWhiteboxWorker({api, render = null, setTimer = setInterval, clearTimer = clearInterval} = {}) {
    let busy = false, stopped = false, unavailableUntil = 0;
    const load = () => render || import('./whitebox_render.js').then(module => module.renderWhitebox);
    async function work(scene) {
        try {
            const result = await (await load())(scene.code, {});
            const response = await api.fetchApi(`/freevideo/agent/whitebox/${scene.id}/video`, {method: 'POST', credentials: 'same-origin',
                headers: {'Content-Type': result.blob.type || result.mime || 'video/mp4', ...await agentHeaders(api)}, body: result.blob});
            if (!response.ok) throw Object.assign(new Error(`upload HTTP ${response.status}`), {code: 'upload_failed'});
        } catch (error) {
            const message = `${error?.code ? error.code + ': ' : ''}${String(error?.message || error).split('\n')[0]}`.slice(0, 400);
            try { await agentSend(api, 'POST', `/freevideo/agent/whitebox/${scene.id}/failed`, {message}); } catch { /* The scene returns to the queue once its lease ends. */ }
        }
    }
    async function ask() {
        if (busy || stopped || Date.now() < unavailableUntil) return;
        busy = true;
        try {
            const response = await agentGet(api, '/freevideo/agent/whitebox/next');
            if (response.status === 404) { unavailableUntil = Date.now() + RETRY_MS; return; }
            if (!response.ok) return;
            const scene = (await response.json())?.scene;
            if (scene?.id && typeof scene.code === 'string') await work(scene);
        } catch { /* Asked again on the next turn. */ } finally { busy = false; }
    }
    const timer = setTimer(ask, ASK_MS); void ask();
    return {ask, stop() { stopped = true; clearTimer(timer); }};
}
