import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';

describe('uploadFileSafety', () => {
  it.each([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/gif', '.gif'],
    ['audio/mpeg', '.mp3'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ])('derives a canonical extension from MIME instead of the client filename (%s)', (mime, ext) => {
    expect(canonicalExtensionForMime(mime)).toBe(ext);
  });

  it('does not invent an extension for an unknown MIME type', () => {
    expect(canonicalExtensionForMime('application/x-bridge-unknown')).toBeNull();
  });

  it('accepts matching PNG bytes and rejects an HTML body declared as PNG', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-safety-'));
    const good = path.join(dir, 'good.bin');
    const bad = path.join(dir, 'bad.bin');
    try {
      fs.writeFileSync(good, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      fs.writeFileSync(bad, '<html><script>alert(1)</script></html>');
      expect(checkMagicBytes(good, 'image/png')).toBe(true);
      expect(checkMagicBytes(bad, 'image/png')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates soundboard signatures instead of trusting audio MIME headers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audio-safety-'));
    const ogg = path.join(dir, 'sound.bin');
    const fake = path.join(dir, 'fake.bin');
    try {
      fs.writeFileSync(ogg, Buffer.from('OggS\x00\x02', 'binary'));
      fs.writeFileSync(fake, 'not an ogg file');
      expect(checkMagicBytes(ogg, 'audio/ogg')).toBe(true);
      expect(checkMagicBytes(fake, 'audio/ogg')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
