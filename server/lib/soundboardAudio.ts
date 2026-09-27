import fs from 'fs';

export const SOUNDBOARD_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SOUNDBOARD_MAX_DURATION_SECONDS = 5;

export interface SoundboardAudioInfo {
  container: 'mp3' | 'ogg' | 'wav' | 'aac' | 'flac' | 'webm';
  codec: string;
  durationSeconds: number;
}

function finiteDuration(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function inspectWav(data: Buffer): SoundboardAudioInfo | null {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null;
  if (data.readUInt32LE(4) !== data.length - 8) return null;
  let offset = 12;
  let byteRate = 0;
  let codec = '';
  let dataBytes = 0;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > data.length - body) return null;
    if (id === 'fmt ' && size >= 16) {
      const format = data.readUInt16LE(body);
      const channels = data.readUInt16LE(body + 2);
      const sampleRate = data.readUInt32LE(body + 4);
      byteRate = data.readUInt32LE(body + 8);
      if (![1, 3].includes(format) || channels < 1 || channels > 8 || sampleRate < 8_000 || sampleRate > 192_000 || byteRate === 0) return null;
      codec = format === 1 ? 'pcm' : 'ieee-float';
    } else if (id === 'data') {
      dataBytes += size;
    }
    offset = body + size + (size & 1);
  }
  const durationSeconds = finiteDuration(dataBytes / byteRate);
  return offset === data.length && codec && durationSeconds ? { container: 'wav', codec, durationSeconds } : null;
}

function synchsafe(data: Buffer, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  const bytes = [...data.subarray(offset, offset + 4)];
  if (bytes.some(value => (value & 0x80) !== 0)) return null;
  return ((bytes[0]! << 21) | (bytes[1]! << 14) | (bytes[2]! << 7) | bytes[3]!) >>> 0;
}

function inspectMp3(data: Buffer): SoundboardAudioInfo | null {
  let offset = 0;
  if (data.toString('ascii', 0, 3) === 'ID3') {
    if (data.length < 10) return null;
    const tagSize = synchsafe(data, 6);
    if (tagSize === null) return null;
    offset = 10 + tagSize + ((data[5]! & 0x10) ? 10 : 0);
  }
  if (offset + 4 > data.length || data[offset] !== 0xff || (data[offset + 1]! & 0xe0) !== 0xe0) return null;
  let frames = 0;
  let totalSeconds = 0;
  while (offset + 4 <= data.length) {
    if (data.toString('ascii', offset, offset + 3) === 'TAG' && data.length - offset >= 128) break;
    const a = data[offset]!;
    const b = data[offset + 1]!;
    if (a !== 0xff || (b & 0xe0) !== 0xe0) {
      if (frames > 0 || ++offset > 1_048_576) return null;
      continue;
    }
    const versionBits = (b >> 3) & 0x03;
    const layerBits = (b >> 1) & 0x03;
    const c = data[offset + 2]!;
    const bitrateIndex = (c >> 4) & 0x0f;
    const sampleIndex = (c >> 2) & 0x03;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
    const version1 = versionBits === 3;
    const rates = version1
      ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const baseSamples = [44_100, 48_000, 32_000];
    const divisor = version1 ? 1 : versionBits === 2 ? 2 : 4;
    const bitrate = rates[bitrateIndex - 1]! * 1_000;
    const sampleRate = baseSamples[sampleIndex]! / divisor;
    const padding = (c >> 1) & 1;
    const frameLength = Math.floor((version1 ? 144 : 72) * bitrate / sampleRate) + padding;
    if (frameLength < 24 || offset + frameLength > data.length) return null;
    totalSeconds += (version1 ? 1152 : 576) / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  const durationSeconds = finiteDuration(totalSeconds);
  return frames >= 2 && durationSeconds ? { container: 'mp3', codec: 'mpeg-layer-3', durationSeconds } : null;
}

function inspectAac(data: Buffer): SoundboardAudioInfo | null {
  const sampleRates = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];
  let offset = 0;
  let frames = 0;
  let totalSeconds = 0;
  let codec = '';
  while (offset + 7 <= data.length) {
    if (data[offset] !== 0xff || (data[offset + 1]! & 0xf6) !== 0xf0) return null;
    const profile = ((data[offset + 2]! >> 6) & 0x03) + 1;
    const sampleIndex = (data[offset + 2]! >> 2) & 0x0f;
    const sampleRate = sampleRates[sampleIndex];
    const channels = ((data[offset + 2]! & 1) << 2) | ((data[offset + 3]! >> 6) & 3);
    const frameLength = ((data[offset + 3]! & 3) << 11) | (data[offset + 4]! << 3) | ((data[offset + 5]! >> 5) & 7);
    if (!sampleRate || channels === 0 || frameLength < 7 || offset + frameLength > data.length) return null;
    codec = `aac-${profile}`;
    totalSeconds += 1024 / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  const durationSeconds = finiteDuration(totalSeconds);
  return offset === data.length && frames >= 2 && durationSeconds ? { container: 'aac', codec, durationSeconds } : null;
}

function inspectFlac(data: Buffer): SoundboardAudioInfo | null {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'fLaC') return null;
  let offset = 4;
  let lastMetadataBlock = false;
  let sampleRate = 0;
  let channels = 0;
  let totalSamples = 0;
  while (!lastMetadataBlock) {
    if (offset + 4 > data.length) return null;
    const header = data[offset]!;
    const blockType = header & 0x7f;
    const length = data.readUIntBE(offset + 1, 3);
    const body = offset + 4;
    if (length > data.length - body) return null;
    // STREAMINFO is mandatory, unique, and must be the first metadata block.
    if (offset === 4) {
      if (blockType !== 0 || length !== 34) return null;
      const packed = data.readBigUInt64BE(body + 10);
      sampleRate = Number((packed >> 44n) & 0xfffffn);
      channels = Number((packed >> 41n) & 0x7n) + 1;
      totalSamples = Number(packed & 0xfffffffffn);
    } else if (blockType === 0) {
      return null;
    }
    lastMetadataBlock = (header & 0x80) !== 0;
    offset = body + length;
  }
  if (sampleRate < 8_000 || sampleRate > 655_350 || channels < 1 || channels > 8 || totalSamples < 1
    || offset + 2 > data.length || data[offset] !== 0xff || (data[offset + 1]! & 0xfc) !== 0xf8) return null;
  const durationSeconds = finiteDuration(totalSamples / sampleRate);
  return durationSeconds ? { container: 'flac', codec: 'flac', durationSeconds } : null;
}

