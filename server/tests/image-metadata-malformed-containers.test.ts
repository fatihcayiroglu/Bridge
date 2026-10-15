// server/tests/image-metadata-malformed-containers.test.ts
//
// lib/imageMetadata.ts walks attacker-supplied image containers before they
// are stored. image-metadata.test.ts proves the camera-metadata cases; this
// file pins the edges it does not reach:
//   - every container shape the walker cannot parse is refused, never stored as is;
//   - a malformed EXIF block is still removed and never yields an invented orientation;
//   - what is kept (JFIF density, Adobe colour transform, standalone markers,
//     a GIF without a global colour table) comes out byte-exact;
//   - on disk, a file that changes underneath the walker, or a disk that refuses
//     the temp file, keeps the original and leaves no temp file behind;
//   - the route helper answers 422 for an unparseable image and rethrows I/O errors.

process.env.NODE_ENV = 'test';

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Response } from 'express';
import {
  ImageMetadataError, orientationOnlyTiff, readExifOrientation, stripImageMetadataBuffer,
  stripImageMetadataFile, stripUploadedImageOrRefuse,
} from '../lib/imageMetadata';
import {
  IDENTIFYING, containsAnyIdentifying, gifExtension, identifyingTiff, jpegSegment, pixels,
  pngChunk, pngChunkData, pngChunks, riffChunks, withGifBlocks, withJpegSegments, withPngChunks,
} from './helpers/imageFixtures';
import { TINY_GIF, TINY_JPEG, TINY_PNG, TINY_WEBP } from './helpers/tinyImages';

/** The walker's refusal detail, after asserting it is the fail-closed error type. */
function refusal(input: Buffer, mime: string): string {
  let caught: unknown;
  try { stripImageMetadataBuffer(input, mime); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ImageMetadataError);
  return /\((.*)\)$/.exec((caught as Error).message)?.[1] ?? '';
}

/** A TIFF holding only IFD0 → one SHORT entry, in either byte order. */
function oneEntryTiff(order: 'II' | 'MM', value: number, opts: { tag?: number; type?: number; magic?: number; ifd?: number } = {}): Buffer {
  const le = order === 'II';
  const t = Buffer.alloc(26);
  const w16 = (v: number, o: number) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  const w32 = (v: number, o: number) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
  t.write(order, 0, 'latin1');
  w16(opts.magic ?? 42, 2);
  w32(opts.ifd ?? 8, 4);
  w16(1, 8);
  w16(opts.tag ?? 0x0112, 10);
  w16(opts.type ?? 3, 12);
  w32(1, 14);
  w16(value, 18);
  w32(0, 22);
  return t;
}

/** IFD0 announces two entries: ImageWidth, then an Orientation entry that the buffer cuts off. */
function truncatedSecondEntryTiff(): Buffer {
  const t = Buffer.alloc(8 + 2 + 12 + 6);
  t.write('MM', 0, 'latin1');
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4);
  t.writeUInt16BE(2, 8);
  t.writeUInt16BE(0x0100, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(64, 18);
  t.writeUInt16BE(0x0112, 22); t.writeUInt16BE(3, 24); // the rest of this entry is missing
  return t;
}

const MALFORMED_TIFFS: Array<[string, Buffer]> = [
  ['shorter than a TIFF header', Buffer.from('MM\0*', 'latin1')],
  ['an unknown byte order', oneEntryTiff('MM', 6).fill('X', 0, 2)],
  ['a wrong TIFF magic number', oneEntryTiff('MM', 6, { magic: 43 })],
  ['an IFD0 offset past the end', oneEntryTiff('MM', 6, { ifd: 1000 })],
  ['an IFD0 entry table cut short', truncatedSecondEntryTiff()],
  ['an orientation value above 8', oneEntryTiff('MM', 9)],
  ['an orientation value of 0', oneEntryTiff('II', 0)],
  ['the orientation tag stored as LONG instead of SHORT', oneEntryTiff('MM', 6, { type: 4 })],
];

describe('readExifOrientation never invents an orientation', () => {
  it('reads Orientation from IFD0 in both byte orders', () => {
    expect(readExifOrientation(oneEntryTiff('II', 6))).toBe(6);
    expect(readExifOrientation(oneEntryTiff('MM', 8))).toBe(8);
  });

  it.each(MALFORMED_TIFFS)('%s reads as the default orientation 1', (_name, tiff) => {
    expect(readExifOrientation(tiff)).toBe(1);
  });
});

