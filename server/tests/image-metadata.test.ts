// server/tests/image-metadata.test.ts — P7 B3 image metadata minimisation.
//
// Every case uses a REAL image (encoded by sharp) carrying metadata inserted
// where cameras put it, and proves three things: the identifying bytes are
// gone, the picture decodes to exactly the same pixels, and what must stay
// (orientation, colour profile, animation) stays.

process.env.NODE_ENV = 'test';

import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  ImageMetadataError, stripImageMetadataBuffer, stripImageMetadataFile, readExifOrientation,
} from '../lib/imageMetadata';
import {
  IDENTIFYING, XMP_PACKET, containsAnyIdentifying, identifyingTiff, ifd0Tags,
  jpegSegment, withJpegSegments, jpegMarkers, jpegExifPayload, jfifWithThumbnail, noiseJpeg,
  pngChunk, pngChunks, pngChunkData, pngCrcsValid, withPngChunks, riffChunks, withWebpExif, gifExtension, withGifBlocks, pixels,
} from './helpers/imageFixtures';
import { TINY_GIF, TINY_JPEG, TINY_PNG, TINY_WEBP } from './helpers/tinyImages';

const solid = { create: { width: 16, height: 12, channels: 3 as const, background: { r: 200, g: 30, b: 60 } } };
const exifApp1 = (orientation = 1) => jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), identifyingTiff(orientation)]));
const xmpApp1 = () => jpegSegment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(XMP_PACKET)]));
const comment = () => jpegSegment(0xfe, Buffer.from(IDENTIFYING.comment));
const iptc = () => jpegSegment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), Buffer.from(IDENTIFYING.author)]));

