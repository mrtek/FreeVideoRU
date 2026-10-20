// ComfyUI answers every node error with its own overlay (or dialog) carrying a traceback, local
// paths and a link to ComfyUI's issue tracker. FreeVideo shows its own failure panel instead, so
// for errors that belong to FreeVideo those two are skipped while the event is delivered; the
// event itself still reaches ComfyUI's stores and every other listener. The stored record keeps its node
// but carries our written explanation instead of the traceback.
const EVENT = 'execution_error';
const DIALOG_KEY = 'global-execution-error';

/** True when the failing node is a FreeVideo node or feeds one (a loader or media node upstream). */
export function ownsFailure(detail, graph) {
    const failing = String(detail?.node_id ?? '');
    if (/^FreeVideo/.test(String(detail?.node_type ?? ''))) return true;
    if (!failing) return false;
    for (const node of graph?._nodes || []) {
        if (!/^FreeVideo/.test(String(node.comfyClass || node.type || ''))) continue;
        const pending = [node], seen = new Set();
        while (pending.length) {
            const current = pending.pop();
            if (!current || seen.has(String(current.id))) continue;
            seen.add(String(current.id));
            for (const input of current.inputs || []) {
                const link = input.link != null ? current.graph?.links?.[input.link] : null;
                if (link) pending.push(current.graph?.getNodeById?.(link.origin_id));
            }
        }
        if (seen.has(failing)) return true;
    }
    return false;
}

function stores(app) {
    try {
        const pinia = app?.extensionManager?._p
            || document.querySelector('#vue-app')?.__vue_app__?.config?.globalProperties?.$pinia;
        return {errors: pinia?._s?.get('executionError'), dialogs: pinia?._s?.get('dialog')};
    } catch { return {}; }
}

/** Skip ComfyUI's own error overlay and dialog for FreeVideo errors. Does nothing when the page lacks them. */
export function installNativeErrorGuard({api, app, owns = detail => ownsFailure(detail, app?.graph), describe = null}) {
    if (!api || api.freevideoNativeErrorGuard) return;
    api.freevideoNativeErrorGuard = true;
    // ComfyUI delivers server messages through dispatchCustomEvent (which calls EventTarget's own dispatchEvent).
    const dispatch = api.dispatchCustomEvent;
    if (typeof dispatch !== 'function') return;
    api.dispatchCustomEvent = function (type, detail) {
        if (type !== EVENT) return dispatch.call(this, type, detail);
        let quiet = false;
        try { quiet = !!owns(detail); } catch { /* an unreadable event is left to ComfyUI */ }
        if (!quiet) return dispatch.call(this, type, detail);
        const {errors, dialogs} = stores(app);
        const original = [];
        const replace = (store, name, make) => {
            if (typeof store?.[name] !== 'function') return;
            original.push([store, name, store[name]]);
            store[name] = make(store[name]);
        };
        replace(errors, 'showErrorOverlay', () => () => {});
        // ComfyUI's side panel and the node's red frame read the recorded error. The frame follows node_id, which
        // stays; the text becomes our written explanation, without the traceback (it carries local paths).
        replace(errors, 'recordExecutionError', keep => function (record, ...rest) {
            let written = '';
            try { written = describe ? String(describe(record) || '') : ''; } catch { /* keep ComfyUI's text */ }
            return keep.call(this, written ? {...record, exception_message: written, traceback: [], current_inputs: undefined, current_outputs: undefined} : record, ...rest);
        });
        replace(dialogs, 'showDialog', keep => function (options, ...rest) {
            return options?.key === DIALOG_KEY ? undefined : keep.call(this, options, ...rest);
        });
        try { return dispatch.call(this, type, detail); } finally {
            for (const [store, name, value] of original.reverse()) store[name] = value;
        }
    };
}
