// server/lib/imageMetadata.ts — P7 B3: the single owner that removes
// identifying metadata from uploaded raster images before they are stored.
//
// Why: cameras and phones write the capture location (EXIF GPS), device make,
// model and serial, capture time, editing software, free-text comments and an
// embedded thumbnail (which can show the picture before it was cropped) into
// JPEG, PNG, WebP and GIF files. Bridge stored and served those bytes verbatim:
// avatars and banners to anyone holding the URL, attachments to every member
// of the channel. The person uploading a photo rarely knows any of it is there.
//
// How: a lossless container rewrite. Compressed image data is copied byte for
// byte and only metadata containers are dropped — no decode, no re-encode, no
// quality loss, and no dependency on the optional `sharp` package. Display
// orientation is the one EXIF field that changes how a photo looks, so it is
// re-emitted on its own. Colour profiles (ICC) and rendering chunks are kept.
//
// Fail closed: a file whose container cannot be walked is refused
// (ImageMetadataError), never stored as is — metadata cannot be located in a
// structure that cannot be parsed. Truncated compressed data at the end of a
// file is tolerated (browsers render it); a broken header is not.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { Response } from 'express';

/** Formats this owner rewrites. Other uploads are not images this module understands. */
export const METADATA_STRIPPED_MIME: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

export class ImageMetadataError extends Error {
  readonly code = 'IMAGE_UNPARSEABLE';
  readonly statusCode = 422;
  constructor(detail: string) {
    super(`Image could not be processed (${detail})`);
    this.name = 'ImageMetadataError';
  }
}

export interface StripReport {
  mime: string;
  /** false → the file was left byte-identical. */
  changed: boolean;
  /** Short labels of what was removed, e.g. ['exif', 'xmp', 'trailer']. */
  removed: string[];
  bytesBefore: number;
  bytesAfter: number;
  /** EXIF orientation that was re-emitted on its own (2..8), if any. */
  orientation?: number;
}

// ── Byte sources ──────────────────────────────────────────────────────────────
// Uploads can be large (chunked uploads go up to MAX_FILE_SIZE_MB), so a file
// is never read into memory whole: the planners below read headers through a
// small window and describe the output as byte ranges of the input.

interface Source {
  readonly size: number;
  byte(pos: number): number;
  slice(pos: number, len: number): Buffer;
  /** Position of the next 0xFF at or after `from`, or -1. */
  nextFF(from: number): number;
}

class BufferSource implements Source {
  constructor(private readonly buf: Buffer) {}
  get size(): number { return this.buf.length; }
  byte(pos: number): number {
    if (pos < 0 || pos >= this.buf.length) throw new ImageMetadataError('unexpected end of file');
    return this.buf.readUInt8(pos);
  }
  slice(pos: number, len: number): Buffer {
    if (pos < 0 || len < 0 || pos + len > this.buf.length) throw new ImageMetadataError('unexpected end of file');
    return this.buf.subarray(pos, pos + len);
  }
  nextFF(from: number): number { return this.buf.indexOf(0xff, from); }
}

const WINDOW = 1 << 20;

class FileSource implements Source {
  private readonly win = Buffer.allocUnsafe(WINDOW);
  private winStart = 0;
  private winLen = 0;
  constructor(private readonly fd: number, readonly size: number) {}

  private load(pos: number): void {
    this.winStart = pos;
    this.winLen = fs.readSync(this.fd, this.win, 0, Math.min(WINDOW, this.size - pos), pos);
  }
  byte(pos: number): number {
    if (pos < 0 || pos >= this.size) throw new ImageMetadataError('unexpected end of file');
    if (pos < this.winStart || pos >= this.winStart + this.winLen) this.load(pos);
    return this.win.readUInt8(pos - this.winStart);
  }
  slice(pos: number, len: number): Buffer {
    if (pos < 0 || len < 0 || pos + len > this.size) throw new ImageMetadataError('unexpected end of file');
    const out = Buffer.allocUnsafe(len);
    let done = 0;
    while (done < len) {
      const n = fs.readSync(this.fd, out, done, len - done, pos + done);
      if (n <= 0) throw new ImageMetadataError('unexpected end of file');
      done += n;
    }
    return out;
  }
  nextFF(from: number): number {
    let pos = from;
    while (pos < this.size) {
      if (pos < this.winStart || pos >= this.winStart + this.winLen) this.load(pos);
      const i = this.win.subarray(0, this.winLen).indexOf(0xff, pos - this.winStart);
      if (i !== -1) return this.winStart + i;
      pos = this.winStart + this.winLen;
    }
    return -1;
  }
}

