// MediaRecorder uses capture wall time. Keep its compressed pictures but replace
// that timeline with i/fps, and verify that every requested picture was encoded.
// No decoding, external dependency, or uncompressed frame collection is needed.
function mp4Boxes(bytes, start = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    while (start < end) {
        if (start + 8 > end) throw new Error('Truncated recorder MP4 box');
        let size = view.getUint32(start);
        const name = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
        let header = 8;
        if (size === 1) { size = Number(view.getBigUint64(start + 8)); header = 16; }
        if (!size) size = end - start;
        if (size < header || start + size > end) throw new Error('Invalid recorder MP4 box size');
        boxes.push({name, start, body: start + header, end: start + size});
        start += size;
    }
    return boxes;
}

function retimeMp4(bytes, frames, fps, mime) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const top = mp4Boxes(bytes);
    const moov = top.find(box => box.name === 'moov');
    if (!moov) throw new Error('Recorder MP4 has no moov');
    const timescale = Math.round(fps * 1000000), delta = 1000000, duration = frames * delta;
    let count = 0, tracks = 0;
    const setTime = (offset, value, wide) => wide ? view.setBigUint64(offset, BigInt(value)) : view.setUint32(offset, value);
    const walk = box => {
        const p = box.body, wide = bytes[p] === 1;
        switch (box.name) {
        case 'trak': tracks++; break;
        case 'mvhd': case 'mdhd':
            view.setUint32(p + (wide ? 20 : 12), timescale);
            setTime(p + (wide ? 24 : 16), duration, wide);
            break;
        case 'tkhd': setTime(p + (wide ? 28 : 20), duration, wide); break;
        case 'trex': view.setUint32(p + 12, delta); break;
        case 'stts': {
            const entries = view.getUint32(p + 4);
            for (let i = 0; i < entries; i++) {
                count += view.getUint32(p + 8 + i * 8);
                view.setUint32(p + 12 + i * 8, delta);
            }
            break;
        }
        case 'ctts': throw new Error('Recorder MP4 with reordered pictures is unsupported');
        case 'elst': {
            if (view.getUint32(p + 4) !== 1) throw new Error('Recorder MP4 has a complex edit list');
            setTime(p + 8, duration, wide);
            setTime(p + (wide ? 16 : 12), 0, wide);
            break;
        }
        }
        if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts'].includes(box.name))
            mp4Boxes(bytes, box.body, box.end).forEach(walk);
    };
    walk(moov);
    if (tracks !== 1) throw new Error('Recorder MP4 must have exactly one video track');
    let fragmented = 0;
    for (const moof of top.filter(box => box.name === 'moof')) {
        for (const traf of mp4Boxes(bytes, moof.body, moof.end).filter(box => box.name === 'traf')) {
            const children = mp4Boxes(bytes, traf.body, traf.end);
            const tfhd = children.find(box => box.name === 'tfhd');
            if (tfhd) {
                const flags = view.getUint32(tfhd.body) & 0xffffff;
                let p = tfhd.body + 8;
                if (flags & 1) p += 8;
                if (flags & 2) p += 4;
                if (flags & 8) view.setUint32(p, delta);
            }
            const tfdt = children.find(box => box.name === 'tfdt');
            if (!tfdt) throw new Error('Recorder MP4 fragment has no decode time');
            setTime(tfdt.body + 4, fragmented * delta, bytes[tfdt.body] === 1);
            for (const trun of children.filter(box => box.name === 'trun')) {
                const flags = view.getUint32(trun.body) & 0xffffff;
                const n = view.getUint32(trun.body + 4);
                let p = trun.body + 8;
                if (flags & 1) p += 4;
                if (flags & 4) p += 4;
                for (let i = 0; i < n; i++) {
                    if (flags & 0x100) { view.setUint32(p, delta); p += 4; }
                    if (flags & 0x200) p += 4;
                    if (flags & 0x400) p += 4;
                    if (flags & 0x800) {
                        if (view.getInt32(p)) throw new Error('Recorder MP4 has reordered pictures');
                        p += 4;
                    }
                }
                if (p !== trun.end) throw new Error('Invalid recorder MP4 sample table');
                fragmented += n;
            }
        }
    }
    if ((fragmented || count) !== frames) throw new Error(`Recorder encoded ${fragmented || count} of ${frames} frames`);
    // Fragment seek indexes contain old timestamps; they are optional. Removing
    // a trailing mfra leaves all sample offsets and the faststart moov intact.
    return new Blob(top.filter(box => box.name !== 'mfra').map(box => bytes.subarray(box.start, box.end)), {type: mime});
}

