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

function translatePattern(en) {
    if (!en || typeof en !== 'string') return null;
    let m;
    if ((m = en.match(/^About\s+(\d+)\s+min$/i))) return `Около ${m[1]} мин`;
    if ((m = en.match(/^About\s+(\d+)\s+s$/i))) return `Около ${m[1]} с`;
    if ((m = en.match(/^About\s+(\d+)\s+h$/i))) return `Около ${m[1]} ч`;
    if ((m = en.match(/^About\s+(\d+)[\s\u00a0]+min\s+left$/i))) return `Осталось около ${m[1]} мин`;
    if ((m = en.match(/^About\s+(\d+)[\s\u00a0]+s\s+left$/i))) return `Осталось около ${m[1]} с`;
    if ((m = en.match(/^Sampling\s+(\d+)\s*\/\s*(\d+)$/i))) return `Сэмплирование ${m[1]} / ${m[2]}`;
    if ((m = en.match(/^Take\s+(\d+)$/i))) return `Дубль ${m[1]}`;
    if ((m = en.match(/^In queue\s*·\s*#(\d+)$/i))) return `В очереди · #${m[1]}`;
    if ((m = en.match(/^First-pass preview\s*·\s*(\d+)\s*[×x]\s*(\d+)$/i))) return `Предпросмотр первого прохода · ${m[1]} × ${m[2]}`;
    if ((m = en.match(/^Export\s+(\d+)%$/i))) return `Экспорт ${m[1]}%`;
    if ((m = en.match(/^(\d+)\s+parts$/i))) return `${m[1]} частей`;
    if ((m = en.match(/^(\d+)\s+parts selected$/i))) return `Выбрано частей: ${m[1]}`;
    if ((m = en.match(/^Done in\s+(.+)$/i))) return `Готово за ${m[1]}`;
    if ((m = en.match(/^Failed after\s+(.+)$/i))) return `Сбой через ${m[1]}`;
    if ((m = en.match(/^Auto subtitles\s*·\s*Download\s+(\d+)\s+MB$/i))) return `Автосубтитры · Скачать ${m[1]} МБ`;
    return null;
}

export function t(en, zh, ru) {
    if (currentLanguage === 'ru') {
        return ru || RU_DICT[en] || translatePattern(en) || en;
    }
    if (currentLanguage === 'zh') {
        return zh || en;
    }
    return en;
}