// ── Output plan ───────────────────────────────────────────────────────────────

type Piece = { start: number; end: number } | Buffer;

interface Plan {
  pieces: Piece[];
  removed: string[];
  orientation?: number;
}

function pieceLength(p: Piece): number {
  return Buffer.isBuffer(p) ? p.length : p.end - p.start;
}

/** Merge adjacent ranges; detect whether the plan reproduces the input exactly. */
function isIdentity(plan: Plan, size: number): boolean {
  let at = 0;
  for (const p of plan.pieces) {
    if (Buffer.isBuffer(p) || p.start !== at) return false;
    at = p.end;
  }
  return at === size;
}

// ── EXIF orientation (the one field worth keeping) ─────────────────────────────

/** Reads tag 0x0112 from IFD0 of a TIFF structure. Anything malformed → 1. */
export function readExifOrientation(tiff: Buffer): number {
  try {
    if (tiff.length < 8) return 1;
    const order = tiff.toString('latin1', 0, 2);
    const le = order === 'II';
    if (!le && order !== 'MM') return 1;
    const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return 1;
    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return 1;
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) return 1;
      if (u16(e) === 0x0112 && u16(e + 2) === 3 && u32(e + 4) === 1) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
    return 1;
  } catch {
    return 1;
  }
}

/** A TIFF structure holding only IFD0 → Orientation. 26 bytes, no other tag. */
export function orientationOnlyTiff(orientation: number): Buffer {
  const t = Buffer.alloc(26);
  t.write('MM', 0, 'latin1');
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4);       // IFD0 right after the header
  t.writeUInt16BE(1, 8);       // one entry
  t.writeUInt16BE(0x0112, 10); // Orientation
  t.writeUInt16BE(3, 12);      // SHORT
  t.writeUInt32BE(1, 14);      // count 1
  t.writeUInt16BE(orientation, 18);
  t.writeUInt32BE(0, 22);      // no next IFD
  return t;
}

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

// ── JPEG ──────────────────────────────────────────────────────────────────────

const XMP_IDS = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0'];

function startsWith(buf: Buffer, ascii: string): boolean {
  return buf.length >= ascii.length && buf.toString('latin1', 0, ascii.length) === ascii;
}

function planJpeg(src: Source): Plan {
  if (src.size < 4 || src.byte(0) !== 0xff || src.byte(1) !== 0xd8) throw new ImageMetadataError('not a JPEG');
  const head: Piece[] = [{ start: 0, end: 2 }];
  const body: Piece[] = [];
  const removed: string[] = [];
  let orientation = 1;
  let pos = 2;

  for (;;) {
    if (pos >= src.size) throw new ImageMetadataError('JPEG ended before image data');
    if (src.byte(pos) !== 0xff) throw new ImageMetadataError('JPEG marker expected');
    while (pos + 1 < src.size && src.byte(pos + 1) === 0xff) pos++; // fill bytes
    const marker = src.byte(pos + 1);
    if (marker === 0xd8 || marker === 0xd9) throw new ImageMetadataError('JPEG ended before image data');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // standalone markers
      body.push({ start: pos, end: pos + 2 });
      pos += 2;
      continue;
    }
    const len = (src.byte(pos + 2) << 8) | src.byte(pos + 3);
    const segEnd = pos + 2 + len;
    if (len < 2 || segEnd > src.size) throw new ImageMetadataError('JPEG segment overruns the file');

    if (marker === 0xda) { // SOS: entropy-coded data follows
      body.push({ start: pos, end: segEnd });
      pos = segEnd;
      const scan = scanJpegEntropy(src, pos);
      body.push({ start: pos, end: scan.end });
      if (scan.kind === 'eoi') {
        if (scan.end < src.size) removed.push('trailer'); // MPF images, motion-photo video, maker trailers
        break;
      }
      if (scan.kind === 'eof') break; // truncated scan: render what exists, nothing follows
      pos = scan.end; // another segment between progressive scans
      continue;
    }

    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      const id = src.slice(pos + 4, Math.min(len - 2, 40));
      if (marker === 0xe0 && startsWith(id, 'JFIF\0') && len >= 16) {
        // Keep JFIF (density), drop its optional thumbnail.
        if (len === 16) body.push({ start: pos, end: segEnd });
        else {
          const jfif = Buffer.from(src.slice(pos, 18));
          jfif.writeUInt16BE(16, 2);
          jfif[16] = 0; jfif[17] = 0;
          body.push(jfif);
          removed.push('jfif-thumbnail');
        }
      } else if (marker === 0xe2 && startsWith(id, 'ICC_PROFILE\0')) {
        body.push({ start: pos, end: segEnd }); // colour, not identity
      } else if (marker === 0xee && startsWith(id, 'Adobe')) {
        body.push({ start: pos, end: segEnd }); // colour transform for CMYK/YCCK
      } else if (marker === 0xe1 && startsWith(id, 'Exif\0')) {
        if (len - 2 > 6) orientation = readExifOrientation(src.slice(pos + 10, len - 8));
        removed.push('exif');
      } else if (marker === 0xe1 && XMP_IDS.some(x => startsWith(id, x))) {
        removed.push('xmp');
      } else {
        removed.push(marker === 0xfe ? 'comment' : `app${marker - 0xe0}`);
      }
      pos = segEnd;
      continue;
    }

    body.push({ start: pos, end: segEnd }); // DQT, DHT, SOFn, DRI, DNL, …
    pos = segEnd;
  }

  if (orientation !== 1) {
    const tiff = orientationOnlyTiff(orientation);
    const app1 = Buffer.alloc(4);
    app1[0] = 0xff; app1[1] = 0xe1;
    app1.writeUInt16BE(2 + EXIF_HEADER.length + tiff.length, 2);
    head.push(Buffer.concat([app1, EXIF_HEADER, tiff]));
  }
  return { pieces: [...head, ...body], removed: dedupe(removed), ...(orientation !== 1 && { orientation }) };
}

