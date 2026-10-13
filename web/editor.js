import {createEditorText} from './editor_text.js';
import {isText} from './editor_text_model.js';
import {viewSwitch, viewChanged} from './view_navigation.js';
import {wordmark} from './wordmark.js';
import {openSetup} from './setup.js';
import * as model from './editor_model.js';
import {createEditorState} from './editor_state.js';
import {createEditorStore, sourceKey, mediaURL} from './editor_store.js';
import {generationSize} from './editor_generation.js';
import {createEditorLibrary} from './editor_library.js';
import {createEditorPlayer} from './editor_player.js';
import {createEditorTransport, registerEditorShortcuts} from './editor_transport.js';
import {createAdjustPanel} from './editor_adjust.js';
import {createAdjustPicture} from './editor_adjust_picture.js';
import {pictureSession} from './editor_picture_session.js';
import {createPictureTools} from './editor_frame.js';
import {openExportDialog} from './editor_export_dialog.js';
import {createAudioIntegration, handleAudioShortcut, AUDIO_SHORTCUTS} from './editor_audio.js';
import {createSpeedComponent, readSpeedAudioSamples, handleSpeedKey, speedShortcuts} from './editor_speed.js';
import {createEditorGenbar, loadEditorComponents, editorBlockStates, blockMessages} from './editor_genbar.js';
import {createProgressConnection} from './progress_connection.js';
import {createSelectionActions, deletionStatus, isMultiple, isTyping, playheadIds, removableGaps, removeGaps} from './editor_select.js';
import {isolateDialogKeys, topDialog} from './dialog_keys.js';
import {createBlockNotes, describedTrack} from './editor_notes.js';
const editorStyles = Promise.all(['editor.css', 'editor_tracks.css', 'editor_frame.css', 'editor_adjust.css', 'editor_adjust_picture.css', 'editor_preview_picture.css', 'editor_select.css', 'editor_menu.css', 'editor_text.css', 'editor_notes.css', 'editor_transport.css'].map(name => {
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL(name, import.meta.url).href;
    const ready = 'sheet' in style ? new Promise(resolve => { style.onload = style.onerror = resolve; }) : Promise.resolve();
    document.head.append(style); return ready;
}));
import { t, isZh as cn } from './i18n.js';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function restoreGeneration(record, before, prepared) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const entries = value => new Map(value.tracks.flatMap(track => track.clips.map(clip => [clip.id, {track: track.id, clip}])));
    const originals = entries(before), submitted = entries(prepared), current = entries(record), restore = new Map();
    const changed = new Set([...originals.keys(), ...submitted.keys()].filter(id => !same(originals.get(id), submitted.get(id))));
    for (const id of changed) if (same(current.get(id), submitted.get(id))) restore.set(id, originals.get(id));
    const next = {...record, tracks: record.tracks.map(track => ({...track, clips: [
        ...track.clips.filter(clip => !restore.has(clip.id)),
        ...[...restore.values()].filter(value => value?.track === track.id).map(value => value.clip),
    ].sort((a, b) => a.start - b.start)})).filter(track => track.clips.length || before.tracks.some(old => old.id === track.id) || !prepared.tracks.some(old => old.id === track.id))};
    for (const key of new Set([...Object.keys(before), ...Object.keys(prepared)])) {
        if (['tracks', 'id', 'revision', 'serial'].includes(key) || same(before[key], prepared[key]) || !same(record[key], prepared[key])) continue;
        if (Object.hasOwn(before, key)) next[key] = before[key]; else delete next[key];
    }
    return next;
}
const icon = path => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('fv-ed-glyph'); const line = document.createElementNS(svg.namespaceURI, 'path'); line.setAttribute('d', path); svg.append(line); return svg; };
function basicBlockProgress(clipId, clipElement) {
    const element = el('div', 'fv-ed-basic-progress'), water = el('div', 'fv-ed-basic-water'), percent = el('span', 'fv-ed-basic-percent');
    element.append(water, percent);
    let level = 0, run = null;
    return {element, update(value) {
        if (value.run && value.run !== run) { level = 0; run = value.run; }
        element.dataset.state = value.state;
        const fraction = level = value.state === 'waiting' ? 0 : Math.max(level, Math.max(0, Math.min(1, value.fraction || 0))); water.style.height = `${fraction * 100}%`;
        percent.textContent = `${Math.floor(fraction * 100 + 1e-8)}%`; percent.hidden = value.state !== 'generating' || clipElement.dataset.track !== 'v1' || clipElement.getBoundingClientRect().width < 44;
        water.hidden = value.state !== 'generating';
    }, dispose() { element.remove(); }};
}
let opened, lastDraft = null;
const editorViews = new Map(), viewPrefix = 'fv-editor-view:';

// A pending ComfyUI node listens on document, including above sibling dialogs
// and during native library drags. Suspend the canvas, preserving its placement
// state and handlers so returning to Nodes can finish the same gesture.
export function suspendCanvasPointer(canvas) {
    if (!canvas) return () => {};
    const saved = [];
    for (const name of ['processMouseMove', 'processMouseDown', 'processMouseUp', 'processMouseWheel', 'processMouseCancel']) {
        if (typeof canvas[name] !== 'function') continue;
        const descriptor = Object.getOwnPropertyDescriptor(canvas, name), blocked = () => {};
        saved.push({name, descriptor, blocked}); canvas[name] = blocked;
    }
    const pan = canvas._autoPan;
    pan?.stop();
    return () => {
        for (const {name, descriptor, blocked} of saved) if (canvas[name] === blocked) {
            if (descriptor) Object.defineProperty(canvas, name, descriptor);
            else delete canvas[name];
        }
        if (pan && canvas._autoPan === pan && canvas.state?.ghostNodeId != null) pan.start();
    };
}

