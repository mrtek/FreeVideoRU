// Single AVC track, no reordered pictures. Encoded samples are kept, never PNG frames.
const ascii = text => Uint8Array.from(text, c => c.charCodeAt(0));
const u16 = n => new Uint8Array([n >>> 8, n & 255]);
const u32 = n => new Uint8Array([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255]);
const zeros = n => new Uint8Array(n);
function join(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}
const box = (name, ...parts) => {
    const body = join(...parts);
    return join(u32(body.length + 8), ascii(name), body);
};
const full = (name, flags, ...parts) => box(name, u32(flags), ...parts);
const matrix = join(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000),
    u32(0), u32(0), u32(0), u32(0x40000000));
const TIMESCALE = 1000000;

/** Minimal faststart MP4 writer for WebCodecs avc.format="avc" output. */
export class AvcMp4Muxer {
    constructor({width, height, fps}) {
        if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 65535)
            || !Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error('Invalid MP4 dimensions or fps');
        Object.assign(this, {width, height, fps, samples: [], description: null});
    }

    add(chunk, metadata = {}) {
        const config = metadata.decoderConfig;
        if (config?.description) {
            const bytes = config.description;
            const description = bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
                : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (description.length < 7 || description[0] !== 1 || (description[4] & 3) !== 3)
                throw new Error('Expected AVCDecoderConfigurationRecord with 4-byte NAL lengths');
            if (this.description && (description.length !== this.description.length
                || description.some((b, i) => b !== this.description[i])))
                throw new Error('AVC configuration changed during encoding');
            this.description = description.slice();
        }
        const index = this.samples.length;
        if (chunk.timestamp !== Math.round(index * TIMESCALE / this.fps))
            throw new Error('MP4 requires ordered constant-rate samples (no B-frames)');
        if (!index && chunk.type !== 'key') throw new Error('First AVC sample must be a key frame');
        if (!chunk.byteLength) throw new Error('Empty AVC sample');
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.samples.push({bytes, key: chunk.type === 'key'});
    }

    finalize(expectedFrames = this.samples.length) {
        const {width, height, fps, samples, description} = this;
        const count = samples.length;
        if (!description || !count || count !== expectedFrames) throw new Error('Missing AVC configuration or encoded frames');
        const duration = Math.round(count * TIMESCALE / fps);
        if (duration > 0xffffffff) throw new Error('MP4 duration exceeds 32-bit limit');
        const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));
        const entry = box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height),
            u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(24), u16(0xffff),
            box('avcC', description));
        const runs = [];
        for (let i = 0; i < count; i++) {
            const delta = Math.round((i + 1) * TIMESCALE / fps) - Math.round(i * TIMESCALE / fps);
            if (runs.length && runs.at(-1)[1] === delta) runs.at(-1)[0]++;
            else runs.push([1, delta]);
        }
        const keys = samples.flatMap((s, i) => s.key ? [u32(i + 1)] : []);
        const moov = offset => box('moov',
            full('mvhd', 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u32(0x10000),
                u16(0x100), zeros(10), matrix, zeros(24), u32(2)),
            box('trak',
                full('tkhd', 3, u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8),
                    u16(0), u16(0), u16(0), u16(0), matrix, u32(width * 65536), u32(height * 65536)),
                box('mdia',
                    full('mdhd', 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0)),
                    full('hdlr', 0, u32(0), ascii('vide'), zeros(12), ascii('Whitebox\0')),
                    box('minf', full('vmhd', 1, zeros(8)),
                        box('dinf', full('dref', 0, u32(1), full('url ', 1))),
                        box('stbl', full('stsd', 0, u32(1), entry),
                            full('stts', 0, u32(runs.length), ...runs.map(([n, d]) => join(u32(n), u32(d)))),
                            full('stsc', 0, u32(1), u32(1), u32(count), u32(1)),
                            full('stsz', 0, u32(0), u32(count), ...samples.map(s => u32(s.bytes.length))),
                            full('stco', 0, u32(1), u32(offset)), full('stss', 0, u32(keys.length), ...keys))))));
        const header = moov(0);
        const mdatSize = 8 + samples.reduce((n, s) => n + s.bytes.length, 0);
        if (mdatSize > 0xffffffff) throw new Error('MP4 exceeds 32-bit file limit');
        return new Blob([ftyp, moov(ftyp.length + header.length + 8), u32(mdatSize), ascii('mdat'),
            ...samples.map(s => s.bytes)], {type: 'video/mp4'});
    }
}