/** Walks entropy-coded data after an SOS header to the next real marker. */
function scanJpegEntropy(src: Source, from: number): { kind: 'eoi' | 'segment' | 'eof'; end: number } {
  let pos = from;
  for (;;) {
    const ff = src.nextFF(pos);
    if (ff === -1 || ff + 1 >= src.size) return { kind: 'eof', end: src.size };
    const next = src.byte(ff + 1);
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) { // stuffing, fill, RSTn
      pos = ff + 1;
      continue;
    }
    if (next === 0xd9) return { kind: 'eoi', end: ff + 2 };
    return { kind: 'segment', end: ff };
  }
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Ancillary chunks that affect rendering. Everything else ancillary is metadata. */
const PNG_KEEP = new Set([
  'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'hIST', 'pHYs',
  'acTL', 'fcTL', 'fdAT',
]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function planPng(src: Source): Plan {
  if (src.size < 8 || !src.slice(0, 8).equals(PNG_SIGNATURE)) throw new ImageMetadataError('not a PNG');
  const pieces: Piece[] = [{ start: 0, end: 8 }];
  const removed: string[] = [];
  let orientation = 1;
  let afterIhdr = -1;
  let pos = 8;
  let sawIend = false;

  while (pos < src.size) {
    if (pos + 12 > src.size) throw new ImageMetadataError('PNG chunk overruns the file');
    const len = src.slice(pos, 4).readUInt32BE(0);
    const type = src.slice(pos + 4, 4).toString('latin1');
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > src.size || !/^[A-Za-z]{4}$/.test(type)) {
      throw new ImageMetadataError('PNG chunk overruns the file');
    }
    const critical = type.charCodeAt(0) < 0x61; // upper-case first letter
    if (type === 'IEND') {
      pieces.push({ start: pos, end });
      if (end < src.size) removed.push('trailer');
      sawIend = true;
      break;
    }
    if (critical || PNG_KEEP.has(type)) {
      pieces.push({ start: pos, end });
      if (type === 'IHDR') afterIhdr = pieces.length;
    } else {
      if (type === 'eXIf') orientation = readExifOrientation(src.slice(pos + 8, len));
      removed.push(type === 'eXIf' ? 'exif' : type);
    }
    pos = end;
  }
  if (!sawIend) throw new ImageMetadataError('PNG has no IEND');
  if (afterIhdr === -1) throw new ImageMetadataError('PNG has no IHDR');
  if (orientation !== 1) pieces.splice(afterIhdr, 0, pngChunk('eXIf', orientationOnlyTiff(orientation)));
  return { pieces, removed: dedupe(removed), ...(orientation !== 1 && { orientation }) };
}