function inspectOgg(data: Buffer): SoundboardAudioInfo | null {
  let offset = 0;
  let maxGranule = 0n;
  let codec = '';
  let sampleRate = 0;
  let preSkip = 0;
  while (offset + 27 <= data.length) {
    if (data.toString('ascii', offset, offset + 4) !== 'OggS' || data[offset + 4] !== 0) return null;
    const segments = data[offset + 26]!;
    if (offset + 27 + segments > data.length) return null;
    let payloadLength = 0;
    for (let i = 0; i < segments; i += 1) payloadLength += data[offset + 27 + i]!;
    const payload = offset + 27 + segments;
    if (payload + payloadLength > data.length) return null;
    const granule = data.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule > maxGranule) maxGranule = granule;
    if (!codec) {
      const packet = data.subarray(payload, payload + payloadLength);
      if (packet.toString('ascii', 0, 8) === 'OpusHead' && packet.length >= 19) {
        codec = 'opus'; sampleRate = 48_000; preSkip = packet.readUInt16LE(10);
      } else if (packet[0] === 1 && packet.toString('ascii', 1, 7) === 'vorbis' && packet.length >= 16) {
        codec = 'vorbis'; sampleRate = packet.readUInt32LE(12);
      } else {
        return null;
      }
    }
    offset = payload + payloadLength;
  }
  const durationSeconds = finiteDuration((Number(maxGranule) - preSkip) / sampleRate);
  return offset === data.length && codec && durationSeconds ? { container: 'ogg', codec, durationSeconds } : null;
}

function readVint(data: Buffer, offset: number): { value: number; length: number } | null {
  if (offset >= data.length) return null;
  let marker = 0x80;
  let length = 1;
  while (length <= 8 && (data[offset]! & marker) === 0) { marker >>= 1; length += 1; }
  if (length > 8 || offset + length > data.length) return null;
  let value = data[offset]! & (marker - 1);
  for (let i = 1; i < length; i += 1) value = value * 256 + data[offset + i]!;
  return Number.isSafeInteger(value) ? { value, length } : null;
}

function elementPayload(data: Buffer, id: Buffer): Buffer | null {
  const position = data.indexOf(id);
  if (position < 0) return null;
  const size = readVint(data, position + id.length);
  if (!size) return null;
  const start = position + id.length + size.length;
  return start + size.value <= data.length ? data.subarray(start, start + size.value) : null;
}

function inspectWebm(data: Buffer): SoundboardAudioInfo | null {
  if (data.length < 16 || !data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return null;
  const docType = elementPayload(data, Buffer.from([0x42, 0x82]));
  const codecId = elementPayload(data, Buffer.from([0x86]));
  const duration = elementPayload(data, Buffer.from([0x44, 0x89]));
  const scale = elementPayload(data, Buffer.from([0x2a, 0xd7, 0xb1]));
  if (docType?.toString('ascii') !== 'webm' || !codecId || !duration || ![4, 8].includes(duration.length)) return null;
  const codec = codecId.toString('ascii');
  if (!['A_OPUS', 'A_VORBIS'].includes(codec)) return null;
  const durationUnits = duration.length === 4 ? duration.readFloatBE(0) : duration.readDoubleBE(0);
  let timecodeScale = 1_000_000;
  if (scale) {
    if (scale.length < 1 || scale.length > 4) return null;
    timecodeScale = scale.readUIntBE(0, scale.length);
  }
  const durationSeconds = finiteDuration(durationUnits * timecodeScale / 1_000_000_000);
  return durationSeconds ? { container: 'webm', codec: codec.slice(2).toLowerCase(), durationSeconds } : null;
}

export function inspectSoundboardAudio(filePath: string, declaredMime: string): SoundboardAudioInfo | null {
  let data: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > SOUNDBOARD_MAX_FILE_BYTES) return null;
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  switch (declaredMime.toLowerCase()) {
    case 'audio/mpeg':
    case 'audio/mp3': return inspectMp3(data);
    case 'audio/ogg': return inspectOgg(data);
    case 'audio/wav':
    case 'audio/x-wav': return inspectWav(data);
    case 'audio/aac': return inspectAac(data);
    case 'audio/flac': return inspectFlac(data);
    case 'audio/webm': return inspectWebm(data);
    default: return null;
  }
}

export function isAllowedSoundboardDuration(info: SoundboardAudioInfo): boolean {
  return info.durationSeconds <= SOUNDBOARD_MAX_DURATION_SECONDS;
}
