// Keep this adapter independent of the editing module graph: even a parse or
// evaluation error in that graph must leave the current workspace usable.
import {app} from '../../scripts/app.js';

export async function openEditorView(node, options) {
    try {
        const entry = await import('./editor_entry.js');
        return entry.openEditorView(node, options);
    } catch (error) {
        console.warn('FreeVideo edit view:', error);
        const language = new URLSearchParams(location.search).get('freevideo_lang')
            || (typeof localStorage !== 'undefined' ? localStorage.getItem('freevideo_lang') : null);
        const ru = language === 'ru' || (language !== 'en' && language !== 'zh' && String(navigator.language || '').toLowerCase().startsWith('ru'));
        const cn = language === 'zh' || (language !== 'en' && !ru && String(navigator.language || '').toLowerCase().startsWith('zh'));
        const detail = ru ? 'Не удалось завершить. Попробуйте еще раз.' : (cn ? '没有完成，请重试' : 'Could not complete. Try again.');
        // The native modal is above the host's toast layer. Also use the
        // workspace's existing failure status so the message stays visible.
        const status = options?.studio?.querySelector('.fv-status');
        if (status) { status.dataset.error = 'true'; status.textContent = detail; }
        app.extensionManager?.toast?.add({severity: 'error', summary: 'FreeVideo', detail, life: 9000});
        options?.onFailure?.(error);
        // Do not retain a rejected promise. Each click tries import again;
        // browsers may still retain the failed module URL until a page reload.
        return null;
    }
}