// ── WebP ──────────────────────────────────────────────────────────────────────

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function planWebp(src: Source): Plan {
  if (src.size < 12 || src.slice(0, 4).toString('latin1') !== 'RIFF' || src.slice(8, 4).toString('latin1') !== 'WEBP') {
    throw new ImageMetadataError('not a WebP');
  }
  const riffEnd = 8 + src.slice(4, 4).readUInt32LE(0);
  if (riffEnd > src.size || riffEnd < 12) throw new ImageMetadataError('WebP RIFF size overruns the file');
  const chunks: Piece[] = [];
  const removed: string[] = [];
  let orientation = 1;
  let vp8xIndex = -1;
  let pos = 12;

  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) throw new ImageMetadataError('WebP chunk overruns the file');
    const fourcc = src.slice(pos, 4).toString('latin1');
    const len = src.slice(pos + 4, 4).readUInt32LE(0);
    const end = pos + 8 + len + (len & 1);
    if (end > riffEnd) throw new ImageMetadataError('WebP chunk overruns the file');
    if (WEBP_KEEP.has(fourcc)) {
      if (fourcc === 'VP8X') {
        if (len < 10) throw new ImageMetadataError('WebP VP8X header too short');
        vp8xIndex = chunks.length;
        chunks.push(Buffer.from(src.slice(pos, end - pos))); // flags rewritten below
      } else {
        chunks.push({ start: pos, end });
      }
    } else {
      if (fourcc === 'EXIF') {
        let tiff = src.slice(pos + 8, len);
        if (startsWith(tiff, 'Exif\0\0')) tiff = tiff.subarray(6);
        orientation = readExifOrientation(tiff);
      }
      removed.push(fourcc === 'EXIF' ? 'exif' : fourcc === 'XMP ' ? 'xmp' : fourcc.trim());
    }
    pos = end;
  }
  if (riffEnd < src.size) removed.push('trailer');
  if (removed.length === 0) return { pieces: [{ start: 0, end: src.size }], removed };

  if (vp8xIndex !== -1) {
    const vp8x = chunks[vp8xIndex] as Buffer;
    const flags = vp8x.readUInt8(8) & ~(VP8X_EXIF | VP8X_XMP) & 0xff;
    vp8x.writeUInt8(orientation !== 1 ? flags | VP8X_EXIF : flags, 8);
    if (orientation !== 1) {
      const tiff = orientationOnlyTiff(orientation);
      const head = Buffer.alloc(8);
      head.write('EXIF', 0, 'latin1');
      head.writeUInt32LE(tiff.length, 4);
      chunks.push(Buffer.concat([head, tiff])); // EXIF goes after the image data
    }
  } else {
    orientation = 1; // the simple format cannot carry EXIF at all
  }
  const bodyLen = chunks.reduce((n, p) => n + pieceLength(p), 0);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + bodyLen, 4);
  riff.write('WEBP', 8, 'latin1');
  return { pieces: [riff, ...chunks], removed: dedupe(removed), ...(orientation !== 1 && { orientation }) };
}

// ── GIF ───────────────────────────────────────────────────────────────────────

/** Application extensions that carry animation behaviour or colour, not identity. */
const GIF_KEEP_APP = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

function skipSubBlocks(src: Source, from: number): number {
  let pos = from;
  for (;;) {
    const n = src.byte(pos);
    pos += 1 + n;
    if (n === 0) return pos;
    if (pos > src.size) throw new ImageMetadataError('GIF block overruns the file');
  }
}

