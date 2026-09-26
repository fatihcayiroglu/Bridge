import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  inspectSoundboardAudio,
  isAllowedSoundboardDuration,
  SOUNDBOARD_MAX_FILE_BYTES,
} from '../lib/soundboardAudio';
import { BUILTIN_SOUNDBOARD_SOUNDS, findBuiltinSoundboardSound } from '../lib/soundboardCatalog';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sound-audio-'));
const put = (name: string, data: Buffer): string => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, data);
  return target;
};

function wav(seconds: number, malformedChunk = false): Buffer {
  const bytes = Math.max(1, Math.round(8_000 * seconds));
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF', 0); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(malformedChunk ? bytes + 100 : 16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8_000, 24);
  data.writeUInt32LE(8_000, 28); data.writeUInt16LE(1, 32); data.writeUInt16LE(8, 34);
  data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}

function mp3Frames(count: number, withId3 = false): Buffer {
  const frameLength = Math.floor(144 * 128_000 / 44_100);
  const frames = Array.from({ length: count }, () => {
    const frame = Buffer.alloc(frameLength);
    frame.set([0xff, 0xfb, 0x90, 0x00]);
    return frame;
  });
  return Buffer.concat(withId3 ? [Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), ...frames] : frames);
}

function aacFrames(count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, () => Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0xff, 0xfc])));
}

function flac(totalSamples = 4_410, withComment = false): Buffer {
  const data = Buffer.alloc(withComment ? 52 : 44);
  data.write('fLaC', 0); data[4] = withComment ? 0x00 : 0x80; data.writeUIntBE(34, 5, 3);
  const packed = (44_100n << 44n) | (0n << 41n) | (15n << 36n) | BigInt(totalSamples);
  data.writeBigUInt64BE(packed, 18);
  if (withComment) {
    data.set([0x84, 0x00, 0x00, 0x04], 42);
    data.write('test', 46);
  }
  data.set([0xff, 0xf8], withComment ? 50 : 42);
  return data;
}

function oggPage(payload: Buffer, granule: bigint): Buffer {
  const page = Buffer.alloc(28 + payload.length);
  page.write('OggS', 0); page[4] = 0; page.writeBigUInt64LE(granule, 6);
  page[26] = 1; page[27] = payload.length; payload.copy(page, 28);
  return page;
}

function opusOgg(): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0); head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10);
  return Buffer.concat([oggPage(head, 0n), oggPage(Buffer.from([0]), 48_312n)]);
}

function webm(): Buffer {
  const duration = Buffer.alloc(4); duration.writeFloatBE(1_000, 0);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from([0x42, 0x82, 0x84]), Buffer.from('webm'),
    Buffer.from([0x86, 0x86]), Buffer.from('A_OPUS'),
    Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]),
    Buffer.from([0x44, 0x89, 0x84]), duration,
  ]);
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('soundboard audio parser', () => {
  test.each([
    ['wav', wav(0.25), 'audio/wav', 'pcm'],
    ['wav-alias', wav(0.25), 'audio/x-wav', 'pcm'],
    ['mp3', mp3Frames(3, true), 'audio/mpeg', 'mpeg-layer-3'],
    ['mp3-alias', mp3Frames(2), 'audio/mp3', 'mpeg-layer-3'],
    ['aac', aacFrames(3), 'audio/aac', 'aac-2'],
    ['flac', flac(), 'audio/flac', 'flac'],
    ['flac-with-metadata', flac(4_410, true), 'audio/flac', 'flac'],
    ['ogg', opusOgg(), 'audio/ogg', 'opus'],
    ['webm', webm(), 'audio/webm', 'opus'],
  ])('accepts a structurally valid %s container', (name, bytes, mime, codec) => {
    const info = inspectSoundboardAudio(put(`${name}.audio`, bytes as Buffer), mime as string);
    expect(info).toEqual(expect.objectContaining({ codec }));
    expect(info!.durationSeconds).toBeGreaterThan(0);
    expect(isAllowedSoundboardDuration(info!)).toBe(true);
  });

  it('rejects truncated, mismatched, unsupported, empty, directory, and oversized inputs', () => {
    expect(inspectSoundboardAudio(put('bad-wav', wav(0.1, true)), 'audio/wav')).toBeNull();
    expect(inspectSoundboardAudio(put('one-frame', mp3Frames(1)), 'audio/mpeg')).toBeNull();
    expect(inspectSoundboardAudio(put('bad-aac', Buffer.from([0xff, 0xf1, 0x50])), 'audio/aac')).toBeNull();
    expect(inspectSoundboardAudio(put('bad-flac', Buffer.from('fLaC')), 'audio/flac')).toBeNull();
    expect(inspectSoundboardAudio(put('bad-ogg', Buffer.from('OggS')), 'audio/ogg')).toBeNull();
    expect(inspectSoundboardAudio(put('bad-webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'audio/webm')).toBeNull();
    expect(inspectSoundboardAudio(put('unknown', wav(0.1)), 'audio/x-unknown')).toBeNull();
    expect(inspectSoundboardAudio(put('empty', Buffer.alloc(0)), 'audio/wav')).toBeNull();
    expect(inspectSoundboardAudio(dir, 'audio/wav')).toBeNull();
    expect(inspectSoundboardAudio(path.join(dir, 'missing'), 'audio/wav')).toBeNull();
    expect(inspectSoundboardAudio(put('oversized', Buffer.alloc(SOUNDBOARD_MAX_FILE_BYTES + 1)), 'audio/wav')).toBeNull();
  });

  it('enforces duration separately from structural validity', () => {
    const info = inspectSoundboardAudio(put('long.wav', wav(5.01)), 'audio/wav');
    expect(info).not.toBeNull();
    expect(isAllowedSoundboardDuration(info!)).toBe(false);
  });
});

describe('trusted built-in catalog', () => {
  it('is immutable, unique, exact-match only, and uses no deployable file URL', () => {
    expect(Object.isFrozen(BUILTIN_SOUNDBOARD_SOUNDS)).toBe(true);
    expect(new Set(BUILTIN_SOUNDBOARD_SOUNDS.map(sound => sound._id)).size).toBe(BUILTIN_SOUNDBOARD_SOUNDS.length);
    for (const sound of BUILTIN_SOUNDBOARD_SOUNDS) {
      expect(Object.isFrozen(sound)).toBe(true);
      expect(sound.scope).toBe('global');
      expect(sound.url).toBe(`bridge-sound:${sound._id.slice('global:'.length)}`);
      expect(findBuiltinSoundboardSound(sound._id)).toBe(sound);
    }
    expect(findBuiltinSoundboardSound('global:CHIME')).toBeNull();
    expect(findBuiltinSoundboardSound('bridge-sound:chime')).toBeNull();
  });

  it('declares the exact duration of the client-generated 90 ms tone segments', () => {
    expect(Object.fromEntries(BUILTIN_SOUNDBOARD_SOUNDS.map(sound => [sound._id, sound.durationSeconds]))).toEqual({
      'global:chime': 0.27,
      'global:pop': 0.18,
      'global:drum': 0.18,
      'global:notify': 0.18,
    });
  });
});
