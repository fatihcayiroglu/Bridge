// server/tests/helpers/imageFixtures.ts — real images carrying the identifying
// metadata a phone writes, built byte by byte so the tests do not depend on
// what an encoder chooses to keep. Pixel data comes from sharp (a real encoder);
// metadata is inserted in the container exactly where cameras put it.

import zlib from 'zlib';
import sharp from 'sharp';

/** Strings that must never survive metadata minimisation. */
export const IDENTIFYING = {
  make: 'BridgeTestCam',
  model: 'Model-X1',
  serial: 'SN-PRIVATE-4471',
  takenAt: '2026:10:08 07:15:00',
  author: 'secret-author-name',
  xmp: 'xmp-secret-creator',
  comment: 'comment-secret-text',
} as const;

export function containsAnyIdentifying(buf: Buffer): string[] {
  return Object.values(IDENTIFYING).filter(s => buf.includes(s));
}

type Entry = { tag: number; type: 2 | 3 | 4 | 5; count: number; value: Buffer };

const ascii = (tag: number, s: string): Entry => ({ tag, type: 2, count: s.length + 1, value: Buffer.from(s + '\0', 'latin1') });
const short = (tag: number, v: number): Entry => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return { tag, type: 3, count: 1, value: b }; };
const long = (tag: number, v: number): Entry => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return { tag, type: 4, count: 1, value: b }; };
const rationals = (tag: number, parts: Array<[number, number]>): Entry => {
  const b = Buffer.alloc(parts.length * 8);
  parts.forEach(([n, d], i) => { b.writeUInt32BE(n, i * 8); b.writeUInt32BE(d, i * 8 + 4); });
  return { tag, type: 5, count: parts.length, value: b };
};

/** One IFD (entries sorted by tag) plus its out-of-line values, placed at `at`. */
function ifd(entries: Entry[], at: number): Buffer {
  entries.sort((a, b) => a.tag - b.tag);
  const tableLen = 2 + entries.length * 12 + 4;
  const table = Buffer.alloc(tableLen);
  const extra: Buffer[] = [];
  let dataAt = at + tableLen;
  table.writeUInt16BE(entries.length, 0);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    table.writeUInt16BE(e.tag, o);
    table.writeUInt16BE(e.type, o + 2);
    table.writeUInt32BE(e.count, o + 4);
    if (e.value.length <= 4) e.value.copy(table, o + 8);
    else {
      table.writeUInt32BE(dataAt, o + 8);
      const padded = e.value.length & 1 ? Buffer.concat([e.value, Buffer.alloc(1)]) : e.value;
      extra.push(padded);
      dataAt += padded.length;
    }
  });
  return Buffer.concat([table, ...extra]);
}

/**
 * A big-endian TIFF structure as a phone writes it: IFD0 (make, model,
 * orientation) → Exif IFD (serial number, capture time) and GPS IFD
 * (Istanbul, to the metre).
 */
export function identifyingTiff(orientation = 1): Buffer {
  const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  const ifd0Entries = (exifAt: number, gpsAt: number): Entry[] => [
    ascii(0x010f, IDENTIFYING.make),
    ascii(0x0110, IDENTIFYING.model),
    short(0x0112, orientation),
    long(0x8769, exifAt),
    long(0x8825, gpsAt),
  ];
  const ifd0Len = ifd(ifd0Entries(0, 0), 8).length;
  const exifAt = 8 + ifd0Len;
  const exifEntries = [ascii(0xa431, IDENTIFYING.serial), ascii(0x9003, IDENTIFYING.takenAt)];
  const exifLen = ifd(exifEntries, exifAt).length;
  const gpsAt = exifAt + exifLen;
  const gps = ifd([
    ascii(0x0001, 'N'), rationals(0x0002, [[41, 1], [0, 1], [3612, 100]]),
    ascii(0x0003, 'E'), rationals(0x0004, [[28, 1], [58, 1], [4518, 100]]),
  ], gpsAt);
  return Buffer.concat([header, ifd(ifd0Entries(exifAt, gpsAt), 8), ifd(exifEntries, exifAt), gps]);
}

/** Tags present in IFD0 of a TIFF structure (for asserting what survived). */
export function ifd0Tags(tiff: Buffer): Map<number, number> {
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const at = u32(4);
  const tags = new Map<number, number>();
  for (let i = 0; i < u16(at); i++) {
    const e = at + 2 + i * 12;
    tags.set(u16(e), u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8));
  }
  return tags;
}