describe('JPEG', () => {
  const soi = TINY_JPEG.subarray(0, 2);
  const afterSoi = TINY_JPEG.subarray(2);

  it('a file that is not a JPEG, or is shorter than a marker, is refused', () => {
    expect(refusal(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')).toBe('not a JPEG');
    expect(refusal(TINY_PNG, 'image/jpeg')).toBe('not a JPEG');
  });

  it('bytes where a marker must be, and a second SOI or an EOI before the image data, are refused', () => {
    expect(refusal(Buffer.from([0xff, 0xd8, 0x00, 0x11, 0x22, 0x33]), 'image/jpeg')).toBe('JPEG marker expected');
    expect(refusal(Buffer.concat([soi, Buffer.from([0xff, 0xd9]), afterSoi]), 'image/jpeg')).toBe('JPEG ended before image data');
    expect(refusal(Buffer.concat([soi, Buffer.from([0xff, 0xd8]), afterSoi]), 'image/jpeg')).toBe('JPEG ended before image data');
  });

  it('a file cut inside a segment header is refused', () => {
    // SOI, then APP1 whose length bytes are missing.
    expect(refusal(Buffer.from([0xff, 0xd8, 0xff, 0xe1]), 'image/jpeg')).toBe('unexpected end of file');
  });

  it('keeps a standalone marker before the frame and still drops a comment next to it', async () => {
    const input = withJpegSegments(TINY_JPEG, [Buffer.from([0xff, 0x01]), jpegSegment(0xfe, Buffer.from(IDENTIFYING.comment))]);
    const { buffer, report } = stripImageMetadataBuffer(input, 'image/jpeg');
    expect(report).toMatchObject({ changed: true, removed: ['comment'] });
    expect(buffer.equals(Buffer.concat([soi, Buffer.from([0xff, 0x01]), afterSoi]))).toBe(true);
    expect(await pixels(buffer)).toEqual(await pixels(TINY_JPEG));
  });

  it('keeps a plain 16-byte JFIF segment byte for byte while dropping EXIF', () => {
    const jfif = jpegSegment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 1, 0, 72, 0, 72, 0, 0])]));
    expect(jfif.readUInt16BE(2)).toBe(16);
    const exif = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), identifyingTiff()]));
    const { buffer, report } = stripImageMetadataBuffer(withJpegSegments(TINY_JPEG, [jfif, exif]), 'image/jpeg');
    expect(report.removed).toEqual(['exif']);
    expect(report.orientation).toBeUndefined();
    expect(buffer.equals(Buffer.concat([soi, jfif, afterSoi]))).toBe(true);
    expect(containsAnyIdentifying(buffer)).toEqual([]);
  });

  it('keeps an Adobe colour-transform APP14 but drops any other APP14', () => {
    const adobe = jpegSegment(0xee, Buffer.concat([Buffer.from('Adobe', 'latin1'), Buffer.from([0, 100, 0, 0, 0, 0, 1])]));
    const other = jpegSegment(0xee, Buffer.from(`Vendor\0${IDENTIFYING.serial}`, 'latin1'));
    const { buffer, report } = stripImageMetadataBuffer(withJpegSegments(TINY_JPEG, [adobe, other]), 'image/jpeg');
    expect(report.removed).toEqual(['app14']);
    expect(buffer.equals(Buffer.concat([soi, adobe, afterSoi]))).toBe(true);
    expect(containsAnyIdentifying(buffer)).toEqual([]);
  });

  it('an EXIF segment with no TIFF data is removed without re-emitting an orientation', () => {
    const empty = jpegSegment(0xe1, Buffer.from('Exif\0\0', 'latin1'));
    const { buffer, report } = stripImageMetadataBuffer(withJpegSegments(TINY_JPEG, [empty]), 'image/jpeg');
    expect(report).toMatchObject({ changed: true, removed: ['exif'] });
    expect(report.orientation).toBeUndefined();
    expect(buffer.equals(TINY_JPEG)).toBe(true);
  });

  it('an upper-case MIME type is still stripped', () => {
    const exif = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), identifyingTiff()]));
    const { buffer, report } = stripImageMetadataBuffer(withJpegSegments(TINY_JPEG, [exif]), 'IMAGE/JPEG');
    expect(report).toMatchObject({ mime: 'image/jpeg', changed: true, removed: ['exif'] });
    expect(containsAnyIdentifying(buffer)).toEqual([]);
  });
});

