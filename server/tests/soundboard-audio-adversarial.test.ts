// server/tests/soundboard-audio-adversarial.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/soundboardAudio.ts — YÜKLEME GÜVENLİK SINIRININ RET DALLARI
// ════════════════════════════════════════════════════════════════════════════
// Bu ayrıştırıcı, `routes/soundboard.ts` içinde sihirli bayt kontrolünden SONRA
// çalışan İKİNCİ kapıdır: bir dosyanın gerçekten desteklenen bir ses konteyneri
// olduğunu ve süre bütçesine uyduğunu kanıtlar. Kabul edilen her dosya kalıcı
// depolamaya yazılır ve `/uploads/soundboard/...` altından SUNULUR.
//
// Dolayısıyla buradaki her `return null` bir GÜVENLİK KARARIDIR. Yalnızca mutlu
// yolu ölçmek, "her şeyi kabul eden" bir ayrıştırıcıyla da yeşil kalırdı; bu
// dosya bilinçli olarak YAPISAL OLARAK BOZUK ve SINIR DEĞERLİ girdileri
// kullanır ve her birinin reddedildiğini kanıtlar.
//
// Sihirli bayt imzası ile yapısal geçerlilik AYNI ŞEY DEĞİLDİR: aşağıdaki
// girdilerin çoğu doğru sihirli baytlarla başlar (yani `checkMagicBytes`'ı
// geçer) ve yine de reddedilmelidir.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspectSoundboardAudio } from '../lib/soundboardAudio';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sound-adv-'));
let seq = 0;
function inspect(bytes: Buffer, mime: string): ReturnType<typeof inspectSoundboardAudio> {
  const target = path.join(dir, `case-${seq += 1}.bin`);
  fs.writeFileSync(target, bytes);
  return inspectSoundboardAudio(target, mime);
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// ── WAV ─────────────────────────────────────────────────────────────────────
interface WavOptions {
  format?: number; channels?: number; sampleRate?: number; byteRate?: number;
  dataBytes?: number; riffSize?: number | null; magic?: string; waveTag?: string;
  omitData?: boolean; trailing?: number;
}
function wav(options: WavOptions = {}): Buffer {
  const {
    format = 1, channels = 1, sampleRate = 8_000, byteRate = 8_000,
    dataBytes = 2_000, magic = 'RIFF', waveTag = 'WAVE', omitData = false, trailing = 0,
  } = options;
  const payload = omitData ? 0 : dataBytes;
  const size = (omitData ? 36 : 44 + payload) + trailing;
  const data = Buffer.alloc(size);
  data.write(magic, 0);
  data.writeUInt32LE(options.riffSize ?? size - 8, 4);
  data.write(waveTag, 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(format, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(byteRate, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  if (!omitData) { data.write('data', 36); data.writeUInt32LE(payload, 40); }
  if (trailing > 0) data.fill(0x41, size - trailing);
  return data;
}

describe('WAV container rejection boundaries', () => {
  it('rejects wrong magic, wrong WAVE tag and a RIFF size that disagrees with the file', () => {
    expect(inspect(wav({ magic: 'RIFX' }), 'audio/wav')).toBeNull();
    expect(inspect(wav({ waveTag: 'AVI ' }), 'audio/wav')).toBeNull();
    // Beyan edilen RIFF uzunluğu ile GERÇEK dosya uzunluğu ayrışırsa, dosyaya
    // konteyner dışında veri eklenmiş olabilir (polyglot); kabul edilmez.
    expect(inspect(wav({ riffSize: 12 }), 'audio/wav')).toBeNull();
    // Kanonik veri parçasından SONRA eklenmiş baytlar, geçerli bir RIFF parça
    // zinciri oluşturmadıkları için reddedilir (polyglot kaçakçılığı).
    expect(inspect(wav({ trailing: 64 }), 'audio/wav')).toBeNull();
  });

  it('rejects every out-of-range fmt field', () => {
    expect(inspect(wav({ format: 2 }), 'audio/wav')).toBeNull();
    expect(inspect(wav({ channels: 0 }), 'audio/wav')).toBeNull();
    expect(inspect(wav({ channels: 9 }), 'audio/wav')).toBeNull();
    expect(inspect(wav({ sampleRate: 7_999 }), 'audio/wav')).toBeNull();
    expect(inspect(wav({ sampleRate: 192_001 }), 'audio/wav')).toBeNull();
    expect(inspect(wav({ byteRate: 0 }), 'audio/wav')).toBeNull();
  });

  it('accepts IEEE float PCM and reports its codec distinctly from integer PCM', () => {
    expect(inspect(wav({ format: 3 }), 'audio/wav')).toEqual(
      expect.objectContaining({ container: 'wav', codec: 'ieee-float' }),
    );
    expect(inspect(wav({ format: 1 }), 'audio/wav')).toEqual(
      expect.objectContaining({ container: 'wav', codec: 'pcm' }),
    );
  });

  it('rejects a structurally valid header that carries no audio at all', () => {
    // fmt var, data yok → süre 0. Sıfır uzunluklu bir "ses", çalınamayacağı
    // hâlde kütüphaneyi kirletirdi.
    expect(inspect(wav({ omitData: true }), 'audio/wav')).toBeNull();
    expect(inspect(wav({ dataBytes: 0 }), 'audio/wav')).toBeNull();
  });
});

// ── MP3 ─────────────────────────────────────────────────────────────────────
function mp3Frame(headerByte1: number, headerByte2 = 0x90, length?: number): Buffer {
  const version1 = ((headerByte1 >> 3) & 3) === 3;
  const versionBits = (headerByte1 >> 3) & 3;
  const rates = version1
    ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrateIndex = (headerByte2 >> 4) & 0x0f;
  const sampleIndex = (headerByte2 >> 2) & 0x03;
  const divisor = version1 ? 1 : versionBits === 2 ? 2 : 4;
  const computed = rates[bitrateIndex - 1] !== undefined && sampleIndex !== 3
    ? Math.floor((version1 ? 144 : 72) * rates[bitrateIndex - 1]! * 1_000 / ([44_100, 48_000, 32_000][sampleIndex]! / divisor))
    : 32;
  const frame = Buffer.alloc(length ?? computed);
  frame.set([0xff, headerByte1, headerByte2, 0x00]);
  return frame;
}
const MPEG1 = 0xfb;
const MPEG2 = 0xf3;
const MPEG25 = 0xe3;
const RESERVED_VERSION = 0xeb;

describe('MPEG frame-walk rejection boundaries', () => {
  it('walks MPEG-2 and MPEG-2.5 frames with their own bitrate table and sample count', () => {
    const v2 = inspect(Buffer.concat([mp3Frame(MPEG2), mp3Frame(MPEG2)]), 'audio/mpeg');
    expect(v2).toEqual(expect.objectContaining({ container: 'mp3', codec: 'mpeg-layer-3' }));
    const v25 = inspect(Buffer.concat([mp3Frame(MPEG25), mp3Frame(MPEG25)]), 'audio/mpeg');
    expect(v25).toEqual(expect.objectContaining({ container: 'mp3' }));
    // MPEG-2.5 aynı bitrate indeksinde YARISI kadar örnekleme hızı kullanır;
    // dolayısıyla aynı kare sayısı DAHA UZUN sürer. Tek bir tablo kullanan bir
    // ayrıştırıcı süre bütçesini yanlış hesaplardı.
    expect(v25!.durationSeconds).toBeGreaterThan(v2!.durationSeconds);
  });

  it('rejects reserved version, wrong layer and reserved bitrate/sample indexes', () => {
    expect(inspect(Buffer.concat([mp3Frame(RESERVED_VERSION), mp3Frame(RESERVED_VERSION)]), 'audio/mpeg')).toBeNull();
    expect(inspect(Buffer.concat([mp3Frame(0xfd), mp3Frame(0xfd)]), 'audio/mpeg')).toBeNull(); // layer II
    expect(inspect(Buffer.concat([mp3Frame(MPEG1, 0x00), mp3Frame(MPEG1, 0x00)]), 'audio/mpeg')).toBeNull();
    expect(inspect(Buffer.concat([mp3Frame(MPEG1, 0xf0), mp3Frame(MPEG1, 0xf0)]), 'audio/mpeg')).toBeNull();
    expect(inspect(Buffer.concat([mp3Frame(MPEG1, 0x9c), mp3Frame(MPEG1, 0x9c)]), 'audio/mpeg')).toBeNull();
  });

  it('rejects a declared frame that runs past the end of the file', () => {
    const truncated = Buffer.concat([mp3Frame(MPEG1), mp3Frame(MPEG1).subarray(0, 40)]);
    expect(inspect(truncated, 'audio/mpeg')).toBeNull();
  });

  it('rejects trailing garbage after a valid frame instead of silently accepting it', () => {
    const smuggled = Buffer.concat([mp3Frame(MPEG1), mp3Frame(MPEG1), Buffer.alloc(64, 0x41)]);
    expect(inspect(smuggled, 'audio/mpeg')).toBeNull();
  });

  it('stops cleanly at a full ID3v1 TAG footer but refuses a truncated one', () => {
    const frames = Buffer.concat([mp3Frame(MPEG1), mp3Frame(MPEG1)]);
    const tag = Buffer.alloc(128); tag.write('TAG', 0);
    expect(inspect(Buffer.concat([frames, tag]), 'audio/mpeg')).toEqual(
      expect.objectContaining({ container: 'mp3' }),
    );
    expect(inspect(Buffer.concat([frames, tag.subarray(0, 100)]), 'audio/mpeg')).toBeNull();
  });

  it('honours the ID3v2 footer flag and rejects malformed synchsafe tag sizes', () => {
    const frames = Buffer.concat([mp3Frame(MPEG1), mp3Frame(MPEG1)]);
    const withFooter = Buffer.alloc(20); // 10 başlık + 10 altbilgi
    withFooter.write('ID3', 0); withFooter[5] = 0x10; // footer present
    withFooter.writeUInt32BE(0, 6); // synchsafe size 0
    expect(inspect(Buffer.concat([withFooter, frames]), 'audio/mpeg')).toEqual(
      expect.objectContaining({ container: 'mp3' }),
    );

    const badSynchsafe = Buffer.alloc(10);
    badSynchsafe.write('ID3', 0); badSynchsafe.writeUInt32BE(0x80_00_00_00, 6);
    expect(inspect(Buffer.concat([badSynchsafe, frames]), 'audio/mpeg')).toBeNull();

    // ID3 imzası var ama başlık bile tamamlanmamış.
    expect(inspect(Buffer.from('ID3\x03\x00'), 'audio/mpeg')).toBeNull();
    // Synchsafe alanı dosya sonuna taşıyor.
    expect(inspect(Buffer.from('ID3\x03\x00\x00\x00\x00'), 'audio/mpeg')).toBeNull();
  });
});

// ── AAC (ADTS) ──────────────────────────────────────────────────────────────
function adts(overrides: { byte1?: number; byte2?: number; byte3?: number; byte4?: number; byte5?: number } = {}): Buffer {
  const { byte1 = 0xf1, byte2 = 0x50, byte3 = 0x80, byte4 = 0x00, byte5 = 0xff } = overrides;
  return Buffer.from([0xff, byte1, byte2, byte3, byte4, byte5, 0xfc]);
}

describe('ADTS rejection boundaries', () => {
  it('rejects a lost sync word inside an otherwise well-formed stream', () => {
    expect(inspect(Buffer.concat([adts(), Buffer.alloc(7, 0x00)]), 'audio/aac')).toBeNull();
    expect(inspect(Buffer.from([0x00, 0xf1, 0x50, 0x80, 0x00, 0xff, 0xfc]), 'audio/aac')).toBeNull();
    expect(inspect(adts({ byte1: 0xf6 }), 'audio/aac')).toBeNull();
  });

  it('rejects reserved sample-rate indexes, silent channel configuration and impossible frame lengths', () => {
    expect(inspect(adts({ byte2: 0x34 }), 'audio/aac')).toBeNull();          // sampleIndex 13
    expect(inspect(adts({ byte2: 0x50, byte3: 0x00, byte4: 0x00, byte5: 0xff }), 'audio/aac')).toBeNull(); // channels 0
    expect(inspect(adts({ byte4: 0x00, byte5: 0x40 }), 'audio/aac')).toBeNull(); // frameLength 2
    expect(inspect(adts({ byte4: 0x0c, byte5: 0xe0 }), 'audio/aac')).toBeNull(); // frame runs past EOF
  });
});

// ── FLAC ────────────────────────────────────────────────────────────────────
function flac(options: {
  sampleRate?: number; channelsMinusOne?: number; totalSamples?: number;
  firstHeader?: number; firstLength?: number; frameSync?: [number, number] | null;
  extraBlockType?: number;
} = {}): Buffer {
  const {
    sampleRate = 44_100, channelsMinusOne = 0, totalSamples = 4_410,
    firstHeader = 0x80, firstLength = 34, frameSync = [0xff, 0xf8], extraBlockType,
  } = options;
  const blocks: Buffer[] = [];
  const streamInfo = Buffer.alloc(38);
  streamInfo[0] = extraBlockType === undefined ? firstHeader : 0x00;
  streamInfo.writeUIntBE(firstLength, 1, 3);
  const packed = (BigInt(sampleRate) << 44n) | (BigInt(channelsMinusOne) << 41n) | (15n << 36n) | BigInt(totalSamples);
  streamInfo.writeBigUInt64BE(packed, 14);
  blocks.push(streamInfo);
  if (extraBlockType !== undefined) {
    const second = Buffer.alloc(8);
    second[0] = 0x80 | extraBlockType;
    second.writeUIntBE(4, 1, 3);
    blocks.push(second);
  }
  const tail = frameSync ? Buffer.from(frameSync) : Buffer.alloc(2);
  return Buffer.concat([Buffer.from('fLaC'), ...blocks, tail]);
}

describe('FLAC metadata-chain rejection boundaries', () => {
  it('accepts a canonical STREAMINFO-only stream', () => {
    expect(inspect(flac(), 'audio/flac')).toEqual(expect.objectContaining({ container: 'flac', codec: 'flac' }));
  });

  it('requires STREAMINFO to be first, unique and exactly 34 bytes', () => {
    expect(inspect(flac({ firstHeader: 0x81 }), 'audio/flac')).toBeNull();   // ilk blok STREAMINFO değil
    expect(inspect(flac({ firstLength: 30 }), 'audio/flac')).toBeNull();     // yanlış uzunluk
    expect(inspect(flac({ extraBlockType: 0 }), 'audio/flac')).toBeNull();   // ikinci STREAMINFO
    expect(inspect(flac({ extraBlockType: 4 }), 'audio/flac')).toEqual(
      expect.objectContaining({ container: 'flac' }),
    );
  });

  it('rejects a metadata length that overruns the file and a chain that never terminates', () => {
    expect(inspect(flac({ firstLength: 4_000 }), 'audio/flac')).toBeNull();
    // Son-blok biti hiç gelmez ve dosya biter: sonsuz döngü değil, ret.
    const unterminated = Buffer.concat([Buffer.from('fLaC'), (() => {
      const block = Buffer.alloc(40); block[0] = 0x00; block.writeUIntBE(34, 1, 3); return block;
    })()]);
    expect(inspect(unterminated, 'audio/flac')).toBeNull();
  });

  it('rejects impossible stream parameters and a missing audio frame sync', () => {
    expect(inspect(flac({ sampleRate: 4_000 }), 'audio/flac')).toBeNull();
    expect(inspect(flac({ sampleRate: 700_000 }), 'audio/flac')).toBeNull();
    expect(inspect(flac({ totalSamples: 0 }), 'audio/flac')).toBeNull();
    expect(inspect(flac({ frameSync: [0x00, 0x00] }), 'audio/flac')).toBeNull();
    expect(inspect(flac({ frameSync: [0xff, 0x00] }), 'audio/flac')).toBeNull();
  });
});

// ── OGG ─────────────────────────────────────────────────────────────────────
function oggPage(payload: Buffer, granule: bigint, options: { magic?: string; version?: number; segments?: number } = {}): Buffer {
  const page = Buffer.alloc(27 + 1 + payload.length);
  page.write(options.magic ?? 'OggS', 0);
  page[4] = options.version ?? 0;
  page.writeBigUInt64LE(granule, 6);
  page[26] = options.segments ?? 1;
  page[27] = payload.length;
  payload.copy(page, 28);
  return page;
}
function opusHead(): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0); head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10);
  return head;
}
function vorbisHead(sampleRate = 44_100): Buffer {
  const head = Buffer.alloc(16);
  head[0] = 1; head.write('vorbis', 1); head.writeUInt32LE(sampleRate, 12);
  return head;
}

describe('Ogg page-chain rejection boundaries', () => {
  it('reads a Vorbis identification header and derives duration from its sample rate', () => {
    const info = inspect(Buffer.concat([oggPage(vorbisHead(), 0n), oggPage(Buffer.from([0]), 44_100n)]), 'audio/ogg');
    expect(info).toEqual(expect.objectContaining({ container: 'ogg', codec: 'vorbis' }));
    expect(info!.durationSeconds).toBeCloseTo(1, 5);
  });

  it('rejects a foreign codec packet on the first page', () => {
    const speex = Buffer.alloc(16); speex.write('Speex   ', 0);
    expect(inspect(Buffer.concat([oggPage(speex, 0n), oggPage(Buffer.from([0]), 48_000n)]), 'audio/ogg')).toBeNull();
    // 'vorbis' imzası var ama paket kısa: kısmi eşleşme kabul edilmez.
    const shortVorbis = Buffer.alloc(10); shortVorbis[0] = 1; shortVorbis.write('vorbis', 1);
    expect(inspect(Buffer.concat([oggPage(shortVorbis, 0n), oggPage(Buffer.from([0]), 48_000n)]), 'audio/ogg')).toBeNull();
  });

  it('rejects a broken page magic, an unknown page version and truncated segment tables', () => {
    expect(inspect(Buffer.concat([oggPage(opusHead(), 0n), oggPage(Buffer.from([0]), 48_312n, { magic: 'OggX' })]), 'audio/ogg')).toBeNull();
    expect(inspect(Buffer.concat([oggPage(opusHead(), 0n, { version: 1 })]), 'audio/ogg')).toBeNull();
    expect(inspect(Buffer.concat([oggPage(opusHead(), 0n), oggPage(Buffer.from([0]), 48_312n, { segments: 40 })]), 'audio/ogg')).toBeNull();
  });

  it('rejects a segment table that promises more payload than the file holds', () => {
    const page = oggPage(opusHead(), 0n);
    page[27] = 200; // beyan edilen segment uzunluğu gerçek yükten büyük
    expect(inspect(page, 'audio/ogg')).toBeNull();
  });

  it('rejects a stream whose granule position never advances past the pre-skip', () => {
    expect(inspect(Buffer.concat([oggPage(opusHead(), 0n), oggPage(Buffer.from([0]), 0n)]), 'audio/ogg')).toBeNull();
  });
});

// ── WebM / Matroska ─────────────────────────────────────────────────────────
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
function webm(options: {
  docType?: string; codec?: string; durationBytes?: Buffer | null;
  scale?: Buffer | null; scaleSizeByte?: number; omitCodec?: boolean; omitDocType?: boolean;
} = {}): Buffer {
  const { docType = 'webm', codec = 'A_OPUS', omitCodec = false, omitDocType = false } = options;
  const parts: Buffer[] = [EBML];
  if (!omitDocType) parts.push(Buffer.from([0x42, 0x82, 0x80 | docType.length]), Buffer.from(docType));
  if (!omitCodec) parts.push(Buffer.from([0x86, 0x80 | codec.length]), Buffer.from(codec));
  if (options.scale !== null) {
    const scale = options.scale ?? Buffer.from([0x0f, 0x42, 0x40]);
    parts.push(Buffer.from([0x2a, 0xd7, 0xb1, options.scaleSizeByte ?? (0x80 | scale.length)]), scale);
  }
  if (options.durationBytes !== null) {
    const duration = options.durationBytes ?? (() => { const b = Buffer.alloc(4); b.writeFloatBE(1_000, 0); return b; })();
    parts.push(Buffer.from([0x44, 0x89, 0x80 | duration.length]), duration);
  }
  return Buffer.concat(parts);
}

describe('WebM element rejection boundaries', () => {
  it('accepts a 64-bit duration and both supported audio codecs', () => {
    const double = Buffer.alloc(8); double.writeDoubleBE(2_000, 0);
    expect(inspect(webm({ durationBytes: double }), 'audio/webm')).toEqual(
      expect.objectContaining({ container: 'webm', codec: 'opus' }),
    );
    expect(inspect(webm({ codec: 'A_VORBIS' }), 'audio/webm')).toEqual(
      expect.objectContaining({ container: 'webm', codec: 'vorbis' }),
    );
  });

  it('rejects a non-webm DocType, a missing DocType and unsupported codecs', () => {
    expect(inspect(webm({ docType: 'matroska' }), 'audio/webm')).toBeNull();
    expect(inspect(webm({ omitDocType: true }), 'audio/webm')).toBeNull();
    expect(inspect(webm({ codec: 'A_AAC' }), 'audio/webm')).toBeNull();
    expect(inspect(webm({ omitCodec: true }), 'audio/webm')).toBeNull();
  });

  it('rejects a missing, wrongly sized or zero duration', () => {
    expect(inspect(webm({ durationBytes: null }), 'audio/webm')).toBeNull();
    expect(inspect(webm({ durationBytes: Buffer.from([0x00, 0x00]) }), 'audio/webm')).toBeNull();
    const zero = Buffer.alloc(4); zero.writeFloatBE(0, 0);
    expect(inspect(webm({ durationBytes: zero }), 'audio/webm')).toBeNull();
  });

  it('rejects an out-of-range TimecodeScale but tolerates its absence', () => {
    expect(inspect(webm({ scale: null }), 'audio/webm')).toEqual(expect.objectContaining({ container: 'webm' }));
    expect(inspect(webm({ scale: Buffer.alloc(0), scaleSizeByte: 0x80 }), 'audio/webm')).toBeNull();
    expect(inspect(webm({ scale: Buffer.alloc(5, 1) }), 'audio/webm')).toBeNull();
  });

  it('rejects malformed EBML variable-length integers instead of trusting them', () => {
    // Boyut alanı dosya sonunda: okunacak bayt yok.
    expect(inspect(Buffer.concat([EBML, Buffer.from([0x42, 0x82])]), 'audio/webm')).toBeNull();
    // Geçersiz vint: 0x00 hiçbir uzunluk işaretçisi taşımaz (>8 bayt).
    expect(inspect(Buffer.concat([EBML, Buffer.from([0x42, 0x82, 0x00, 0x00])]), 'audio/webm')).toBeNull();
    // 8 baytlık vint güvenli tamsayı aralığını aşıyor.
    const huge = Buffer.concat([EBML, Buffer.from([0x42, 0x82, 0x01]), Buffer.alloc(7, 0xff)]);
    expect(inspect(huge, 'audio/webm')).toBeNull();
    // Beyan edilen yük dosya sonunu aşıyor.
    expect(inspect(Buffer.concat([EBML, Buffer.from([0x42, 0x82, 0x90]), Buffer.from('webm')]), 'audio/webm')).toBeNull();
    // EBML sihirli baytları yok.
    expect(inspect(Buffer.alloc(32, 0x11), 'audio/webm')).toBeNull();
  });
});
