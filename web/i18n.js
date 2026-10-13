import { RU_DICT } from './translations_ru.js';

function detectLanguage() {
    let override = null;
    try {
        if (typeof location !== 'undefined') {
            override = new URLSearchParams(location.search).get('freevideo_lang');
        }
    } catch {}
    if (override === 'zh' || override === 'ru' || override === 'en') {
        try { localStorage.setItem('freevideo_lang', override); } catch {}
        return override;
    }
    let saved = null;
    try { saved = localStorage.getItem('freevideo_lang'); } catch {}
    if (saved === 'zh' || saved === 'ru' || saved === 'en') {
        return saved;
    }
    const nav = String(typeof navigator !== 'undefined' && (navigator.language || '')).toLowerCase();
    if (nav.startsWith('ru')) return 'ru';
    if (nav.startsWith('zh')) return 'zh';
    return 'en';
}

let currentLanguage = detectLanguage();

export function getLanguage() {
    return currentLanguage;
}

export function setLanguage(lang) {
    if (lang !== 'ru' && lang !== 'zh' && lang !== 'en') return;
    currentLanguage = lang;
    try { localStorage.setItem('freevideo_lang', lang); } catch {}
    if (typeof location !== 'undefined') {
        const url = new URL(location.href);
        url.searchParams.set('freevideo_lang', lang);
        location.replace(url.href);
    }
}

export const isZh = () => currentLanguage === 'zh';
export const isRu = () => currentLanguage === 'ru';
export const isEn = () => currentLanguage === 'en';

export function t(en, zh, ru) {
    if (currentLanguage === 'ru') {
        return ru || RU_DICT[en] || en;
    }
    if (currentLanguage === 'zh') {
        return zh || en;
    }
    return en;
}
