// e2e/tests/image-metadata.spec.ts — P7 B3: what a phone writes into a photo
// never reaches anyone else.
//
// Real images carrying the metadata a phone writes (EXIF GPS + device + serial,
// text chunks, comments) go through the real upload routes of a real server, and
// the bytes the server then SERVES are inspected:
//   · the identifying strings are gone;
//   · the picture is intact — compressed image data byte-identical, a JPEG keeps
//     its display orientation (and only it), an animated GIF keeps every frame and
//     its loop;
//   · an image whose container cannot be walked is refused (422), never stored;
//   · authorization is unchanged — a stranger still cannot read an attachment.
// The lossless walker itself is unit-tested in server/tests/image-metadata.test.ts.

import { test, expect } from '../helpers/apiTest';
import { request as pwRequest } from '@playwright/test';
import { getTokens, registerFreshUser } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

const SECRET = {
  make: 'BridgeE2ECam',
  model: 'Model-E2E-7',
  serial: 'SN-E2E-PRIVATE-9311',
  comment: 'e2e-secret-comment',
  author: 'e2e-secret-author',
} as const;
const leaked = (buf: Buffer) => Object.values(SECRET).filter((s) => buf.includes(s));

// ── Real base images (each decodes; built the same way as server/tests/helpers/tinyImages.ts) ──
const JPEG = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAaEAACAwEBAAAAAAAAAAAAAAABAgADBAUS/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABkRAAIDAQAAAAAAAAAAAAAAAAABAgMycf/aAAwDAQACEQMRAD8ArOLlzvxMDPRUzNmrJJQEk+RERDp6YTZt9P/Z',
  'base64');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQI12M4IWcDRAwQCgAh9gSJ1exUdAAAAABJRU5ErkJggg==',
  'base64');
/** 1×1, two frames (black, white), NETSCAPE2.0 loop forever — a real animated GIF. */
const ANIMATED_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==',
  'base64');

// ── EXIF as a phone writes it (big-endian TIFF: IFD0 → Exif IFD + GPS IFD) ──
type Entry = { tag: number; type: number; count: number; value: Buffer };
const ascii = (tag: number, s: string): Entry => ({ tag, type: 2, count: s.length + 1, value: Buffer.from(s + '\0', 'latin1') });
const u16 = (tag: number, v: number): Entry => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return { tag, type: 3, count: 1, value: b }; };
const u32 = (tag: number, v: number): Entry => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return { tag, type: 4, count: 1, value: b }; };
const rationals = (tag: number, parts: Array<[number, number]>): Entry => {
  const b = Buffer.alloc(parts.length * 8);
  parts.forEach(([n, d], i) => { b.writeUInt32BE(n, i * 8); b.writeUInt32BE(d, i * 8 + 4); });
  return { tag, type: 5, count: parts.length, value: b };
};
function ifd(entries: Entry[], at: number): Buffer {
  entries.sort((a, b) => a.tag - b.tag);
  const table = Buffer.alloc(2 + entries.length * 12 + 4);
  const extra: Buffer[] = [];
  let dataAt = at + table.length;
  table.writeUInt16BE(entries.length, 0);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    table.writeUInt16BE(e.tag, o); table.writeUInt16BE(e.type, o + 2); table.writeUInt32BE(e.count, o + 4);
    if (e.value.length <= 4) e.value.copy(table, o + 8);
    else {
      table.writeUInt32BE(dataAt, o + 8);
      const padded = e.value.length & 1 ? Buffer.concat([e.value, Buffer.alloc(1)]) : e.value;
      extra.push(padded); dataAt += padded.length;
    }
  });
  return Buffer.concat([table, ...extra]);
}
function phoneTiff(orientation: number): Buffer {
  const ifd0 = (exifAt: number, gpsAt: number) => [ascii(0x010f, SECRET.make), ascii(0x0110, SECRET.model), u16(0x0112, orientation), u32(0x8769, exifAt), u32(0x8825, gpsAt)];
  const exifAt = 8 + ifd(ifd0(0, 0), 8).length;
  const exif = [ascii(0xa431, SECRET.serial), ascii(0x9003, '2026:10:09 07:15:00')];
  const gpsAt = exifAt + ifd(exif, exifAt).length;
  const gps = [ascii(0x0001, 'N'), rationals(0x0002, [[41, 1], [0, 1], [3612, 100]]), ascii(0x0003, 'E'), rationals(0x0004, [[28, 1], [58, 1], [4518, 100]])];
  return Buffer.concat([Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]), ifd(ifd0(exifAt, gpsAt), 8), ifd(exif, exifAt), ifd(gps, gpsAt)]);
}
const jpegSegment = (marker: number, payload: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};
/** Segments before the first SOS: [marker, payload]. */
function jpegSegments(jpeg: Buffer): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = [];
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const m = jpeg[pos + 1]!; const len = jpeg.readUInt16BE(pos + 2);
    out.push([m, jpeg.subarray(pos + 4, pos + 2 + len)]);
    if (m === 0xda) break;
    pos += 2 + len;
  }
  return out;
}
/** Everything from the first SOS on — the compressed image data. */
const jpegScan = (jpeg: Buffer) => { const at = jpeg.indexOf(Buffer.from([0xff, 0xda])); return jpeg.subarray(at); };
function ifd0Tags(tiff: Buffer): Map<number, number> {
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const r16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const r32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const at = r32(4); const tags = new Map<number, number>();
  for (let i = 0; i < r16(at); i++) { const e = at + 2 + i * 12; tags.set(r16(e), r16(e + 2) === 3 ? r16(e + 8) : r32(e + 8)); }
  return tags;
}