describe('PNG', () => {
  const iend = TINY_PNG.subarray(TINY_PNG.length - 12);
  const beforeIend = TINY_PNG.subarray(0, TINY_PNG.length - 12);

  it('a file without the PNG signature is refused', () => {
    expect(refusal(TINY_JPEG, 'image/png')).toBe('not a PNG');
    expect(refusal(TINY_PNG.subarray(0, 5), 'image/png')).toBe('not a PNG');
  });

  it('a chunk header cut short, a non-letter chunk type and an absurd length are refused', () => {
    expect(refusal(Buffer.concat([beforeIend, Buffer.alloc(6)]), 'image/png')).toBe('PNG chunk overruns the file');
    expect(refusal(withPngChunks(TINY_PNG, [pngChunk('t3Xt', Buffer.from(IDENTIFYING.author))]), 'image/png'))
      .toBe('PNG chunk overruns the file');
    const huge = Buffer.alloc(12);
    huge.writeUInt32BE(0x80000000, 0);
    huge.write('tEXt', 4, 'latin1');
    expect(refusal(withPngChunks(TINY_PNG, [huge]), 'image/png')).toBe('PNG chunk overruns the file');
  });

  it('a PNG with an IEND but no IHDR is refused, even when it only carries metadata', () => {
    const signature = TINY_PNG.subarray(0, 8);
    expect(refusal(Buffer.concat([signature, iend]), 'image/png')).toBe('PNG has no IHDR');
    expect(refusal(Buffer.concat([signature, pngChunk('tEXt', Buffer.from(`Author\0${IDENTIFYING.author}`)), iend]), 'image/png'))
      .toBe('PNG has no IHDR');
  });

  it.each(MALFORMED_TIFFS)('an eXIf chunk with %s is removed and no orientation is re-emitted', (_name, tiff) => {
    const { buffer, report } = stripImageMetadataBuffer(withPngChunks(TINY_PNG, [pngChunk('eXIf', tiff)]), 'image/png');
    expect(report).toMatchObject({ changed: true, removed: ['exif'] });
    expect(report.orientation).toBeUndefined();
    expect(buffer.equals(TINY_PNG)).toBe(true);
  });

  it('a little-endian eXIf orientation is re-emitted on its own, right after IHDR', () => {
    const { buffer, report } = stripImageMetadataBuffer(withPngChunks(TINY_PNG, [pngChunk('eXIf', oneEntryTiff('II', 6))]), 'image/png');
    expect(report.orientation).toBe(6);
    expect(pngChunks(buffer)).toEqual(['IHDR', 'eXIf', ...pngChunks(TINY_PNG).slice(1)]);
    expect(pngChunkData(buffer, 'eXIf')!.equals(orientationOnlyTiff(6))).toBe(true);
  });
});

describe('WebP', () => {
  const riff = (body: Buffer) => {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(4 + body.length, 4);
    head.write('WEBP', 8, 'latin1');
    return Buffer.concat([head, body]);
  };
  const chunk = (fourcc: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
  };
  const imageChunks = TINY_WEBP.subarray(12);

  it('a file that is not a RIFF WebP is refused', () => {
    expect(refusal(TINY_PNG, 'image/webp')).toBe('not a WebP');
    const wave = Buffer.from(TINY_WEBP);
    wave.write('WAVE', 8, 'latin1');
    expect(refusal(wave, 'image/webp')).toBe('not a WebP');
  });

  it('a chunk header or a chunk payload that overruns the RIFF size is refused', () => {
    expect(refusal(riff(Buffer.concat([imageChunks, Buffer.from('EXIF', 'latin1')])), 'image/webp')).toBe('WebP chunk overruns the file');
    const lying = Buffer.alloc(8);
    lying.write('EXIF', 0, 'latin1');
    lying.writeUInt32LE(100, 4);
    expect(refusal(riff(Buffer.concat([imageChunks, lying])), 'image/webp')).toBe('WebP chunk overruns the file');
  });

  it('a simple-format WebP drops a stray EXIF chunk and cannot carry the orientation', async () => {
    const input = riff(Buffer.concat([imageChunks, chunk('EXIF', identifyingTiff(6))]));
    expect(containsAnyIdentifying(input).length).toBeGreaterThan(0);
    const { buffer, report } = stripImageMetadataBuffer(input, 'image/webp');
    expect(report).toMatchObject({ changed: true, removed: ['exif'] });
    expect(report.orientation).toBeUndefined();
    expect(buffer.equals(TINY_WEBP)).toBe(true);
    expect(await pixels(buffer)).toEqual(await pixels(TINY_WEBP));
  });

  it('any other non-image chunk and bytes after the RIFF end are removed', () => {
    const input = Buffer.concat([riff(Buffer.concat([imageChunks, chunk('ID3 ', Buffer.from(IDENTIFYING.author))])), Buffer.from(IDENTIFYING.serial)]);
    const { buffer, report } = stripImageMetadataBuffer(input, 'image/webp');
    expect(report.removed).toEqual(['ID3', 'trailer']);
    expect(buffer.equals(TINY_WEBP)).toBe(true);
    expect(riffChunks(buffer)).toEqual(['VP8L']);
  });
});

