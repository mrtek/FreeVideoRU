import { app } from '../../scripts/app.js';
import { openSetup } from './setup.js';
import { wordmark } from './wordmark.js';
import { createUpdateNotice, createVersionInfo } from './updates.js';
import { makeMovable } from './toolbar_position.js';
import { openEditorView } from './editor_loader.js';

import { t, isZh as cn, getLanguage, setLanguage } from './i18n.js';
const preference = 'freevideo.view';
let toolbar, open, selected, currentView = 'nodes';
const style = document.createElement('link');
style.rel = 'stylesheet'; style.href = new URL('./view_navigation.css', import.meta.url).href;
document.head.append(style);

export function preferredView() {
    try { return localStorage.getItem(preference); } catch { return null; }
}

export function viewChanged(view, node) {
    currentView = view;
    if (node) selected = node;
    try { localStorage.setItem(preference, view); } catch { /* Private browsing still works. */ }
    refreshNavigation();
}

export function viewSwitch(view, onStudio, onNodes, onEditor) {
    const group = document.createElement('div'); group.className = 'fv-view-switch';
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', t('FreeVideo view', 'FreeVideo 视图'));
    for (const [id, label, action] of [['studio', t('Create', '创作面板'), onStudio], ['nodes', t('Nodes', '节点视图'), onNodes], ['editor', t('Edit', '剪辑视图'), onEditor]]) {
        const button = document.createElement('button'); button.type = 'button';
        const text = document.createElement('span'); text.textContent = label; button.append(text);
        button.dataset.label = label; button.dataset.view = id;
        if (id === 'editor') button.dataset.fvGuide = 'longer';
        button.setAttribute('aria-pressed', String(view === id)); button.onclick = action;
        group.append(button);
    }
    return group;
}

export function refreshNavigation() {
    if (!toolbar) return;
    const nodes = (app.graph?._nodes || []).filter(n => n.comfyClass === 'FreeVideoGenerate' || n.type === 'FreeVideoGenerate');
    if (!nodes.includes(selected)) selected = nodes[0];
    toolbar.hidden = !selected || currentView !== 'nodes';
    for (const button of toolbar.querySelectorAll('[data-view]')) {
        button.setAttribute('aria-pressed', String(button.dataset.view === currentView));
    }
}

export function openCreativeWorkspace() {
    refreshNavigation();
    const focused = Object.values(app.canvas?.selected_nodes || {}).find(n => n.comfyClass === 'FreeVideoGenerate' || n.type === 'FreeVideoGenerate');
    const node = currentView === 'studio' ? selected : focused || selected;
    if (!node || !open) return false;
    open(node);
    return true;
}

export function installNavigation(openStudio) {
    open = openStudio;
    if (toolbar) { refreshNavigation(); return; }
    toolbar = document.createElement('aside'); toolbar.className = 'fv-view-navigation';
    toolbar.setAttribute('aria-label', t('FreeVideo workspace', 'FreeVideo 工作区'));
    const row = document.createElement('div'); row.className = 'fv-view-row';
    // The whole bar drags like a window; these dots say so on hover.
    const grip = document.createElement('span'); grip.className = 'fv-view-grip'; grip.setAttribute('aria-hidden', 'true');
    const brand = wordmark();
    const choose = action => {
        const focused = Object.values(app.canvas?.selected_nodes || {}).find(n => n.comfyClass === 'FreeVideoGenerate' || n.type === 'FreeVideoGenerate');
        refreshNavigation(); if (focused || selected) return action(focused || selected);
    };
    const langBtn = document.createElement('button'); langBtn.type = 'button';
    langBtn.textContent = getLanguage().toUpperCase(); langBtn.className = 'fv-view-settings fv-view-lang';
    langBtn.title = t('Switch language', '切换语言', 'Сменить язык');
    langBtn.onclick = () => {
        const next = getLanguage() === 'ru' ? 'en' : (getLanguage() === 'en' ? 'zh' : 'ru');
        setLanguage(next);
    };
    const settings = document.createElement('button'); settings.type = 'button';
    settings.textContent = t('Settings', '设置'); settings.className = 'fv-view-settings'; settings.onclick = openSetup;
    row.append(grip, brand, viewSwitch('nodes', openCreativeWorkspace, () => {}, () => choose(node =>
        openEditorView(node))), createVersionInfo(cn).element, langBtn, settings); toolbar.append(row);
    let shown = false;
    try { shown = localStorage.getItem('freevideo.view-guide') === '1'; } catch { /* Show once this session. */ }
    if (!shown) {
        const guide = document.createElement('div'); guide.className = 'fv-view-guide';
        const text = document.createElement('span');
        text.textContent = t('Switching views keeps the content of each view.', '切换视图时，各视图的内容都会保留。');
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = t('Got it', '知道了');
        dismiss.onclick = () => {
            try { localStorage.setItem('freevideo.view-guide', '1'); } catch {}
            // Fold the tip away rather than letting the toolbar jump.
            const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduce || typeof guide.animate !== 'function') { guide.remove(); return; }
            // The tip set the toolbar's width; contract the bar in the same motion.
            const before = toolbar.getBoundingClientRect().width;
            guide.style.display = 'none';
            const after = toolbar.getBoundingClientRect().width;
            guide.style.display = '';
            const height = guide.getBoundingClientRect().height;
            guide.style.overflow = 'hidden'; guide.style.whiteSpace = 'nowrap';
            const timing = {duration: 260, easing: 'cubic-bezier(.4,0,.2,1)'};
            if (Math.abs(before - after) > 1) toolbar.animate([{width: `${before}px`}, {width: `${after}px`}], timing);
            // The text is gone before the bar has narrowed enough to clip it.
            guide.animate([{opacity: 1, height: `${height}px`, marginTop: '10px'}, {opacity: 0, offset: .4},
                {opacity: 0, height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px'}],
            {...timing, fill: 'forwards'}).finished.then(() => guide.remove(), () => guide.remove());
        };
        guide.append(text, dismiss); toolbar.append(guide);
    }
    toolbar.append(createUpdateNotice(cn).element);
    document.body.append(toolbar); refreshNavigation();
    makeMovable(toolbar);
    // health.js asks for this before it reports the toolbar missing. A
    // workspace removed without closing must not keep the toolbar hidden.
    globalThis.window?.addEventListener('freevideo-navigation-refresh', () => {
        if (currentView !== 'nodes' && !document.querySelector('dialog.fv-studio[open]')) currentView = 'nodes';
        refreshNavigation();
    });
}
