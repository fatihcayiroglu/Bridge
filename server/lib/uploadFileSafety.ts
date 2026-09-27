import fs from 'fs';

/**
 * Canonical extension chosen from the server-accepted MIME type, never from the
 * client-controlled original filename. This keeps local and remote storage
 * content-type semantics aligned and prevents extension spoofing.
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z',
  'application/x-tar': '.tar',
  'application/gzip': '.gz',
  'application/json': '.json',
  'text/xml': '.xml',
  'application/xml': '.xml',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
});

export function canonicalExtensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? null;
}

type MagicRule = (buf: Buffer) => boolean;

const MAGIC_RULES: Readonly<Record<string, MagicRule>> = Object.freeze({
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/gif': b => b.subarray(0, 3).toString('ascii') === 'GIF',
  'image/webp': b => b.subarray(0, 4).toString('ascii') === 'RIFF'
    && b.subarray(8, 12).toString('ascii') === 'WEBP',
  'application/pdf': b => b.subarray(0, 4).toString('ascii') === '%PDF',
  'application/zip': b => b[0] === 0x50 && b[1] === 0x4b
    && ((b[2] === 0x03 && b[3] === 0x04)
      || (b[2] === 0x05 && b[3] === 0x06)
      || (b[2] === 0x07 && b[3] === 0x08)),
  'audio/mpeg': b => b.subarray(0, 3).toString('ascii') === 'ID3'
    || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  'audio/mp3': b => b.subarray(0, 3).toString('ascii') === 'ID3'
    || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  'audio/ogg': b => b.subarray(0, 4).toString('ascii') === 'OggS',
  'audio/wav': b => b.subarray(0, 4).toString('ascii') === 'RIFF'
    && b.subarray(8, 12).toString('ascii') === 'WAVE',
  'audio/x-wav': b => b.subarray(0, 4).toString('ascii') === 'RIFF'
    && b.subarray(8, 12).toString('ascii') === 'WAVE',
  'audio/flac': b => b.subarray(0, 4).toString('ascii') === 'fLaC',
  'audio/aac': b => b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0,
  'audio/webm': b => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
});

const MAGIC_OPTIONAL_PREFIXES = ['text/', 'video/'] as const;
const MAGIC_OPTIONAL_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'image/svg+xml',
  'image/tiff',
  'image/bmp',
  'audio/mp4',
]);

/**
 * Validate common file signatures where a stable signature is available.
 * Formats without a reliable fixed header remain scanner/parser validated by
 * their owning route, preserving compatibility rather than pretending a weak
 * signature is proof.
 */
export function checkMagicBytes(filePath: string, declaredMime: string): boolean {
  const mime = declaredMime.toLowerCase();
  if (MAGIC_OPTIONAL_PREFIXES.some(prefix => mime.startsWith(prefix)) || MAGIC_OPTIONAL_EXACT.has(mime)) {
    return true;
  }

  const rule = MAGIC_RULES[mime];
  if (!rule) return true;

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) return false;
    return rule(buf.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}