describe('GIF', () => {
  // TINY_GIF: header + screen descriptor (flags 0x80: 2-entry global table),
  // 6-byte table, graphic control extension, image descriptor + LZW data, trailer.
  const headerAndTable = TINY_GIF.subarray(0, 19);

  it('a file that is too short or has another signature is refused', () => {
    expect(refusal(TINY_GIF.subarray(0, 12), 'image/gif')).toBe('not a GIF');
    const gif88 = Buffer.from(TINY_GIF);
    gif88.write('GIF88a', 0, 'latin1');
    expect(refusal(gif88, 'image/gif')).toBe('not a GIF');
  });

  it('a global colour table larger than the file is refused', () => {
    const big = Buffer.from(TINY_GIF);
    big[10] = 0x87; // 256-entry table = 768 bytes
    expect(refusal(big, 'image/gif')).toBe('GIF colour table overruns the file');
  });

  it('a sub-block longer than the rest of the file, and an unknown block type, are refused', () => {
    const cut = Buffer.concat([headerAndTable, Buffer.from([0x21, 0xfe, 200]), Buffer.from(IDENTIFYING.comment).subarray(0, 10)]);
    expect(refusal(cut, 'image/gif')).toBe('GIF block overruns the file');
    expect(refusal(withGifBlocks(TINY_GIF, [Buffer.from([0x99, 0x00])]), 'image/gif')).toBe('GIF block type unknown');
  });

  it('removes a short application block, an unknown application and an unknown extension; keeps the frame', () => {
    const shortApp = Buffer.concat([Buffer.from([0x21, 0xff, 0x03]), Buffer.from('abc'), Buffer.from([0])]);
    const vendor = gifExtension(0xff, Buffer.concat([Buffer.from('ACMEPHOTO10', 'latin1'), Buffer.from(IDENTIFYING.serial)]));
    const unknown = gifExtension(0x02, Buffer.from(IDENTIFYING.author));
    const { buffer, report } = stripImageMetadataBuffer(withGifBlocks(TINY_GIF, [shortApp, vendor, unknown]), 'image/gif');
    expect(report.removed).toEqual(['application-extension', 'extension']);
    expect(buffer.equals(TINY_GIF)).toBe(true);
  });

  it('bytes after the trailer are removed', () => {
    const { buffer, report } = stripImageMetadataBuffer(Buffer.concat([TINY_GIF, Buffer.from(IDENTIFYING.serial)]), 'image/gif');
    expect(report.removed).toEqual(['trailer']);
    expect(buffer.equals(TINY_GIF)).toBe(true);
  });

  it('a GIF with only a local colour table is walked correctly and loses its comment', async () => {
    // Same picture: the 2-entry table moves from the screen descriptor to the image descriptor.
    const table = TINY_GIF.subarray(13, 19);
    const gce = TINY_GIF.subarray(19, 27);
    const descriptor = Buffer.from(TINY_GIF.subarray(27, 37));
    descriptor[9] = 0x80;
    const screen = Buffer.from(TINY_GIF.subarray(0, 13));
    screen[10] = 0x00;
    const local = Buffer.concat([screen, gce, descriptor, table, TINY_GIF.subarray(37)]);
    const input = withGifBlocks(local, [gifExtension(0xfe, Buffer.from(IDENTIFYING.comment))]);
    const { buffer, report } = stripImageMetadataBuffer(input, 'image/gif');
    expect(report.removed).toEqual(['comment']);
    expect(buffer.equals(local)).toBe(true);
    expect(await pixels(buffer)).toEqual(await pixels(TINY_GIF));
  });
});

describe('non-image uploads', () => {
  it('a type this owner does not understand is returned as the same buffer, unchanged', () => {
    const pdf = Buffer.from(`%PDF-1.7 ${IDENTIFYING.author}`);
    const { buffer, report } = stripImageMetadataBuffer(pdf, 'application/pdf');
    expect(buffer).toBe(pdf);
    expect(report).toEqual({ mime: 'application/pdf', changed: false, removed: [], bytesBefore: pdf.length, bytesAfter: pdf.length });
  });
});