// ── PNG / GIF ──
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngChunks(png: Buffer): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = []; let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos); const type = png.toString('latin1', pos + 4, pos + 8);
    out.push([type, png.subarray(pos + 8, pos + 8 + len)]); pos += 12 + len;
  }
  return out;
}
/** Inserts chunks right after IHDR. */
const withPngChunks = (png: Buffer, chunks: Buffer[]) => { const at = 8 + 12 + png.readUInt32BE(8); return Buffer.concat([png.subarray(0, at), ...chunks, png.subarray(at)]); };
const gifComment = (text: string) => Buffer.concat([Buffer.from([0x21, 0xfe, text.length]), Buffer.from(text, 'latin1'), Buffer.from([0])]);
/** Inserts blocks after the header, logical screen descriptor and global colour table. */
const withGifBlocks = (gif: Buffer, blocks: Buffer[]) => { const f = gif[10]!; const at = 13 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0); return Buffer.concat([gif.subarray(0, at), ...blocks, gif.subarray(at)]); };
/** Walks a GIF's blocks: frame count, comment-extension count, NETSCAPE loop present. */
function gifStructure(gif: Buffer): { frames: number; comments: number; loop: boolean } {
  const f = gif[10]!; let pos = 13 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0);
  let frames = 0, comments = 0, loop = false;
  const skipSubBlocks = () => { while (gif[pos]! !== 0) pos += 1 + gif[pos]!; pos += 1; };
  while (pos < gif.length) {
    const b = gif[pos]!;
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = gif[pos + 1]!;
      if (label === 0xfe) comments++;
      if (label === 0xff && gif.toString('latin1', pos + 3, pos + 14) === 'NETSCAPE2.0') loop = true;
      pos += 2; skipSubBlocks();
    } else if (b === 0x2c) {
      frames++;
      const lf = gif[pos + 9]!; pos += 10 + (lf & 0x80 ? 3 * (1 << ((lf & 7) + 1)) : 0);
      pos += 1; skipSubBlocks();
    } else throw new Error(`unexpected GIF block 0x${b.toString(16)} at ${pos}`);
  }
  return { frames, comments, loop };
}