describe('JPEG', () => {
  it('a phone photo loses GPS, device, serial, capture time, XMP, IPTC, comment, thumbnail and appended images — pixels unchanged', async () => {
    const clean = await sharp(solid).withIccProfile('p3').jpeg().toBuffer();
    const motionPhotoTrailer = Buffer.concat([await sharp(solid).jpeg().toBuffer(), Buffer.from(IDENTIFYING.serial)]);
    const photo = Buffer.concat([
      withJpegSegments(clean, [exifApp1(), xmpApp1(), iptc(), comment()]),
      motionPhotoTrailer,
    ]);
    // the fixture really carries what a camera writes
    expect(containsAnyIdentifying(photo).sort()).toEqual(
      [IDENTIFYING.make, IDENTIFYING.model, IDENTIFYING.serial, IDENTIFYING.takenAt, IDENTIFYING.author, IDENTIFYING.xmp, IDENTIFYING.comment].sort(),
    );
    expect(ifd0Tags(jpegExifPayload(photo)!).has(0x8825)).toBe(true); // GPSInfo pointer

    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/jpeg');

    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(jpegExifPayload(buffer)).toBeNull();
    expect(report.changed).toBe(true);
    expect(report.removed).toEqual(expect.arrayContaining(['exif', 'xmp', 'app13', 'comment', 'trailer']));
    expect(await pixels(buffer)).toEqual(await pixels(photo));
    const meta = await sharp(buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toEqual((await sharp(clean).metadata()).icc); // colour profile kept
    expect(buffer.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9])); // ends at its own EOI
  });

  it('keeps the display orientation, and only it', async () => {
    const photo = withJpegSegments(await sharp(solid).jpeg().toBuffer(), [exifApp1(6)]);
    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/jpeg');
    expect(report.orientation).toBe(6);
    expect(containsAnyIdentifying(buffer)).toEqual([]);
    const tiff = jpegExifPayload(buffer)!;
    expect([...ifd0Tags(tiff).entries()]).toEqual([[0x0112, 6]]);
    expect((await sharp(buffer).metadata()).orientation).toBe(6);
    // and the photo still renders upright: auto-oriented output matches the original's
    expect(await sharp(buffer).rotate().raw().toBuffer()).toEqual(await sharp(photo).rotate().raw().toBuffer());
  });

  it('drops a JFIF thumbnail (it can show the picture before it was cropped) but keeps JFIF density', async () => {
    const base = await sharp(solid).jpeg().toBuffer();
    // replace sharp's JFIF (if any) with one that carries a thumbnail
    const noApp0 = base[3] === 0xe0 ? Buffer.concat([base.subarray(0, 2), base.subarray(4 + base.readUInt16BE(4))]) : base;
    const photo = Buffer.concat([noApp0.subarray(0, 2), jfifWithThumbnail(), noApp0.subarray(2)]);
    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/jpeg');
    expect(report.removed).toContain('jfif-thumbnail');
    expect(buffer.subarray(2, 20)).toEqual(Buffer.from([0xff, 0xe0, 0, 16, ...Buffer.from('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0]));
    expect(await pixels(buffer)).toEqual(await pixels(photo));
  });

  it('a progressive JPEG keeps every scan (and loses a comment placed between scans)', async () => {
    const prog = await noiseJpeg(64, 48, { progressive: true });
    const sosAt = prog.indexOf(Buffer.from([0xff, 0xda]));
    const secondSos = prog.indexOf(Buffer.from([0xff, 0xda]), sosAt + 2);
    expect(secondSos).toBeGreaterThan(sosAt); // several scans
    const photo = withJpegSegments(
      Buffer.concat([prog.subarray(0, secondSos), comment(), prog.subarray(secondSos)]),
      [exifApp1()],
    );
    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/jpeg');
    expect(report.removed).toEqual(expect.arrayContaining(['exif', 'comment']));
    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(await pixels(buffer)).toEqual(await pixels(prog));
  });

  it('a JPEG truncated inside its image data is still accepted, without its metadata', async () => {
    const photo = withJpegSegments(await noiseJpeg(64, 48), [exifApp1()]);
    const truncated = photo.subarray(0, photo.length - 200);
    const { buffer } = stripImageMetadataBuffer(truncated, 'image/jpeg');
    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(jpegMarkers(buffer)).not.toContain(0xe1);
  });

  it('a clean JPEG is left byte-identical', async () => {
    const clean = await sharp(solid).jpeg().toBuffer();
    expect(jpegMarkers(clean).some(m => m === 0xe1 || m === 0xfe)).toBe(false);
    const { buffer, report } = stripImageMetadataBuffer(clean, 'image/jpeg');
    expect(report.changed).toBe(false);
    expect(buffer.equals(clean)).toBe(true);
  });
});

describe('PNG', () => {
  it('loses eXIf (GPS), tEXt/zTXt/iTXt (author, XMP), tIME and trailing bytes; keeps colour chunks; pixels unchanged', async () => {
    const clean = await sharp(solid).withIccProfile('p3').png().toBuffer();
    const photo = Buffer.concat([withPngChunks(clean, [
      pngChunk('eXIf', identifyingTiff()),
      pngChunk('tEXt', Buffer.from(`Author\0${IDENTIFYING.author}`, 'latin1')),
      pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(XMP_PACKET)])),
      pngChunk('tIME', Buffer.from([0x07, 0xea, 10, 8, 7, 15, 0])),
      pngChunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
    ]), Buffer.from(IDENTIFYING.comment)]);

    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/png');

    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(report.removed).toEqual(expect.arrayContaining(['exif', 'tEXt', 'iTXt', 'tIME', 'trailer']));
    const chunks = pngChunks(buffer);
    expect(chunks).toEqual(expect.arrayContaining(['IHDR', 'iCCP', 'pHYs', 'IDAT', 'IEND']));
    expect(chunks).not.toEqual(expect.arrayContaining(['eXIf']));
    expect(pngCrcsValid(buffer)).toBe(true);
    expect(await pixels(buffer)).toEqual(await pixels(clean));
    expect((await sharp(buffer).metadata()).icc).toBeDefined();
  });

  it('keeps the display orientation as an eXIf chunk holding nothing else (valid CRC)', async () => {
    const photo = withPngChunks(await sharp(solid).png().toBuffer(), [pngChunk('eXIf', identifyingTiff(8))]);
    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/png');
    expect(report.orientation).toBe(8);
    expect([...ifd0Tags(pngChunkData(buffer, 'eXIf')!).entries()]).toEqual([[0x0112, 8]]);
    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(pngCrcsValid(buffer)).toBe(true);
    expect(await pixels(buffer)).toEqual(await pixels(photo));
  });

  it('a clean PNG is left byte-identical (the 1×1 fixture the E2E suites upload)', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const { buffer, report } = stripImageMetadataBuffer(png, 'image/png');
    expect(report.changed).toBe(false);
    expect(buffer.equals(png)).toBe(true);
  });

  it('an animated PNG keeps every frame chunk', async () => {
    const apng = await sharp(solid).png().toBuffer();
    // acTL/fcTL are kept as rendering chunks; a text chunk next to them goes
    const withAnim = withPngChunks(apng, [
      pngChunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
      pngChunk('tEXt', Buffer.from(`Comment\0${IDENTIFYING.comment}`, 'latin1')),
    ]);
    const { buffer } = stripImageMetadataBuffer(withAnim, 'image/png');
    expect(pngChunks(buffer)).toContain('acTL');
    expect(containsAnyIdentifying(buffer)).toEqual([]);
  });
});