function planGif(src: Source): Plan {
  if (src.size < 13) throw new ImageMetadataError('not a GIF');
  const sig = src.slice(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new ImageMetadataError('not a GIF');
  const flags = src.byte(10);
  let pos = 13 + ((flags & 0x80) ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
  if (pos > src.size) throw new ImageMetadataError('GIF colour table overruns the file');
  const pieces: Piece[] = [{ start: 0, end: pos }];
  const removed: string[] = [];

  while (pos < src.size) {
    const kind = src.byte(pos);
    if (kind === 0x3b) { // trailer
      pieces.push({ start: pos, end: pos + 1 });
      if (pos + 1 < src.size) removed.push('trailer');
      return { pieces, removed: dedupe(removed) };
    }
    if (kind === 0x2c) { // image descriptor (+ local colour table) + LZW data
      const f = src.byte(pos + 9);
      let p = pos + 10 + ((f & 0x80) ? 3 * (1 << ((f & 0x07) + 1)) : 0);
      p = skipSubBlocks(src, p + 1); // +1: LZW minimum code size
      pieces.push({ start: pos, end: p });
      pos = p;
      continue;
    }
    if (kind === 0x21) {
      const label = src.byte(pos + 1);
      const end = skipSubBlocks(src, pos + 2);
      if (label === 0xf9 || label === 0x01) { // graphic control, plain text: rendering
        pieces.push({ start: pos, end });
      } else if (label === 0xff) {
        const n = src.byte(pos + 2);
        const app = n >= 11 ? src.slice(pos + 3, 11).toString('latin1') : '';
        if (GIF_KEEP_APP.has(app)) pieces.push({ start: pos, end });
        else removed.push(app.startsWith('XMP Data') ? 'xmp' : 'application-extension');
      } else {
        removed.push(label === 0xfe ? 'comment' : 'extension');
      }
      pos = end;
      continue;
    }
    throw new ImageMetadataError('GIF block type unknown');
  }
  // A GIF without its trailer byte still renders; keep it that way.
  return { pieces, removed: dedupe(removed) };
}

// ── Public API ────────────────────────────────────────────────────────────────

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function plan(src: Source, mime: string): Plan {
  switch (mime) {
    case 'image/jpeg': return planJpeg(src);
    case 'image/png': return planPng(src);
    case 'image/webp': return planWebp(src);
    case 'image/gif': return planGif(src);
    default: throw new Error(`stripImageMetadata: unsupported type ${mime}`);
  }
}

/** In-memory variant (tests, small buffers). */
export function stripImageMetadataBuffer(input: Buffer, mimeType: string): { buffer: Buffer; report: StripReport } {
  const mime = mimeType.toLowerCase();
  if (!METADATA_STRIPPED_MIME.has(mime)) {
    return { buffer: input, report: { mime, changed: false, removed: [], bytesBefore: input.length, bytesAfter: input.length } };
  }
  const p = plan(new BufferSource(input), mime);
  if (isIdentity(p, input.length)) {
    return { buffer: input, report: { mime, changed: false, removed: [], bytesBefore: input.length, bytesAfter: input.length } };
  }
  const out = Buffer.concat(p.pieces.map(piece => (Buffer.isBuffer(piece) ? piece : input.subarray(piece.start, piece.end))));
  return {
    buffer: out,
    report: { mime, changed: true, removed: p.removed, bytesBefore: input.length, bytesAfter: out.length, ...(p.orientation && { orientation: p.orientation }) },
  };
}

/**
 * Rewrites `filePath` in place (temp file + rename) without its metadata.
 * Non-image types are left untouched. Throws ImageMetadataError when the image
 * container cannot be walked; the caller refuses the upload.
 */
export async function stripImageMetadataFile(filePath: string, mimeType: string): Promise<StripReport> {
  const mime = mimeType.toLowerCase();
  const size = (await fs.promises.stat(filePath)).size;
  if (!METADATA_STRIPPED_MIME.has(mime)) {
    return { mime, changed: false, removed: [], bytesBefore: size, bytesAfter: size };
  }

  const fd = fs.openSync(filePath, 'r');
  let p: Plan;
  try {
    p = plan(new FileSource(fd, size), mime);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  if (isIdentity(p, size)) {
    fs.closeSync(fd);
    return { mime, changed: false, removed: [], bytesBefore: size, bytesAfter: size };
  }

  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.strip`);
  let out: number | undefined;
  let written = 0;
  try {
    out = fs.openSync(tmp, 'wx', 0o600);
    const block = Buffer.allocUnsafe(WINDOW);
    for (const piece of p.pieces) {
      if (Buffer.isBuffer(piece)) {
        fs.writeSync(out, piece);
        written += piece.length;
        continue;
      }
      for (let at = piece.start; at < piece.end;) {
        const n = fs.readSync(fd, block, 0, Math.min(WINDOW, piece.end - at), at);
        if (n <= 0) throw new ImageMetadataError('file changed while being processed');
        fs.writeSync(out, block, 0, n);
        at += n;
        written += n;
      }
    }
    fs.fsyncSync(out);
    fs.closeSync(out);
    out = undefined;
    fs.closeSync(fd);
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    if (out !== undefined) { try { fs.closeSync(out); } catch {} }
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return {
    mime, changed: true, removed: p.removed, bytesBefore: size, bytesAfter: written,
    ...(p.orientation && { orientation: p.orientation }),
  };
}

/**
 * Route helper for the common case: strip `file` in place before it is stored.
 * On any failure the uploaded file is deleted. An unparseable image is answered
 * with 422 and the caller gets null and stops; any other error (I/O) is
 * rethrown to the route's error handling.
 */
export async function stripUploadedImageOrRefuse(
  res: Response,
  file: { path: string; mimetype: string },
): Promise<StripReport | null> {
  try {
    return await stripImageMetadataFile(file.path, file.mimetype);
  } catch (error) {
    fs.unlink(file.path, () => {});
    if (!(error instanceof ImageMetadataError)) throw error;
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return null;
  }
}
