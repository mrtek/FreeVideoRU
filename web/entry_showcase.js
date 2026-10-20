// Set this to the first product release that ships the showcase and Agent workflow.
// Each eligible product version gets one chapter in the existing guide.json seen list.
export const SHOWCASE_START_VERSION = '0.4.10';
// The ready-made white-model scene the showcase's button starts.
export const SHOWCASE_SCENE = 'cat';
export const SHOWCASE_ASSET = new URL('./assets/entry-showcase.webp', import.meta.url).href;
export const SHOWCASE_TEXT = {
    title: ['From whitebox animation to finished video', '从白模动画到写实视频'],
    try: ['Get started', '开始使用'],
    close: ['Close', '关闭'],
    example: [
        "A ginger cat crouches on a living room floor, gathers itself and leaps up a staggered wooden bookshelf, jumping from one shelf to the next between rows of books, and finally settles on the top shelf, while the camera pans sideways and tilts up slightly to follow. Warm indoor daylight, realistic fur and wood, soft shadows, smooth camera motion. Soft room tone and the light thud of paws on wood.",
        "一只橘猫在客厅地板上蹲下蓄力，跳上错落的木书架，在成排的书之间一层一层往上跳，最后稳稳落在最高一层，镜头向侧面平移并略微上摇跟随。温暖的室内日光，写实的毛发和木纹，柔和的阴影，镜头平滑。安静的室内环境声，爪子落在木头上的轻响。",
    ],
};

const parts = version => typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)
    ? version.split('.').map(Number) : null;

export function showcaseChapter(version, start = SHOWCASE_START_VERSION) {
    const current = parts(version), minimum = parts(start);
    if (!current || !minimum) return null;
    for (let i = 0; i < 3; i++) {
        if (current[i] < minimum[i]) return null;
        if (current[i] > minimum[i]) break;
    }
    return {id: `entry-showcase:${version}`, group: 'showcase', added: true};
}

// Decode before drawing: a missing, corrupt or oversized local asset never leaves
// an empty card. Fetch failures are deliberately quiet, like unreadable guide records.
export async function loadShowcaseImage(src = SHOWCASE_ASSET) {
    let url;
    try {
        const reply = await fetch(src, {signal: AbortSignal.timeout(4000)});
        if (!reply.ok) return null;
        const blob = await reply.blob();
        if (!blob.size || blob.size > 2_000_000) return null;
        url = URL.createObjectURL(blob);
        const image = new Image(); image.alt = ''; image.src = url;
        await image.decode();
        return image;
    } catch { return null; }
    finally { if (url) URL.revokeObjectURL(url); }
}