export const XMP_PACKET =
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">` +
  `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="${IDENTIFYING.xmp}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

// ── JPEG ──

export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Inserts segments right after SOI (and after a leading JFIF APP0, if any). */
export function withJpegSegments(jpeg: Buffer, segments: Buffer[]): Buffer {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, at), ...segments, jpeg.subarray(at)]);
}

/** Segment markers present before the first SOS, in order. */
export function jpegMarkers(jpeg: Buffer): number[] {
  const out: number[] = [];
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const m = jpeg[pos + 1];
    out.push(m);
    if (m === 0xda) break;
    pos += 2 + jpeg.readUInt16BE(pos + 2);
  }
  return out;
}

export function jpegExifPayload(jpeg: Buffer): Buffer | null {
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff && jpeg[pos + 1] !== 0xda) {
    const len = jpeg.readUInt16BE(pos + 2);
    if (jpeg[pos + 1] === 0xe1 && jpeg.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
      return jpeg.subarray(pos + 10, pos + 2 + len);
    }
    pos += 2 + len;
  }
  return null;
}

/** A JFIF APP0 carrying a 2×1 RGB thumbnail (what the stripper must drop). */
export function jfifWithThumbnail(): Buffer {
  return jpegSegment(0xe0, Buffer.concat([
    Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 1, 0, 72, 0, 72, 2, 1]), Buffer.from([255, 0, 0, 0, 255, 0]),
  ]));
}

/** A real photo-sized JPEG (noise, so the entropy data spans many read windows). */
export async function noiseJpeg(width: number, height: number, opts: { progressive?: boolean } = {}): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let s = 0x2545f491;
  for (let i = 0; i < raw.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; raw[i] = s & 0xff; }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90, progressive: !!opts.progressive }).toBuffer();
}

// ── PNG ──

export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function pngChunks(png: Buffer): string[] {
  const out: string[] = [];
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    out.push(png.toString('latin1', pos + 4, pos + 8));
    pos += 12 + len;
  }
  return out;
}

export function pngChunkData(png: Buffer, type: string): Buffer | null {
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    if (png.toString('latin1', pos + 4, pos + 8) === type) return png.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
  }
  return null;
}

/** Every chunk's CRC matches its type and data (libpng only warns on ancillary CRC errors). */
export function pngCrcsValid(png: Buffer): boolean {
  let pos = 8;
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    const crc = zlib.crc32(png.subarray(pos + 4, pos + 8 + len)) >>> 0;
    if (crc !== png.readUInt32BE(pos + 8 + len)) return false;
    pos += 12 + len;
  }
  return pos === png.length;
}

/** Inserts chunks right after IHDR (eXIf/text chunks may appear anywhere before IEND). */
export function withPngChunks(png: Buffer, chunks: Buffer[]): Buffer {
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}

// ── WebP / GIF ──

export function riffChunks(webp: Buffer): string[] {
  const out: string[] = [];
  let pos = 12;
  while (pos + 8 <= webp.length) {
    const len = webp.readUInt32LE(pos + 4);
    out.push(webp.toString('latin1', pos, pos + 4));
    pos += 8 + len + (len & 1);
  }
  return out;
}

/** Appends an EXIF chunk (camera-style TIFF) to a VP8X WebP and sets its flag. */
export function withWebpExif(webp: Buffer, tiff: Buffer): Buffer {
  if (webp.toString('latin1', 12, 16) !== 'VP8X') throw new Error('fixture needs an extended (VP8X) WebP');
  const head = Buffer.alloc(8);
  head.write('EXIF', 0, 'latin1');
  head.writeUInt32LE(tiff.length, 4);
  const out = Buffer.concat([webp, head, tiff, Buffer.alloc(tiff.length & 1)]);
  out[12 + 8] |= 0x08;
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

export function gifExtension(label: number, payload: Buffer): Buffer {
  const blocks: Buffer[] = [];
  for (let i = 0; i < payload.length; i += 255) {
    const part = payload.subarray(i, i + 255);
    blocks.push(Buffer.from([part.length]), part);
  }
  return Buffer.concat([Buffer.from([0x21, label]), ...blocks, Buffer.from([0])]);
}

/** Inserts blocks right after the header, logical screen descriptor and global colour table. */
export function withGifBlocks(gif: Buffer, blocks: Buffer[]): Buffer {
  const flags = gif[10];
  const at = 13 + ((flags & 0x80) ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
  return Buffer.concat([gif.subarray(0, at), ...blocks, gif.subarray(at)]);
}

export async function pixels(img: Buffer): Promise<Buffer> {
  return sharp(img, { animated: true }).raw().toBuffer();
}