describe('stripImageMetadataFile when the disk or the file changes underneath it', () => {
  let dir: string;
  const photo = () => withPngChunks(TINY_PNG, [pngChunk('tEXt', Buffer.from(`Author\0${IDENTIFYING.author}`))]);
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-imgmeta-edge-')); });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a JPEG cut inside a segment header on disk is refused and left untouched', async () => {
    const file = path.join(dir, 'cut.jpg');
    const cut = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);
    fs.writeFileSync(file, cut);
    await expect(stripImageMetadataFile(file, 'image/jpeg')).rejects.toThrow('Image could not be processed (unexpected end of file)');
    expect(fs.readFileSync(file).equals(cut)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['cut.jpg']);
  });

  it('a file that shrinks after it was opened is refused while it is being read', async () => {
    const file = path.join(dir, 'shrinks.png');
    fs.writeFileSync(file, photo());
    const realOpen = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
      const fd = realOpen(p, flags, mode);
      if (p === file && flags === 'r') fs.truncateSync(file, 0);
      return fd;
    }) as typeof fs.openSync);
    await expect(stripImageMetadataFile(file, 'image/png')).rejects.toThrow('Image could not be processed (unexpected end of file)');
    expect(fs.readdirSync(dir)).toEqual(['shrinks.png']);
  });

  it('a file that shrinks while it is being rewritten is refused and its temp file removed', async () => {
    const file = path.join(dir, 'changes.png');
    fs.writeFileSync(file, photo());
    const realOpen = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
      if (flags === 'wx') fs.truncateSync(file, 10); // after planning, before copying
      return realOpen(p, flags, mode);
    }) as typeof fs.openSync);
    await expect(stripImageMetadataFile(file, 'image/png')).rejects.toThrow('Image could not be processed (file changed while being processed)');
    expect(fs.readdirSync(dir)).toEqual(['changes.png']);
  });

  it('a disk that refuses the temp file rethrows that error and keeps the original intact', async () => {
    const file = path.join(dir, 'full.png');
    const original = photo();
    fs.writeFileSync(file, original);
    const realOpen = fs.openSync;
    const opened: number[] = [];
    jest.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
      if (flags === 'wx') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      const fd = realOpen(p, flags, mode);
      opened.push(fd);
      return fd;
    }) as typeof fs.openSync);
    const close = jest.spyOn(fs, 'closeSync');
    const err = await stripImageMetadataFile(file, 'image/png').catch((e: unknown) => e);
    // Checked before reading the file back (that read opens its own descriptor).
    expect(opened).toHaveLength(1);
    expect(close).toHaveBeenCalledWith(opened[0]); // the source descriptor is not leaked
    expect(err).not.toBeInstanceOf(ImageMetadataError);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['full.png']);
  });
});

describe('stripUploadedImageOrRefuse (route helper)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-imgmeta-route-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const fakeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  };
  const gone = async (file: string) => {
    for (let i = 0; i < 100 && fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
    return !fs.existsSync(file);
  };

  it('answers 422 with the stable code for an unparseable image and deletes the upload', async () => {
    const file = path.join(dir, 'upload.bin');
    fs.writeFileSync(file, TINY_JPEG);
    const res = fakeRes();
    await expect(stripUploadedImageOrRefuse(res as unknown as Response, { path: file, mimetype: 'image/png' })).resolves.toBeNull();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: 'Image could not be processed (not a PNG)', code: 'IMAGE_UNPARSEABLE' });
    expect(await gone(file)).toBe(true);
  });

  it('rethrows an I/O failure to the route instead of answering 422', async () => {
    const res = fakeRes();
    const missing = path.join(dir, 'missing.png');
    await expect(stripUploadedImageOrRefuse(res as unknown as Response, { path: missing, mimetype: 'image/png' }))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns the report for a strippable image and leaves the response to the route', async () => {
    const file = path.join(dir, 'photo.gif');
    fs.writeFileSync(file, withGifBlocks(TINY_GIF, [gifExtension(0xfe, Buffer.from(IDENTIFYING.comment))]));
    const res = fakeRes();
    const report = await stripUploadedImageOrRefuse(res as unknown as Response, { path: file, mimetype: 'image/gif' });
    expect(report).toMatchObject({ changed: true, removed: ['comment'] });
    expect(fs.readFileSync(file).equals(TINY_GIF)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});