async function attach(request: import('@playwright/test').APIRequestContext, token: string, file: Buffer, name: string, mimeType: string) {
  return request.post(`${BASE}/api/upload`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { file: { name, mimeType, buffer: file } },
  });
}
async function served(request: import('@playwright/test').APIRequestContext, url: string, token: string): Promise<Buffer> {
  const res = await request.get(`${BASE}${url}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status(), `GET ${url}`).toBe(200);
  return Buffer.from(await res.body());
}

test.describe('P7 B3 — uploaded images lose identifying metadata, not their picture', () => {
  let tokens: ReturnType<typeof getTokens>;
  test.beforeAll(() => { tokens = getTokens(); });

  test('a phone photo attachment: GPS, device, serial, capture time and comment are gone; orientation and image data stay', async ({ request }) => {
    const photo = Buffer.concat([JPEG.subarray(0, 2),
      jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), phoneTiff(6)])),
      jpegSegment(0xfe, Buffer.from(SECRET.comment, 'latin1')),
      JPEG.subarray(2)]);
    expect(leaked(photo).length, 'the fixture really carries the metadata').toBe(4);

    const up = await attach(request, tokens.alice, photo, 'phone.jpg', 'image/jpeg');
    expect(up.status(), await up.text()).toBe(200);
    const body = await up.json() as { url: string; size: number; fileType: string };
    expect(body.fileType).toBe('image/jpeg');

    const out = await served(request, body.url, tokens.alice);
    expect(leaked(out)).toEqual([]);
    expect(out.length, 'reported size is the stored size').toBe(body.size);
    expect(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(jpegScan(out).equals(jpegScan(JPEG)), 'compressed image data byte-identical').toBe(true);
    const exif = jpegSegments(out).filter(([m, p]) => m === 0xe1 && p.toString('latin1', 0, 6) === 'Exif\0\0');
    expect(exif).toHaveLength(1);
    expect([...ifd0Tags(exif[0]![1].subarray(6)).entries()], 'only the display orientation survives').toEqual([[0x0112, 6]]);
    expect(jpegSegments(out).some(([m]) => m === 0xfe), 'no comment segment').toBe(false);
  });

  test('an avatar PNG loses its text chunks; the image data is byte-identical', async ({ request }) => {
    const who = await registerFreshUser(request, 'b3avatar');
    const png = withPngChunks(PNG, [
      pngChunk('tEXt', Buffer.from(`Author\0${SECRET.author}`, 'latin1')),
      pngChunk('tEXt', Buffer.from(`Comment\0${SECRET.comment}`, 'latin1')),
    ]);
    expect(leaked(png).length).toBe(2);

    const up = await request.post(`${BASE}/api/me/avatar`, {
      headers: { Authorization: `Bearer ${who.token}` },
      multipart: { avatar: { name: 'me.png', mimeType: 'image/png', buffer: png } },
    });
    expect(up.status(), await up.text()).toBe(200);
    const { avatarUrl } = await up.json() as { avatarUrl: string };
    expect(avatarUrl).toMatch(/^\/uploads\/avatars\//);

    const out = await served(request, avatarUrl, who.token);
    expect(leaked(out)).toEqual([]);
    const types = pngChunks(out).map(([t]) => t);
    expect(types).not.toContain('tEXt');
    expect(types[0]).toBe('IHDR');
    expect(types.at(-1)).toBe('IEND');
    const idat = (b: Buffer) => Buffer.concat(pngChunks(b).filter(([t]) => t === 'IDAT').map(([, d]) => d));
    expect(idat(out).equals(idat(PNG)), 'image data byte-identical').toBe(true);
  });

  test('an animated GIF keeps both frames and its loop; its comment is gone', async ({ request }) => {
    const gif = withGifBlocks(ANIMATED_GIF, [gifComment(SECRET.comment)]);
    expect(gifStructure(gif)).toEqual({ frames: 2, comments: 1, loop: true });

    const up = await attach(request, tokens.alice, gif, 'loop.gif', 'image/gif');
    expect(up.status(), await up.text()).toBe(200);
    const { url } = await up.json() as { url: string };
    const out = await served(request, url, tokens.alice);
    expect(leaked(out)).toEqual([]);
    expect(gifStructure(out)).toEqual({ frames: 2, comments: 0, loop: true });
  });

  test('an image whose container cannot be walked is refused, never stored as is', async ({ request }) => {
    // A valid PNG signature (so the type check passes) followed by a chunk that overruns the file.
    const broken = Buffer.concat([PNG.subarray(0, 8), Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('IHDR'), Buffer.alloc(8)]);
    const up = await attach(request, tokens.alice, broken, 'broken.png', 'image/png');
    expect(up.status(), await up.text()).toBe(422);
    expect(await up.json()).toMatchObject({ code: 'IMAGE_UNPARSEABLE' });
  });

  test('authorization is unchanged: a stripped attachment is still private to its audience', async ({ request }) => {
    const up = await attach(request, tokens.alice, JPEG, 'private.jpg', 'image/jpeg');
    expect(up.status(), await up.text()).toBe(200);
    const { url } = await up.json() as { url: string };
    // An explicitly EMPTY session: newContext() otherwise inherits the project's
    // storageState, whose media cookie is alice's (same as remote-storage.spec).
    const stranger = await pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      // carol shares no server or DM with alice.
      expect((await stranger.get(`${BASE}${url}`, { headers: { Authorization: `Bearer ${tokens.carol}` } })).status()).toBe(403);
      expect((await stranger.get(`${BASE}${url}`)).status()).toBe(401);
    } finally { await stranger.dispose(); }
    expect((await served(request, url, tokens.alice)).equals(JPEG), 'a clean image is served byte-identical').toBe(true);
  });
});