// `components` replaces the optional progress module (see loadEditorComponents); tests also pass their generation stand-in here.
export function openEditor({api, app, from = null, panel = {}, components: given = undefined, onView = view => viewChanged(view)}) {
    if (opened) { opened.element.focus(); return opened; }
    const returnFocus = document.activeElement;
    const even = value => Math.max(2, Math.floor(value / 2) * 2);
    const initial = () => model.emptyProject({width: even(panel.width || 1344), height: even(panel.height || 768), settings: panel.settings || null,
        name: t('Untitled edit', '未命名剪辑')});
    const state = createEditorState(initial());
    const resumeCanvasPointer = suspendCanvasPointer(app?.canvas);
    const element = el('dialog', 'fv-studio fv-editor'); element.setAttribute('aria-label', t('Edit', '剪辑视图')); element.tabIndex = -1;
    const listeners = [];
    const listen = (type, handler) => { element.addEventListener(type, handler); listeners.push(() => element.removeEventListener(type, handler)); };
    // Keep editor mouse events from ComfyUI's document bubble handlers (ghost-node placement).
    for (const type of ['pointermove', 'mousemove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu'])
        listen(type, event => event.stopPropagation());
    const top = el('header', 'fv-header fv-ed-top'), libraryHost = el('aside', 'fv-ed-library'), preview = el('section', 'fv-ed-preview'),
        transport = el('div', 'fv-ed-transport'), genHost = el('div', 'fv-ed-genbar'), tracksHost = el('div', 'fv-ed-tracks'), zoomHost = el('div', 'fv-ed-zoom');
    const adjustHost = el('aside', 'fv-ed-adjust-host');
    const button = (label, action, cls = '') => { const value = el('button', cls, label); value.type = 'button'; value.onclick = action; return value; };
    const navigation = viewSwitch('editor', () => handle.switchView('studio'), () => handle.switchView('nodes'), () => {});
    for (const control of navigation.querySelectorAll('button')) control.removeAttribute('title');
    const brand = el('div', 'fv-brand');
    const headerActions = el('div', 'fv-header-actions');
    const title = button('', () => menu.hidden ? showMenu() : menu.hidden = true, 'fv-ed-name'); title.setAttribute('aria-haspopup', 'menu');
    const drawer = button(t('Media', '素材'), () => { libraryHost.dataset.open = libraryHost.dataset.open !== 'true'; drawer.setAttribute('aria-expanded', libraryHost.dataset.open); }, 'fv-ed-drawer-toggle');
    drawer.setAttribute('aria-expanded', 'false');
    const exportBox = el('div', 'fv-ed-export-box'), exportHint = el('span', 'fv-ed-export-hint'), exportButton = button(t('Export', '导出'), async () => {
        try {
            if (exportStatus?.state === 'done' && exportMatches()) { await actions.export(); return; }
            const options = await openExportDialog({parent: element, state, sources: store.sources, t, onError: error});
            if (options && !disposed) await actions.export(options);
        } catch (value) { error(value); }
    }, 'fv-primary');
    const exportCancel = button('', () => store.cancelExport(exportStatus.id).catch(error)); exportCancel.hidden = true; exportCancel.append(icon('m4 4 8 8M12 4l-8 8')); exportCancel.setAttribute('aria-label', t('Cancel', '取消'));
    exportBox.append(exportHint, exportButton, exportCancel); brand.append(wordmark(), title);
    headerActions.append(exportBox, button(t('Settings', '设置'), openSetup, 'fv-quiet'));
    top.append(brand, navigation, headerActions);
    const menu = el('div', 'fv-ed-name-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
    // Up and Down move through the name box and the items; Home and End go to either end.
    menu.onkeydown = event => {
        if (event.defaultPrevented || event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
            || (['Home', 'End'].includes(event.key) && event.target.matches('input'))) return;
        const items = [...menu.querySelectorAll('input, [role=menuitem], [role=menuitemradio]')].filter(node => !node.disabled && !node.closest('[hidden]'));
        if (!items.length) return;
        event.preventDefault(); event.stopPropagation();
        const at = items.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : at < 0 ? 0 : (at + step + items.length) % items.length].focus();
    };
    const saveWarning = el('span', 'fv-ed-save-warning'); saveWarning.hidden = true; saveWarning.setAttribute('role', 'status'); exportBox.prepend(saveWarning);
    const notice = el('div', 'fv-ed-notice'); notice.hidden = true; notice.setAttribute('role', 'status');
    transport.append(drawer);
    brand.append(menu);
    element.append(top, libraryHost, preview, transport, genHost, tracksHost, zoomHost, notice);
    element.append(adjustHost);
    tracksHost.inert = genHost.inert = true; title.disabled = true;
    // CSS delays the pending indication; fast opens stay at full opacity.
    tracksHost.classList.add('fv-ed-pending'); genHost.classList.add('fv-ed-pending');
    let discardOnSwitch = false, initialSelection = null, offerInitial = null;
    let viewKey = null, viewReady = false;
    let library = null, closing = false, closePromise = null, exportSnapshot = null, lastSeed = null, projectEpoch = 0;
    let disposed = false, suppressSave = false, savedContent = '', initializing = true, tracks = null, genbar = null, adjustPanel = null, exportStatus = null, pointerEditing = false, deferredStamp = null;
    let capability = {maxSeconds: 15, maxFollowSeconds: 15, maxRequestFrames: null, estimate: () => null}, generationBusy = false, switching = false, generationDone = null, finishGeneration = null;
    let noticeTimer = null, stopExport = null, mostRecentJob = null;
    const jobWatchers = new Map(), progress = new Map(), jobStatuses = new Map(), runProgress = new Map();
    let blockStates = null, progressObserver = null, progressConnection = null;
    function barJob(job) {
        const latest = [...runProgress.values()].filter(message => message.chain.id === job.id)
            .sort((a, b) => (a.received_at || 0) - (b.received_at || 0)).at(-1);
        return latest ? {...job, chainProgress: latest.chain} : job;
    }
    function paintJob(job) {
        const messages = blockMessages([...runProgress.values()].filter(message => message.chain.id === job.id),
            message => panel.progressSnapshot?.(message));
        const values = editorBlockStates(job, messages, blockStates);
        for (const block of job.blocks || []) {
            const clip = model.attemptClip(state.record, block.id); if (!clip || clip.job !== job.id) continue;
            const value = {...values[block.id], run: `${job.id}:${block.prompt_id || block.attempts || 0}`};
            for (const pair of model.pair(state.record, block.id)) { progress.set(pair.id, value); tracks?.setProgress(pair.id, value); }
        }
    }
    function receiveProgress(message) {
        if (disposed || !message.chain?.id || !message.chain.block) return false;
        const job = jobStatuses.get(message.chain.id);
        if (!job || String(job.node ?? panel.node?.id ?? panel.node ?? message.node) !== String(message.node)) return false;
        const block = job.blocks?.find(block => block.id === message.chain.block);
        if (!block || !model.attemptClip(state.record, block.id)) return false;
        const key = `${job.id}:${block.id}`, previous = runProgress.get(key);
        // A resumed attempt has a new prompt_id. Never replay the cancelled run.
        if (message.prompt_id && block.prompt_id && message.prompt_id !== block.prompt_id) return false;
        if (previous?.prompt_id === message.prompt_id && previous?.stream_id === message.stream_id
            && Number.isFinite(previous?.sequence) && previous.sequence >= message.sequence) return true;
        runProgress.set(key, message); paintJob(job);
        if (mostRecentJob === job.id) genbar?.update(barJob(job));
        return true;
    }
    const content = record => JSON.stringify({...record, id: null, revision: 0});
    function notify(text) { if (disposed) return; notice.textContent = text; notice.hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, 9000); }
    function error(value) {
        const code = value?.code || value?.message;
        if (['audio_prepare', 'speed_pending', 'speed_locked', 'speed'].includes(code)) return {ok: false, reason: code};
        if (code === 'unsupported') { genbar?.update(null); return; }
        if (code === 'chain_too_long') {
            const [en, zh] = (value.said || []).map(text => typeof text === 'string' && text ? text.slice(0, 200) : null);
            notify(t(en || 'This video can have up to 5 parts. Make it shorter.', zh || '这条视频最多 5 段，请缩短一些。'));
            return {ok: false, reason: code};
        }
        if (['busy', 'locked', 'text', 'audio_full', 'overlap', 'range'].includes(code)) {
            if (['locked', 'audio_full', 'overlap', 'range'].includes(code)) tracks?.flashBlocked?.(value.displayFrame);
            return {ok: false, reason: code};
        }
        notify(t('Could not complete. Try again.', '没有完成，请重试'));
    }
    const store = createEditorStore(api, {t, notify, standIn: given?.generationStandIn, onGenerationReady: ready => {
        if (disposed) return;
        generationAsked = true; genHost.hidden = !ready; element.dataset.generationReady = String(ready);
        settleGenbar(); if (ready) offerInitial?.();
        tracks?.refresh?.(); genbar?.update(mostRecentJob ? barJob(jobStatuses.get(mostRecentJob)) : null);
        updateTransport(); adjustPanel?.update();
    }});
    // Until the server has answered, the bar keeps its place but cannot be used.
    let generationAsked = store.generationAvailable, loaded = false;
    const settleGenbar = () => {
        const waiting = !loaded || !generationAsked;
        genHost.inert = waiting || !store.generationAvailable; genHost.classList.toggle('fv-ed-pending', waiting);
    };
    store.generationReady();
    const queue = store.createSaveQueue({get record() { return state.record; },
        adopt(value) {
            if (pointerEditing) { deferredStamp = value; return; }
            if (!value.nameSuffix && state.record.id === value.id && state.record.revision === value.revision) return;
            suppressSave = true; try { state.adopt(value); } finally { suppressSave = false; }
        },
    }, {onStatus: () => {
        if (!queue.dirty) { discardOnSwitch = false; saveWarning.hidden = true; }
    }});
    const player = createEditorPlayer(preview, transport, {state, sources: store.sources, api, t, error, readAudioSamples: panel.readAudioSamples || readSpeedAudioSamples, preservePreview: () => initializing, prepareAudio: () => !initializing});
    function selectionClips(selection = state.selection) {
        if (selection?.kind !== 'clip') return [];
        return state.record.tracks[0].clips.filter(clip => selection.ids.includes(clip.id) || selection.ids.includes(clip.link));
    }
    function selectionRange(selection = state.selection) {
        if (!selection) return null;
        if (selection.kind === 'range' || selection.kind === 'gap') return {start: selection.start, frames: selection.frames, ...(selection.parts ? {parts: selection.parts} : {})};
        const clips = selectionClips(selection); if (!clips.length) return null;
        const start = Math.min(...clips.map(clip => clip.start));
        return {start, frames: Math.max(...clips.map(clip => clip.start + clip.frames)) - start};
    }
    const jobActive = () => generationBusy || [...jobStatuses.values()].some(job => ['queued', 'running', 'cancelling'].includes(job.state));
    function completeSources() {
        return store.getSources(model.references(state.record).map(sourceKey)).then(() => { player.refresh(); tracks?.refresh?.(); });
    }
    const exportMatches = () => exportSnapshot && exportSnapshot.id === state.record.id && exportSnapshot.revision === state.record.revision && exportSnapshot.content === content(state.record);
    function updateTop() {
        title.replaceChildren(el('span', '', state.record.name || new Date().toLocaleDateString()), icon('m4 6 4 4 4-4')); title.title = state.record.name;
        exportButton.classList.toggle('fv-primary', !!model.exportFrames(state.record) && !state.selection && !jobActive() && !exportStatus);
        if (exportStatus?.state === 'done') exportButton.textContent = exportMatches() ? t('View', '查看') : t('Export', '导出');
        exportButton.disabled = initializing || !model.exportFrames(state.record) || switching || ['running', 'queued'].includes(exportStatus?.state);
        exportButton.title = '';
    }
    async function snapshot() {
        let value = panel.snapshot ? structuredClone(await panel.snapshot()) : structuredClone(await app.graphToPrompt());
        if (value.output) {
            const node = String(panel.node?.id || panel.node || Object.keys(value.output).find(id => value.output[id].class_type === 'FreeVideoGenerate') || '');
            value = {node, prompt: value.output, extra_data: {extra_pnginfo: {workflow: value.workflow || {}}}};
        }
        if (!value.node || !value.prompt?.[value.node]) throw new Error('missing_node');
        const inputs = value.prompt[value.node].inputs;
        Object.assign(inputs, state.record.settings || {}, capability.generationSize || generationSize(state.record));
        // Tonight's new content uses text. References remain in the creative panel.
        delete inputs.media; delete inputs.continue_from; delete inputs.continue_to;
        return {node: String(value.node), prompt: value.prompt, ...(value.extra_data ? {extra_data: value.extra_data} : {}), ...(api.clientId ? {client_id: api.clientId} : {})};
    }
    function pinStoppedJob(record, ids, job) {
        return model.settle(record, ids.filter(id => model.attemptClip(record, id)?.job === job), 'stopped');
    }
    async function deliverChain(job) {
        if (disposed || !job) return false;
        const previous = jobStatuses.get(job.id);
        if (Number.isFinite(previous?.updated) && job.updated < previous.updated)
            return ['queued', 'running', 'cancelling'].includes(previous.state);
        mostRecentJob = job.id; jobStatuses.set(job.id, job); paintJob(job);
        const completed = new Set();
        for (const block of job.blocks || []) {
            const clip = model.attemptClip(state.record, block.id); if (!clip || clip.job !== job.id) continue;
            if (block.state === 'done' && block.output) {
                if (['queued', 'running'].includes(clip.pending) || !previous?.blocks?.some(old => old.state === 'done' && old.output === block.output))
                    completed.add(block.output);
                const source = {kind: 'generated', id: block.output};
                await store.getSources([sourceKey(source)]); if (disposed) return false;
                if (model.attemptClip(state.record, block.id)?.job !== job.id) continue;
                const metadata = store.sources.get(sourceKey(source));
                const result = {job: job.id, source, frames: metadata?.frames || block.inputs?.frames,
                    width: metadata?.width, height: metadata?.height,
                    skip_frames: block.skip_frames || 0, skip_audio_samples: block.skip_audio_samples || 0};
                try {
                    if (!metadata || metadata.missing) throw new model.EditError('source');
                    // settle intentionally skips incompatible undo snapshots.
                    // Validate the current clip first so a bad receipt is visible.
                    model.fill(state.record, block.id, result);
                    state.settle(record => model.fill(record, block.id, result));
                } catch (value) {
                    if (!(value instanceof model.EditError)) throw value;
                    state.settle(record => model.fail(record, block.id, 'result_mismatch', job.id));
                    error(value);
                }
            } else if (block.state === 'failed') {
                const reason = /^[a-z_]{1,80}$/.test(block.error || '') ? block.error : 'generation_failed';
                state.settle(record => model.fail(record, block.id, reason, job.id));
            } else if (['cancelled', 'interrupted'].includes(block.state) || (['cancelled', 'interrupted', 'failed'].includes(job.state) && block.state === 'pending')) {
                state.settle(record => pinStoppedJob(record, [block.id], job.id));
            } else if (block.state === 'running' && clip.pending !== 'running') state.settle(record => model.settle(record, [block.id], 'running'));
        }
        genbar?.update(barJob(job)); updateTop(); updateTransport();
        const active = ['queued', 'running', 'cancelling'].includes(job.state);
        if (completed.size || (!active && previous?.state !== job.state) || (job.output && job.output !== previous?.output))
            library?.refresh({outputs: job.output ? [job.output] : [...completed]});
        if (!active) jobWatchers.delete(job.id);
        return active;
    }
    function watchJob(id) {
        if (disposed) return;
        if (!jobWatchers.has(id)) jobWatchers.set(id, store.watchChain(id, deliverChain));
    }
    function recoverJobs() {
        for (const id of new Set(state.record.tracks[0].clips.map(clip => clip.job).filter(Boolean))) watchJob(id);
    }
    function rememberView() {
        if (!viewReady) return;
        const key = state.record.id || viewKey;
        const value = {selection: state.selection, text: genbar.getText(), playhead: state.playhead,
            zoom: state.zoom, scrollLeft: tracks?.getScrollLeft() || 0};
        editorViews.set(key, value);
        try {
            localStorage.setItem(viewPrefix + key, JSON.stringify({selection: value.selection, text: value.text}));
            if (state.record.id) localStorage.setItem('fv-editor-last', key);
        } catch {}
        // An untouched edit belongs to this tab until it has a saved identity.
        lastDraft = !state.record.id && state.record.tracks.every(track => !track.clips.length) ? key : null;
        try {
            if (lastDraft) globalThis.sessionStorage?.setItem('fv-editor-draft', lastDraft);
            else globalThis.sessionStorage?.removeItem('fv-editor-draft');
        } catch {}
    }
    async function replaceProject(record, key = null) {
        rememberView(); viewReady = false;
        viewKey = record.id || key || 'draft:' + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
        let remembered = editorViews.get(viewKey);
        if (!remembered) try { remembered = JSON.parse(localStorage.getItem(viewPrefix + viewKey)); } catch {}
        initialSelection = offerInitial = null;
        projectEpoch++;
        player.pause(); for (const stop of jobWatchers.values()) stop(); jobWatchers.clear(); jobStatuses.clear(); progress.clear(); runProgress.clear(); progressConnection?.reset();
        mostRecentJob = null; genbar?.update(null); queue.reset(record); stopExport?.(); stopExport = null; exportStatus = exportSnapshot = null; exportButton.textContent = t('Export', '导出');
        suppressSave = true; try { state.replace(record); savedContent = content(record); } finally { suppressSave = false; }
        const width = tracksHost.clientWidth - 148; if (width > 0) state.setZoom(width / 90);
        tracks?.setScrollLeft(0);
        // An empty edit opens with one part's length selected at the start, ready to generate.
        const selectInitial = () => { if (!store.generationAvailable) return; initialSelection = state.select({kind: 'range', start: 0,
            frames: Math.round(Math.min(15, capability.maxSeconds ?? 15) * model.FPS), tracks: ['v1', 'a1']}); };
        const epoch = projectEpoch;
        let pointer = null;
        const rememberPointer = event => { if (event.isTrusted) pointer = event; };
        // Once the pointer has left the tracks there is no hint to refresh there.
        const leftTracks = () => { pointer = null; };
        tracksHost.addEventListener('pointermove', rememberPointer, true); tracksHost.addEventListener('pointerleave', leftTracks);
        const forgetPointer = () => { tracksHost.removeEventListener('pointermove', rememberPointer, true); tracksHost.removeEventListener('pointerleave', leftTracks); };
        listeners.push(forgetPointer);
        // Explicit parts are the existing persisted marker for manual borders.
        // Keep them even if a later response lowers the limit; maxRequestFrames
        // still checks the real request before submission.
        const keepManualParts = value => ({...value,
            get maxSeconds() { return Math.max(value.maxSeconds, (state.selection?.parts?.[0] || 0) / model.FPS); },
            get maxFollowSeconds() { return Math.max(value.maxFollowSeconds, ...((state.selection?.parts || []).map(count => count / model.FPS))); }});
        capability = keepManualParts(store.capabilities(record, value => {
            if (disposed || epoch !== projectEpoch) return;
            capability = keepManualParts(value); tracks?.refresh?.();
            pictureTools.update();
            if (initialSelection && state.selection === initialSelection) selectInitial();
            genbar?.update(mostRecentJob ? barJob(jobStatuses.get(mostRecentJob)) : null);
            // Refresh the active gesture's existing hint through the track pointer handler.
            if (pointer) tracks?.element.dispatchEvent(new PointerEvent('pointermove', {pointerId: pointer.pointerId,
                clientX: pointer.clientX, clientY: pointer.clientY, buttons: pointer.buttons, bubbles: true}));
            forgetPointer();
        })); if (disposed) return;
        // A restored edit remains usable offline with its existing placeholders.
        await completeSources().catch(error); if (disposed) return; recoverJobs();
        state.restoreView(remembered);
        // Also when generating is confirmed only after the edit has opened.
        offerInitial = () => { if (epoch === projectEpoch && !state.selection && state.record.tracks.every(track => !track.clips.length)) selectInitial(); };
        offerInitial();
        genbar?.setText(typeof remembered?.text === 'string' ? remembered.text : '');
        tracks?.setScrollLeft(remembered?.scrollLeft);
        viewReady = true; updateTransport();
    }
    async function switchProject(id) {
        if (switching) return; switching = true; updateTop();
        try {
            await queue.flush();
            if (queue.dirty) { return; }
            const record = id ? await store.load(id) : initial();
            if (!disposed && record) { await replaceProject(record); if (!id) { queue.enqueue(state.record); } menu.hidden = true; }
        } catch (value) { error(value); }
        finally { switching = false; updateTop(); }
    }
    async function showMenu() {
        menu.replaceChildren(); menu.hidden = false; title.setAttribute('aria-expanded', 'true');
        const name = el('input', 'fv-ed-rename'); name.value = state.record.name; name.setAttribute('aria-label', t('Edit name', '修改名字'));
        const commit = () => { if (name.value.trim()) state.apply(t('Rename', '改名'), record => model.rename(record, name.value.trim())); };
        name.onchange = commit; name.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault(); commit(); menu.hidden = true; title.setAttribute('aria-expanded', 'false'); title.focus();
        } };
        const fresh = button(t('New', '新建'), () => switchProject(null)); fresh.setAttribute('role', 'menuitem');
        menu.append(name, fresh);
        pictureTools.appendMenu(menu);
        try {
            // The current edit is already named in the box at the top.
            const rows = (await store.projects()).filter(row => row.id !== state.record.id); if (disposed || menu.hidden) return;
            if (rows.length) { const line = el('div'); line.setAttribute('role', 'separator'); menu.append(line); }
            for (const row of rows) { const item = button(row.name || new Date(row.updated_at).toLocaleDateString(), () => switchProject(row.id), 'fv-ed-project'); item.setAttribute('role', 'menuitem'); item.title = item.textContent; menu.append(item); }
        } catch (value) { error(value); }
        name.focus(); name.select();
    }
    const actions = {
        error, editError: error, notify, sources: store.sources, waveform: key => store.waveform(key), mediaURL: value => mediaURL(api, value),
        togglePlay: () => player.toggle(),
        pause: () => player.pause(),
        async previewSource(source) {
            if (closing || disposed) return;
            const cached = store.sources.get(sourceKey(source));
            if (!initializing || (!cached?.video && !cached?.audio)) await store.getSources([sourceKey(source)]);
            if (!closing && !disposed) player.previewSource(source);
        },
        generationLimits: () => ({maxSeconds: capability.maxSeconds, maxFollowSeconds: capability.maxFollowSeconds}),
        generationAvailable: () => store.generationAvailable,
        gestureStart({selectionGesture = false} = {}) {
            pointerEditing = true;
            if (selectionGesture && !menu.hidden) { menu.hidden = true; updateTransport(); }
        },
        gestureEnd() { releaseStamp(); },
        insertSource(value, {loadMetadata = false} = {}) {
            // Early library double-clicks/Enter must target the restored edit.
            if (initializing) return handle.ready.then(() => {
                if (!initializing && !closing && !disposed) return actions.insertSource(value, {loadMetadata});
            });
            if (loadMetadata) {
                const epoch = projectEpoch;
                return store.getSources([sourceKey(value.source)]).then(() => {
                    if (!closing && !disposed && epoch === projectEpoch) return actions.insertSource(value);
                });
            }
            const metadata = store.sources.get(sourceKey(value.source));
            try { state.apply(t('Insert source', '放入素材'), record => model.insertSource(record, {
                ...value, width: metadata?.width ?? value.width, height: metadata?.height ?? value.height,
                at: value.at ?? model.duration(record)}), {clearRange: state.selection !== initialSelection});
                return {ok: true};
            } catch (valueError) {
                if (!(valueError instanceof model.EditError)) throw valueError;
                valueError.displayFrame = value.at ?? model.duration(state.record); error(valueError);
                return {ok: false, reason: valueError.code};
            }
        },
        reasonText: code => code === 'gpu_memory' ? t('Not enough graphics memory', '显存不够') : t('Could not generate', '没能生成'),
        supportedSelection() {
            if (state.selection?.kind === 'clip' && state.selection.ids.some(id => isText(model.find(state.record, id)))) return false;
            const range = selectionRange(); if (!range) return false;
            if (state.selection.kind === 'range' && !['v1', 'a1'].every(id => state.selection.tracks.includes(id))) return false;
            if (state.selection.kind === 'gap' && state.selection.track !== 'v1') return false;
            try {
                const selected = selectionClips();
                if (selected.length && selected.every(clip => clip.pending && !clip.source))
                    model.prepare(state.record, selected.map(clip => clip.id));
                else model.planRange(state.record, {...range, target: 'both'});
                return true;
            }
            catch (value) { if (value instanceof model.EditError) return value.code === 'busy'; throw value; }
        },
        canGenerate(text) {
            if (!store.generationAvailable || !actions.supportedSelection() || jobActive()) return false;
            const range = selectionRange();
            // Only a part pulled out of a finished one needs no description: it continues that one.
            const head = state.record.tracks[0].clips.find(clip => clip.start === range.start);
            const before = !!head && model.continuesBefore(state.record, head.id) && state.record.tracks[0].clips.some(clip =>
                clip.start + clip.frames === range.start && clip.source && clip.extend && clip.in + clip.frames === clip.length);
            return !!text.trim() || before;
        },
        // Only where earlier footage is continued: a part right after an extendable clip, or a range split into several parts.
        firstFrameVisible() {
            if (!store.generationAvailable || !actions.supportedSelection()) return false;
            const range = selectionRange(); if (!range) return false;
            const head = state.record.tracks[0].clips.find(clip => clip.start === range.start);
            const before = !!head && model.continuesBefore(state.record, head.id) && state.record.tracks[0].clips.some(clip =>
                clip.start + clip.frames === range.start && clip.source && clip.extend && clip.in + clip.frames === clip.length);
            return before || model.rangeParts(state.record, {...range, ...capability}).length > 1;
        },
        setFirstFrame: value => { state.apply(t('First-frame reference', '首帧参考'), record => model.setFlag(record, 'first_frame_reference', value)); },
        previewRange: selection => genbar?.preview(selection),
        async estimate(selection) {
            const range = selectionRange(selection); if (!range) return null;
            let seconds = 0;
            for (const count of model.rangeParts(state.record, {...range, ...capability})) { const value = capability.estimate(count); if (value == null) return null; seconds += value; }
            return seconds;
        },
        async generate({target = 'both', text = '', label = t('Generate', '生成')} = {}) {
            if (target !== 'both' || !actions.supportedSelection()) throw new model.EditError('unsupported');
            if (!actions.canGenerate(text)) throw new model.EditError('text');
            generationBusy = true; updateTop(); updateTransport();
            generationDone = new Promise(resolve => { finishGeneration = resolve; });
            let ids = [], prepared = null, beforeAttempt = null, priorSelection = null, priorText = null, submittedSelection = null;
            const epoch = projectEpoch, range = selectionRange(), selectedIds = selectionClips().map(clip => clip.id);
            try {
                const frozen = await snapshot(); if (epoch !== projectEpoch || closing || disposed || !store.generationAvailable) return;
                beforeAttempt = state.record; priorSelection = state.selection; priorText = state.rangeText;
                state.apply(label, record => {
                    const selected = selectedIds.map(id => model.find(record, id)).filter(Boolean), alreadyPlanned = selected.length && selected.every(clip => !clip.source && clip.pending && !['queued', 'running'].includes(clip.pending));
                    let next = alreadyPlanned ? model.startAttempt(record, selected.map(clip => clip.id), text) : model.planRange(record, {...range, target: 'both', text, maxSeconds: capability.maxSeconds, maxFollowSeconds: capability.maxFollowSeconds});
                    if (!record.tracks[0].clips.length && text.trim()) next = model.rename(next, model.truncateText(text.trim(), 40));
                    ids = next.tracks[0].clips.filter(clip => clip.start >= range.start && clip.start < range.start + range.frames && clip.pending && !['queued', 'running'].includes(clip.pending)).map(clip => clip.id);
                    return model.prepare(next, ids);
                }, {checkpoint: true});
                prepared = state.record;
                submittedSelection = state.select({kind: 'clip', ids}); await completeSources();
                const paths = Object.fromEntries([...store.sources].map(([key, value]) => [key, value.path]));
                const request = model.generationRequest(prepared, ids, {text, paths});
                const tooLong = request.blocks.filter(block => capability.maxRequestFrames != null && block.frames > capability.maxRequestFrames);
                if (tooLong.length) {
                    state.settle(record => tooLong.reduce((next, block) => model.fail(next, block.id, 'too_long', null), record));
                    return;
                }
                const values = new Uint32Array(1);
                if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(values); else values[0] = Math.floor(Math.random() * 2 ** 32);
                const seed = values[0] === lastSeed ? (values[0] + 1) >>> 0 : values[0]; lastSeed = seed;
                const blocks = request.blocks.map(({before, ...block}, i) => ({...block, seed: seed + i}));
                const job = await store.startChain({...frozen, blocks});
                if (!job && !store.generationAvailable) {
                    if (epoch === projectEpoch) {
                        const restoreSelection = state.selection === submittedSelection;
                        // Reverse only this submission's changes. Keep save receipts,
                        // reserved IDs and unrelated edits made while POST was pending.
                        state.settle(record => restoreGeneration(record, beforeAttempt, prepared));
                        if (restoreSelection) state.select(priorSelection, {text: priorText});
                    }
                    return;
                }
                if (!job?.id) throw new Error('chain_missing');
                if (epoch !== projectEpoch) return;
                state.settle(record => model.assignJob(record, ids, job.id, {prepared}));
                queue.enqueue(state.record);
                mostRecentJob = job.id; jobStatuses.set(job.id, job); genbar.update(job); watchJob(job.id);
            } catch (value) {
                if (ids.length && epoch === projectEpoch) state.settle(record => model.settle(record, ids, 'draft'));
                throw value;
            } finally { if (disposed && ids.length) queue.enqueue(state.record); generationBusy = false; finishGeneration?.(); generationDone = null; finishGeneration = null; updateTop(); updateTransport(); }
        },
        async cancel() { const id = mostRecentJob; if (id) await deliverChain(await store.chainAction(id, 'cancel')); },
        async resume() {
            if (!store.generationAvailable) return;
            const epoch = projectEpoch;
            const id = mostRecentJob || selectionClips().find(clip => clip.job)?.job; if (!id) return;
            const job = await store.chainAction(id, 'resume'); if (epoch !== projectEpoch || disposed) return;
            for (const block of job?.blocks || []) if (block.state !== 'done') runProgress.delete(`${id}:${block.id}`);
            const ids = state.record.tracks[0].clips.filter(clip => clip.job === id && clip.pending).map(clip => clip.id);
            state.settle(record => model.settle(record, ids, 'queued')); if (job) { await deliverChain(job); watchJob(id); }
        },
        async retry(id) { if (!store.generationAvailable) return; state.select({kind: 'clip', ids: [id]}); const clip = model.find(state.record, id); if (clip.job) { mostRecentJob = clip.job; await actions.resume(); } else await actions.generate({text: clip.text || panel.text || ''}); },
        // Subtitles from speech hear the saved project, so it is saved first; a project never saved has nothing in it to hear.
        speech: {
            async start() {
                await queue.flush();
                if (queue.dirty) return null;
                if (!state.record.id) return {state: 'failed', reason: 'no_sound'};
                for (let attempt = 0; ; attempt++) {
                    try { return await store.startEars(state.record.id, state.record.revision); }
                    catch (value) {
                        if (value.status !== 409 || attempt >= 2) throw value;
                        queue.enqueue(state.record); await queue.flush();
                        if (queue.dirty) return null;
                    }
                }
            },
            watch: (id, fn) => store.watchEars(id, fn),
            cancel: id => store.cancelEars(id),
            // Whether speech can be recognised here now, and how many bytes must be downloaded first.
            async ability() {
                const [ears, pack] = await Promise.all([store.ears(), store.earsPack().catch(() => null)]);
                return {available: ears?.transcribe === true, need: pack?.installable === true && pack.bytes > 0 ? pack.bytes : 0};
            },
            download: report => new Promise((resolve, reject) => {
                const step = value => {
                    const install = value?.install;
                    if (install?.state !== 'running') { resolve(install?.state === 'done'); return false; }
                    report(install.total > 0 ? install.done / install.total : 0); return true;
                };
                store.installEars().then(value => { if (step(value)) store.watchEarsPack(step); }, reject);
            }),
            cancelDownload: () => store.cancelEarsPack(),
        },
        async export(options) {
            if (['running', 'queued'].includes(exportStatus?.state)) return;
            if (exportStatus?.state === 'done' && exportMatches()) { await viewExport(exportStatus); return; }
            if (!await textTools.beforeExport()) return;
            await queue.flush();
            if (queue.dirty) { return; }
            if (!state.record.id) return;
            exportSnapshot = {id: state.record.id, revision: state.record.revision, content: content(state.record)};
            for (let attempt = 0; ; attempt++) {
                try { exportStatus = await store.export(state.record.id, state.record.revision, options); break; }
                catch (value) {
                    if (value.status !== 409 || attempt >= 2) throw value;
                    queue.enqueue(state.record); await queue.flush();
                    if (queue.dirty) return;
                    exportSnapshot = {id: state.record.id, revision: state.record.revision, content: content(state.record)};
                }
            }
            if (!exportStatus) return;
            updateExport(exportStatus); stopExport?.();
            stopExport = store.watchExport(exportStatus.id, updateExport);
        },
    };
    async function viewExport(value) {
        // A sound-only export is not a work: it opens as a file the browser plays and can save.
        if (value.only === 'sound') { if (value.url) window.open(mediaURL(api, value.url), '_blank', 'noopener'); return; }
        const module = await import('./library.js');
        module.openLibrary(t, {selectedWork: value.work, extend: async record => {
            if (await handle.close() === false) throw new Error(saveWarning.textContent);
            await onView('studio');
            return (await import('./studio.js')).extendVideo(record);
        }});
    }
    function updateExport(value) {
        if (!value) return false;
        if (exportSnapshot) exportSnapshot = {...exportSnapshot, id: value.project_id, revision: value.revision};
        exportStatus = value; const running = value.state === 'running' || value.state === 'queued';
        if (disposed) { if (!running) window.FreeVideoNotifyTaskDone?.({kind: 'export', id: value.id, ok: value.state === 'done'}); return running; }
        exportButton.textContent = running ? t(`Export ${Math.round(value.fraction * 100)}%`, `导出 ${Math.round(value.fraction * 100)}%`) : value.state === 'done' && exportMatches() ? t('View', '查看') : t('Export', '导出');
        exportCancel.hidden = !running; exportButton.disabled = running; exportButton.classList.remove('fv-primary');
        if (!running) {
            if (value.state === 'failed') notify(t('Export did not finish', '导出没有完成'));
            window.FreeVideoNotifyTaskDone?.({kind: 'export', id: value.id, ok: value.state === 'done'});
        }
        return running;
    }

    genbar = createEditorGenbar(genHost, {state, t, actions, text: ''});
    const adjust = adjustPanel = createAdjustPanel(adjustHost, {state, t, actions});
    const pictureEdit = pictureSession(state, t);
    const notes = createBlockNotes({state, t, actions}); actions.blockNote = notes.decorate; actions.describedTrack = describedTrack;
    adjust.register('video', createAdjustPicture({state, sources: store.sources, t, player, notes}));
    const toolbar = el('div', 'fv-ed-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', t('Track tools', '轨道工具')); toolbar.inert = true; toolbar.classList.add('fv-ed-pending');
    const historyTools = el('div', 'fv-ed-tool-group'), editTools = el('div', 'fv-ed-tool-group');
    const toolButton = (label, path, action, cls, iconOnly = false) => {
        const control = button('', action, cls); control.append(icon(path));
        control.classList.add('fv-ed-icon');
        control.setAttribute('aria-label', label); return control;
    };
    const toolUndo = toolButton(t('Undo', '撤销'), 'M5 4 2 7l3 3M2 7h7a4 4 0 0 1 0 8', () => state.undo(), 'fv-ed-undo fv-ed-icon', true);
    const toolRedo = toolButton(t('Redo', '重做'), 'm11 4 3 3-3 3M14 7H7a4 4 0 0 0 0 8', () => state.redo(), 'fv-ed-redo fv-ed-icon', true);
    const split = toolButton(t('Split', '剪开'), 'M6 5l8 8M6 11l8-8M6 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
        () => selectionActions.run('b'), 'fv-ed-split');
    const remove = toolButton(t('Delete', '删除'), 'M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 6v5M9 6v5',
        () => selectionActions.run('delete'), 'fv-ed-delete');
    const closeGap = toolButton(t('Remove gaps', '移除空隙'), 'M1 3v10M15 3v10M3 8h4m-2-2 2 2-2 2M13 8H9m2-2-2 2 2 2',
        () => selectionActions.run('gaps'), 'fv-ed-close-gap');
    const previous = toolButton(t('Previous version', '上一版'), 'M3 6V2M3 6h4M3 6a5 5 0 1 1-1 5M8 5v3l2 2', () => {
        const clip = selectedContent().find(clip => clip.versions.length);
        if (clip) try { state.apply(t('Previous version', '上一版'), record => model.restoreVersion(record, clip.id, 0)); } catch (value) { error(value); }
    }, 'fv-ed-previous');
    historyTools.append(toolUndo, toolRedo); editTools.append(split, remove, closeGap, previous);
    const pictureTools = createPictureTools({state, sources: store.sources, t, capabilities: () => capability, error});
    toolbar.append(historyTools, editTools, zoomHost); element.insertBefore(toolbar, tracksHost);
    const transportControls = createEditorTransport({element, preview, transport, toolbar, editTools, zoomHost, state, player, t, notify});
    toolbar.append(adjust.toggleButton);
    const textTools = createEditorText({element, state, t, actions, adjust, player, toolbar, exportBox, tracksHost});
    actions.speech.ability().then(value => { if (!disposed) textTools.speech(value); }).catch(() => {});
    const audio = createAudioIntegration({state, player, t, error, adjust, library: libraryHost, store});
    registerEditorShortcuts(AUDIO_SHORTCUTS, speedShortcuts);
    adjust.register('speed', createSpeedComponent({state, t, onError: error}));
    function selectedContent() {
        const selection = state.selection;
        if (!selection) return [];
        if (selection.kind === 'clip') return state.record.tracks.flatMap(track => track.clips).filter(clip => selection.ids.includes(clip.id));
        return state.record.tracks.filter(track => selection.tracks?.includes(track.id) || track.id === selection.track).flatMap(track => track.clips)
            .filter(clip => clip.start >= selection.start && clip.start + clip.frames <= selection.start + selection.frames);
    }
    const isBusy = clip => ['queued', 'running'].includes(clip.pending);
    function splitIds() {
        return playheadIds(state.record, state.selection, state.playhead).filter(id => {
            const clip = model.find(state.record, id); return state.playhead > clip.start && state.playhead < clip.start + clip.frames;
        });
    }
    const modifier = /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? '⌘' : 'Ctrl';
    function updateSplit() {
        const ids = splitIds(); split.disabled = !ids.length || ids.some(id => model.pair(state.record, id).some(isBusy));
        split.title = t('Split', '剪开') + ` ${modifier}+B`;
    }
    function updateZoom() {
        const zoomBar = zoomHost.querySelector('.fv-ed-track-zoom'), slider = zoomBar?.querySelector('input');
        if (slider) {
            const controls = zoomBar.querySelectorAll('button');
            controls[0].disabled = state.zoom <= Number(slider.min); controls[1].disabled = state.zoom >= Number(slider.max);
            controls[2].disabled = !model.duration(state.record) && state.selection?.kind !== 'range';
            controls[0].title = '';
            controls[1].title = '';
            controls[2].title = t('Fit all', '看全部');
        }
    }
    function updateTransport() {
        const clips = selectedContent(), busy = clips.some(isBusy);
        toolUndo.disabled = !state.canUndo; toolRedo.disabled = !state.canRedo;
        toolUndo.title = t('Undo', '撤销') + ` ${modifier}+Z`;
        toolRedo.title = t('Redo', '重做') + ` ${modifier}+Shift+Z`;
        updateSplit();
        remove.disabled = !deletionStatus(state.record, state.selection).ok;
        remove.title = t('Delete Delete', '删除 Delete');
        const gaps = removableGaps(state.record, state.selection); closeGap.disabled = !gaps.length || !removeGaps(state.record, state.selection).removed;
        closeGap.title = t('Remove gaps Delete', '移除空隙 Delete');
        const multiple = isMultiple(state.record, clips.map(clip => clip.id));
        previous.disabled = busy || multiple || !clips.some(clip => clip.versions.length);
        previous.title = t('Previous version', '上一版');
        updateZoom();
    }
    updateTransport();
    const stopSources = store.subscribeSources(() => { player.refresh(); tracks?.refresh?.(); pictureTools.update(); updateTop(); });
    let capabilitySize = `${state.record.width}x${state.record.height}`;
    const unsubscribe = state.subscribe(event => {
        if (event.type === 'record') {
            const size = `${state.record.width}x${state.record.height}`;
            if (!initializing && size !== capabilitySize) {
                capabilitySize = size;
                capability = store.capabilities(state.record, value => {
                    capability = value; pictureTools.update(); tracks?.refresh?.(); genbar?.update(null);
                });
            }
            if (initialSelection && state.selection === initialSelection && state.record.tracks.some(track => track.clips.some(clip => clip.source))) state.select(null);
            const next = content(state.record);
            if (!suppressSave && !initializing && next !== savedContent && exportStatus?.state === 'done') { exportStatus = null; exportButton.textContent = t('Export', '导出'); }
            if (!suppressSave && !initializing && next !== savedContent) { savedContent = next; queue.enqueue(state.record); }
            completeSources().catch(error); recoverJobs();
        }
        if (event.type === 'selection') { if (state.selection !== initialSelection) initialSelection = null; }
        if (event.type === 'record' || event.type === 'selection') { updateTop(); updateTransport(); pictureTools.update(); }
        else if (event.type === 'playhead') updateSplit();
        else if (event.type === 'zoom') updateZoom();
    });
    function dismissPopup(event) {
        if (tracks?.menu.dismiss(event)) return true;
        if (tracks?.dismissPopup(event)) return true;
        if (pictureEdit.keyboard(event)) return true;
        if (adjust.dismiss(event)) return true;
        if (menu.hidden) return false;
        event.preventDefault(); event.stopPropagation();
        if (!menu.hidden) { menu.hidden = true; title.setAttribute('aria-expanded', 'false'); title.focus(); }
        return true;
    }
    const selectionActions = createSelectionActions({state, t, actions});
    actions.editSelection = key => selectionActions.run(key);
    actions.setSnapping = enabled => tracks.setSnapping(enabled);
    actions.seekPlayhead = frame => tracks.seekPlayhead(frame);
    function keyboard(event) {
        if (event.isComposing || event.keyCode === 229) return;
        if (!initializing && textTools.keyboard(event)) return;
        if (pictureEdit.keyboard(event)) return;
        if (event.key.toLowerCase() === 'escape' && dismissPopup(event)) return;
        if (event.target.closest('.fv-ed-adjust') && event.key.toLowerCase() !== 'escape'
            && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')) return;
        // Track gestures have their own keyboard handler (including Escape rollback).
        if (event.target.closest('.fv-ed-tracks')) return;
        event.stopPropagation();
        const typing = isTyping(event.target) && !(event.target.type === 'range' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z');
        const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
        if (key === 'escape') { event.preventDefault(); state.select(null, {history: true}); menu.hidden = true; libraryHost.dataset.open = 'false'; return; }
        if (typing || initializing) return;
        if (selectionActions.keyboard(event)) return;
        if (!mod && !event.altKey && (key === 'arrowup' || key === 'arrowdown' || (key === 'z' && event.shiftKey))) { tracks?.keyboard(event); return; }
        if (handleSpeedKey(event)) return;
        if (key === ' ') { event.preventDefault(); player.toggle(); }
        else if (key === 'arrowleft' || key === 'arrowright') { event.preventDefault(); state.seek(Math.max(0, state.playhead + (key === 'arrowright' ? 1 : -1))); }
        else if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? state.redo() : state.undo(); }
    }
    listen('keydown', keyboard); listen('keyup', event => event.stopPropagation());
    listen('cancel', event => {
        if (event.target !== element) return;
        event.preventDefault();
        if (topDialog() === element && !dismissPopup(event)) state.select(null, {history: true});
    });
    const stopKeys = isolateDialogKeys(element, (event, inside) => {
        if (event.type === 'keyup') { transportControls.keyboard(event); return; }
        if (event.type !== 'keydown') return;
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key.toLowerCase() === 'escape') {
            if (dismissPopup(event)) return;
            if (tracks?.cancelGesture()) { event.preventDefault(); return; }
            if (document.fullscreenElement) { event.preventDefault(); document.exitFullscreen().catch(() => {}); return; }
        }
        if (handleAudioShortcut(event, state, {t, error})) return;
        if (!inside && transportControls.keyboard(event, {ready: !initializing})) return;
        if (inside) {
            // Preserve the input/library controls' own handlers before shortcuts.
            for (let target = event.target; target && target !== element; target = target.parentNode) {
                if (target.onkeydown?.(event) === false) event.preventDefault();
                if (event.defaultPrevented) return;
            }
            if (!event.target.closest('.fv-ed-adjust,.fv-ed-library') && transportControls.keyboard(event, {ready: !initializing})) return;
            if (event.target.closest('.fv-ed-tracks')) { if (!textTools.keyboard(event)) tracks?.keyboard(event); return; }
        }
        keyboard(event);
    });
    const releaseStamp = () => {
        pointerEditing = false;
        if (deferredStamp) {
            const value = deferredStamp; deferredStamp = null;
            suppressSave = true; try { state.adopt(value); } finally { suppressSave = false; }
        }
    };
    listen('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    listen('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); library?.importFiles([...event.dataTransfer.files]); } });
    listen('pointerdown', event => {
        if (!menu.hidden && !menu.contains(event.target) && event.target !== title) menu.hidden = true;
    });
    const leaving = () => { player.pause(); rememberView(); if (queue.dirty) queue.flush(); };
    window.addEventListener('pagehide', leaving);
    const handle = {element, state, actions, store, adjust, audio,
        async switchView(view) {
            if (closing || disposed || view === 'editor') return;
            if (await handle.close() !== false) await onView(view);
        },
        async close() {
            if (closePromise) return closePromise;
            textTools.flush();
            closing = true; element.inert = true; player.pause();
            closePromise = (async () => {
                await handle.ready;
                if (generationDone) await generationDone;
                releaseStamp(); await queue.flush();
                if (queue.dirty && !queue.locallyRetained && !discardOnSwitch) {
                    discardOnSwitch = true; closing = false; element.inert = false; closePromise = null;
                    saveWarning.textContent = t('Not saved yet. Switching again will lose recent changes.', '还没保存好，再切换会丢掉最近的改动');
                    saveWarning.hidden = false; return false;
                }
                rememberView(); disposed = true; transportControls.dispose(); player.dispose();
                textTools.dispose(); adjust.dispose(); notes.dispose(); pictureEdit.dispose();
                audio.dispose();
                listeners.splice(0).forEach(remove => remove());
                for (const node of [element, ...element.querySelectorAll('*')]) for (const name of ['onclick', 'ondblclick', 'oninput', 'onchange', 'onkeydown', 'ondragstart']) node[name] = null;
                unsubscribe(); stopSources(); library?.dispose(); genbar.dispose(); tracks?.dispose(); stopExport?.();
                progressConnection?.stop(); progressObserver?.disconnect(); runProgress.clear();
                stopKeys();
                resumeCanvasPointer();
                window.removeEventListener('pagehide', leaving); clearTimeout(noticeTimer);
                for (const stop of jobWatchers.values()) stop(); jobWatchers.clear();
                queue.dispose({discard: discardOnSwitch}); store.dispose(); if (element.open) element.close(); element.replaceChildren(); element.remove(); if (opened === handle) opened = null;
                if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
            })();
            return closePromise;
        },
    };
    library = createEditorLibrary(libraryHost, {store, t, actions, state});
    opened = handle; document.body.append(element); element.showModal(); viewChanged('editor'); navigation.querySelector('[data-view=editor]').focus();
    handle.ready = (async () => {
        const progressComponents = given && Object.hasOwn(given, 'generationStandIn') && Object.keys(given).length === 1 ? null : given;
        const componentsReady = Promise.allSettled([import('./editor_tracks.js'), progressComponents || loadEditorComponents()]);
        await editorStyles; if (closing || disposed) return;
        let record = null, key = null;
        try {
            await store.recoverOutbox(); if (closing || disposed) return;
            if (from?.work) {
                const work = from.work;
                const id = work.id || work.video?.replace(/^FreeVideo\//, '').replace(/\/video\.mp4$/, '');
                record = await store.byWork(id);
                if (!record) {
                    const key = `work:${id}`; await store.getSources([key]); const metadata = store.sources.get(key), g = work.geometry || {};
                    record = model.emptyProject({width: even(metadata?.width || g.width || panel.width || 1344), height: even(metadata?.height || g.height || panel.height || 768),
                        settings: panel.settings || null, name: t('Untitled edit', '未命名剪辑')});
                    record = model.insertSource(record, {source: {kind: 'work', id}, frames: metadata?.frames || g.frames || Math.round((g.seconds || 15) * 24),
                        hasVideo: true, hasAudio: metadata?.has_audio ?? work.has_audio !== false, at: 0});
                    if (!metadata) store.cache({[key]: {video: mediaURL(api, work.video), audio: mediaURL(api, work.video), frames: g.frames,
                        has_video: true, has_audio: true, path: work.video, missing: false, thumbnail: '/freevideo/library/thumbnail?' + new URLSearchParams({id})}});
                }
            } else {
                let id; try { id = localStorage.getItem('fv-editor-last'); } catch {}
                let draft; try { draft = globalThis.sessionStorage?.getItem('fv-editor-draft'); } catch { draft = lastDraft; }
                if (draft?.startsWith('draft:')) key = draft;
                else if (id) { record = await store.load(id); if (record) key = id; }
            }
        } catch (value) { error(value); }
        if (closing || disposed) return;
        try {
            await replaceProject(record || state.record, key);
            if (from?.work && !state.record.id) queue.enqueue(state.record);
        } catch (value) { error(value); }
        if (closing || disposed) return;
        initializing = false; savedContent = content(state.record); player.refresh();
        loaded = true; settleGenbar();
        updateTop(); updateTransport();
        const [trackResult, componentResult] = await componentsReady; if (closing || disposed) return;
        // Optional progress components may fail without taking the tracks with them.
        if (componentResult.status === 'rejected') error(componentResult.reason);
        if (trackResult.status === 'rejected') throw trackResult.reason;
        const module = trackResult.value, components = componentResult.status === 'fulfilled' ? componentResult.value : {};
        blockStates = components.blocks?.blockStates || null;
        let blockProgress = basicBlockProgress;
        if (components.blocks?.createBlockProgress) blockProgress = (id, clipElement) => {
            const component = components.blocks.createBlockProgress({t, showPercent: clipElement.dataset.track === 'v1'});
            let run = null;
            return {element: component.element, update(value) {
                if (value.run && value.run !== run) { component.update({state: 'waiting', fraction: 0}); run = value.run; }
                component.element.dataset.run = run;
                component.update(value);
            }, dispose: () => component.destroy()};
        };
        tracks = module.createTracks(tracksHost, {state, sources: store.sources, t, actions, blockProgress});
        listeners.push(notes.attach(tracks.element));
        transportControls.attachTracks(tracks, module.snapFrame);
        if (api.addEventListener && api.removeEventListener) {
            progressConnection = createProgressConnection(api, receiveProgress); progressConnection.start();
        }
        if (panel.progressElement && typeof MutationObserver !== 'undefined') {
            progressObserver = new MutationObserver(() => { for (const job of jobStatuses.values()) paintJob(job); });
            progressObserver.observe(panel.progressElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-valuenow', 'hidden']});
        }
        const bar = tracks.element.querySelector('.fv-ed-track-zoom');
        if (bar) {
            zoomHost.append(bar);
            for (const control of bar.querySelectorAll('button')) control.title = control.getAttribute('aria-label') || control.textContent;
        }
        for (const [id, value] of progress) tracks.setProgress(id, value);
        tracks.setScrollLeft(editorViews.get(viewKey)?.scrollLeft);
    })().catch(error).finally(() => {
        // Every exit (including close and partial failure) settles readiness.
        // After a completed start the saved baseline is already set; edits made since must stay unsaved.
        if (initializing) { initializing = false; savedContent = content(state.record); }
        title.disabled = false; toolbar.inert = false; loaded = true; settleGenbar();
        tracksHost.inert = !tracks;
        for (const host of [tracksHost, toolbar]) host.classList.remove('fv-ed-pending');
        if (!closing && !disposed) { player.refresh(); updateTop(); updateTransport(); }
    });
    updateTop(); return handle;
}