describe('WebP', () => {
  it('loses EXIF and XMP chunks, clears their VP8X flags, fixes the RIFF size; pixels unchanged', async () => {
    const photo = await sharp(solid)
      .withExif({ IFD0: { Make: IDENTIFYING.make, Model: IDENTIFYING.model } })
      .withXmp(XMP_PACKET)
      .withIccProfile('p3')
      .webp({ lossless: true })
      .toBuffer();
    expect(riffChunks(photo)).toEqual(expect.arrayContaining(['VP8X', 'EXIF', 'XMP ']));
    expect(containsAnyIdentifying(photo)).toEqual(expect.arrayContaining([IDENTIFYING.make, IDENTIFYING.xmp]));

    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/webp');

    expect(report.removed).toEqual(expect.arrayContaining(['exif', 'xmp']));
    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(riffChunks(buffer)).not.toEqual(expect.arrayContaining(['EXIF']));
    expect(riffChunks(buffer)).not.toEqual(expect.arrayContaining(['XMP ']));
    expect(buffer.readUInt32LE(4)).toBe(buffer.length - 8);
    const flags = buffer[12 + 8];
    expect(flags & 0x08).toBe(0); // EXIF flag
    expect(flags & 0x04).toBe(0); // XMP flag
    expect(flags & 0x20).toBe(0x20); // ICC flag still set, ICCP still there
    expect(riffChunks(buffer)).toContain('ICCP');
    expect(await pixels(buffer)).toEqual(await pixels(photo));
    const meta = await sharp(buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });

  it('keeps the display orientation in an EXIF chunk holding nothing else', async () => {
    const photo = withWebpExif(await sharp(solid).withIccProfile('p3').webp({ lossless: true }).toBuffer(), identifyingTiff(3));
    expect(readExifOrientation((await sharp(photo).metadata()).exif!)).toBe(3);
    expect(containsAnyIdentifying(photo)).toEqual(expect.arrayContaining([IDENTIFYING.make, IDENTIFYING.serial]));
    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/webp');
    expect(report.orientation).toBe(3);
    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(buffer[12 + 8] & 0x08).toBe(0x08);
    expect((await sharp(buffer).metadata()).orientation).toBe(3);
    expect(buffer.readUInt32LE(4)).toBe(buffer.length - 8);
  });
});

describe('GIF', () => {
  it('an animated GIF loses comment and XMP extensions, keeps its loop extension and every frame', async () => {
    const frames = Buffer.concat([
      await sharp(solid).raw().toBuffer(),
      await sharp({ create: { ...solid.create, background: { r: 10, g: 220, b: 40 } } }).raw().toBuffer(),
    ]);
    const anim = await sharp(frames, { raw: { width: 16, height: 24, channels: 3, pageHeight: 12 } as never })
      .gif({ loop: 0, delay: [100, 100] }).toBuffer();
    expect(anim.includes('NETSCAPE2.0')).toBe(true);
    const photo = withGifBlocks(anim, [
      gifExtension(0xfe, Buffer.from(IDENTIFYING.comment)),
      gifExtension(0xff, Buffer.concat([Buffer.from('XMP DataXMP', 'latin1'), Buffer.from(XMP_PACKET)])),
    ]);

    const { buffer, report } = stripImageMetadataBuffer(photo, 'image/gif');

    expect(report.removed).toEqual(expect.arrayContaining(['comment', 'xmp']));
    expect(containsAnyIdentifying(buffer)).toEqual([]);
    expect(buffer.includes('NETSCAPE2.0')).toBe(true);
    expect((await sharp(buffer, { animated: true }).metadata()).pages).toBe(2);
    expect(await pixels(buffer)).toEqual(await pixels(anim));
  });
});

describe('fail closed', () => {
  it('a JPEG header segment that overruns the file is refused, not stored as is', async () => {
    const photo = withJpegSegments(await sharp(solid).jpeg().toBuffer(), [exifApp1()]);
    const broken = Buffer.from(photo);
    broken.writeUInt16BE(0xfff0, 4); // first segment claims 64 KB
    const cut = broken.subarray(0, 600);
    expect(() => stripImageMetadataBuffer(cut, 'image/jpeg')).toThrow(ImageMetadataError);
  });

  it('a JPEG with no image data, a PNG with no IEND and a WebP whose RIFF size lies are refused', async () => {
    const jpegHeaderOnly = Buffer.concat([Buffer.from([0xff, 0xd8]), exifApp1()]);
    expect(() => stripImageMetadataBuffer(jpegHeaderOnly, 'image/jpeg')).toThrow(ImageMetadataError);
    const png = await sharp(solid).png().toBuffer();
    expect(() => stripImageMetadataBuffer(png.subarray(0, png.length - 12), 'image/png')).toThrow(ImageMetadataError);
    const webp = Buffer.from(await sharp(solid).webp().toBuffer());
    webp.writeUInt32LE(webp.length * 4, 4);
    expect(() => stripImageMetadataBuffer(webp, 'image/webp')).toThrow(ImageMetadataError);
  });

  it('carries a stable code and HTTP status for the route to return', () => {
    const e = new ImageMetadataError('x');
    expect(e.code).toBe('IMAGE_UNPARSEABLE');
    expect(e.statusCode).toBe(422);
  });
});

describe('stripImageMetadataFile (uploads on disk)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-imgmeta-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('rewrites a multi-megabyte photo in place, streaming across read windows, identical to the in-memory result', async () => {
    const big = withJpegSegments(await noiseJpeg(2400, 1800), [exifApp1(6), xmpApp1()]);
    expect(big.length).toBeGreaterThan(3 * (1 << 20)); // several 1 MiB windows
    const file = path.join(dir, 'photo.jpg');
    fs.writeFileSync(file, big);

    const report = await stripImageMetadataFile(file, 'image/jpeg');

    const onDisk = fs.readFileSync(file);
    expect(onDisk.equals(stripImageMetadataBuffer(big, 'image/jpeg').buffer)).toBe(true);
    expect(report).toMatchObject({ changed: true, orientation: 6, bytesBefore: big.length, bytesAfter: onDisk.length });
    expect(containsAnyIdentifying(onDisk)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(['photo.jpg']); // no temp file left
  });

  it('leaves non-image uploads and clean images untouched', async () => {
    const pdf = path.join(dir, 'doc.pdf');
    fs.writeFileSync(pdf, `%PDF-1.4 ${IDENTIFYING.author}`);
    expect((await stripImageMetadataFile(pdf, 'application/pdf')).changed).toBe(false);
    expect(fs.readFileSync(pdf, 'latin1')).toContain(IDENTIFYING.author);

    const clean = await sharp(solid).png().toBuffer();
    const png = path.join(dir, 'clean.png');
    fs.writeFileSync(png, clean);
    const before = fs.statSync(png).mtimeMs;
    expect((await stripImageMetadataFile(png, 'image/png')).changed).toBe(false);
    expect(fs.readFileSync(png).equals(clean)).toBe(true);
    expect(fs.statSync(png).mtimeMs).toBe(before);
  });

  it('an unparseable image throws and leaves no partial or temp file behind', async () => {
    const file = path.join(dir, 'bad.png');
    const png = await sharp(solid).png().toBuffer();
    fs.writeFileSync(file, png.subarray(0, png.length - 12));
    await expect(stripImageMetadataFile(file, 'image/png')).rejects.toBeInstanceOf(ImageMetadataError);
    expect(fs.readdirSync(dir)).toEqual(['bad.png']);
  });
});

describe('route-test fixtures (tests/helpers/tinyImages.ts)', () => {
  it.each([
    ['image/png', TINY_PNG], ['image/jpeg', TINY_JPEG], ['image/gif', TINY_GIF], ['image/webp', TINY_WEBP],
  ] as const)('%s is a real 2×2 image the walker accepts and leaves byte-identical', async (mime, img) => {
    const meta = await sharp(img).metadata();
    expect([meta.width, meta.height]).toEqual([2, 2]);
    const { buffer, report } = stripImageMetadataBuffer(img, mime);
    expect(report.changed).toBe(false);
    expect(buffer.equals(img)).toBe(true);
  });
});