function ebmlElements(bytes, start = 0, end = bytes.length) {
    const elements = [];
    const vint = (offset, id) => {
        let length = 1, bit = 0x80;
        while (length <= 8 && !(bytes[offset] & bit)) { length++; bit >>= 1; }
        if (length > 8 || offset + length > end) throw new Error('Invalid recorder WebM integer');
        let value = id ? bytes[offset] : bytes[offset] & (bit - 1);
        for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
        return {length, value, unknown: !id && value === 2 ** (7 * length) - 1};
    };
    while (start < end) {
        const id = vint(start, true), size = vint(start + id.length, false);
        const body = start + id.length + size.length;
        let next = size.unknown ? end : body + size.value;
        if (size.unknown && id.value === 0x1f43b675) {
            // Streaming recorders may leave Cluster sizes unknown. Walk child
            // boundaries (never scan compressed bytes) until the next Segment
            // child, which starts the following Cluster or index.
            next = body;
            const siblings = [0x1f43b675, 0x1549a966, 0x1654ae6b, 0x1c53bb6b,
                0x114d9b74, 0x1254c367, 0x1941a469, 0x1043a770];
            while (next < end) {
                const childId = vint(next, true);
                if (siblings.includes(childId.value)) break;
                const childSize = vint(next + childId.length, false);
                if (childSize.unknown) throw new Error('Unsupported unknown WebM child size');
                next += childId.length + childSize.length + childSize.value;
            }
        }
        if (next > end) throw new Error('Truncated recorder WebM element');
        elements.push({id: id.value, start, body, end: next});
        start = next;
    }
    return elements;
}
const uint = number => {
    const data = [];
    do { data.unshift(number % 256); number = Math.floor(number / 256); } while (number);
    return new Uint8Array(data);
};
const concat = parts => {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
};
const element = (id, parts) => {
    const body = concat(parts);
    let length = 1;
    while (body.length >= 2 ** (length * 7) - 1) length++;
    const size = new Uint8Array(length);
    let value = body.length;
    for (let i = length - 1; i >= 0; i--) { size[i] = value % 256; value = Math.floor(value / 256); }
    size[0] |= 1 << (8 - length);
    return concat([uint(id), size, body]);
};

function retimeWebm(bytes, frames, fps, mime) {
    const top = ebmlElements(bytes);
    const header = top.find(e => e.id === 0x1a45dfa3), segment = top.find(e => e.id === 0x18538067);
    if (!header || !segment) throw new Error('Recorder returned invalid WebM');
    const children = ebmlElements(bytes, segment.body, segment.end);
    const tracks = children.find(e => e.id === 0x1654ae6b);
    if (!tracks) throw new Error('Recorder WebM has no video track');
    const entries = ebmlElements(bytes, tracks.body, tracks.end).filter(e => e.id === 0xae);
    if (entries.length !== 1) throw new Error('Recorder WebM must have exactly one track');
    const fields = ebmlElements(bytes, entries[0].body, entries[0].end);
    const track = element(0xae, [...fields.filter(e => e.id !== 0x23e383).map(e => bytes.subarray(e.start, e.end)),
        element(0x23e383, [uint(Math.round(1000000000 / fps))])]);
    const blocks = [];
    for (const cluster of children.filter(e => e.id === 0x1f43b675)) {
        for (const block of ebmlElements(bytes, cluster.body, cluster.end)) {
            if (block.id === 0xa0) throw new Error('Recorder WebM BlockGroup is unsupported');
            if (block.id !== 0xa3) continue;
            const data = bytes.slice(block.body, block.end);
            let trackBytes = 1, bit = 0x80;
            while (!(data[0] & bit)) { trackBytes++; bit >>= 1; }
            if (trackBytes > 8 || data.length < trackBytes + 3 || (data[trackBytes + 2] & 6))
                throw new Error('Recorder WebM lacing is unsupported');
            data[trackBytes] = data[trackBytes + 1] = 0;
            blocks.push(data);
        }
    }
    if (blocks.length !== frames) throw new Error(`Recorder encoded ${blocks.length} of ${frames} frames`);
    const duration = new Uint8Array(8);
    new DataView(duration.buffer).setFloat64(0, frames * 1000000 / fps);
    const info = element(0x1549a966, [element(0x2ad7b1, [uint(1000)]), element(0x4489, [duration]),
        element(0x4d80, [new TextEncoder().encode('Whitebox')]), element(0x5741, [new TextEncoder().encode('Whitebox')])]);
    const clusters = blocks.map((block, i) => element(0x1f43b675,
        [element(0xe7, [uint(Math.round(i * 1000000 / fps))]), element(0xa3, [block])]));
    return new Blob([bytes.subarray(header.start, header.end),
        element(0x18538067, [info, element(0x1654ae6b, [track]), ...clusters])], {type: mime});
}

export async function normalizeRecording(blob, {frames, fps, mime}) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return mime.startsWith('video/mp4') ? retimeMp4(bytes, frames, fps, mime) : retimeWebm(bytes, frames, fps, mime);
}
