// Browser auto-translate reads ComfyUI's lang="en" page and rewrites FreeVideo's own text: "MP"
// became 兆帕. FreeVideo writes both languages itself, so its surfaces opt out of translation and
// a Chinese interface says so on the document.
const OWN_CLASS = /(^|\s)fv-/;

export function markOwn(node) {
    if (node?.nodeType !== 1 || node.hasAttribute('translate')) return;
    if (OWN_CLASS.test(node.getAttribute('class') || '') || node.id?.startsWith('fv-')) node.setAttribute('translate', 'no');
}

export function installTranslateGuard({chinese, doc = document} = {}) {
    if (chinese) doc.documentElement.lang = 'zh-CN';
    for (const node of doc.body.children) markOwn(node);
    new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) markOwn(node);
    }).observe(doc.body, {childList: true});
}
