// server/socket/handlers/mediasoup/config.ts
// Mediasoup yapılandırması — env değişkenlerinden okunur
// Sprint 120: Simulcast + VP9 SVC eklendi (A3)

import type { SfuConfig } from './types';

import logger from '../../../lib/logger';
import { envSafeInt } from '../../../lib/envNumbers';


const VIDEO_MAX_KBPS = envSafeInt('MEDIASOUP_VIDEO_MAX_BITRATE', 3_000, { min: 100, max: 100_000 });
const SCREEN_MAX_KBPS = envSafeInt('MEDIASOUP_SCREEN_BITRATE', 2_500, { min: 100, max: 100_000 });
const OPUS_MAX_KBPS = envSafeInt('MEDIASOUP_OPUS_BITRATE', 64, { min: 6, max: 510 });
const RTC_MIN_PORT = envSafeInt('MEDIASOUP_RTC_MIN_PORT', 40_000, { min: 1, max: 65_535 });
const RTC_MAX_PORT = envSafeInt('MEDIASOUP_RTC_MAX_PORT', 49_999, { min: 1, max: 65_535 });
const NUM_WORKERS = envSafeInt('MEDIASOUP_WORKERS', 1, { min: 1, max: 4 });
if (RTC_MIN_PORT > RTC_MAX_PORT) {
  throw new Error('MEDIASOUP_RTC_MIN_PORT must be <= MEDIASOUP_RTC_MAX_PORT');
}

// ── Simulcast encoding katmanları ──────────────────────────────────────────
// Düşük bant genişlikli istemciler en alt katmanı alır (q), iyi bağlantılar
// tam kalite alır (f). 20+ kişilik toplantılarda bant genişliği kontrolü sağlar.
export const SIMULCAST_ENCODINGS = [
  { rid: 'q', maxBitrate:  200_000, scalabilityMode: 'S1T3' }, // düşük — ~200 kbps
  { rid: 'h', maxBitrate:  500_000, scalabilityMode: 'S1T3' }, // orta  — ~500 kbps
  { rid: 'f', maxBitrate: VIDEO_MAX_KBPS * 1000,
              scalabilityMode: 'S1T3' },                        // yüksek — env'den
];

// VP9 SVC için tek encoding (daha verimli, tek stream'de katmanlı kalite)
export const SVC_ENCODINGS = [
  { scalabilityMode: 'S3T3', maxBitrate: VIDEO_MAX_KBPS * 1000 },
];

// Ekran paylaşımı — simulcast yok, tek yüksek kalite stream
export const SCREENSHARE_ENCODINGS = [
  { maxBitrate: SCREEN_MAX_KBPS * 1000,
    maxFramerate: 15, scalabilityMode: 'S1T1' },
];

export const config: SfuConfig = {
  announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
  rtcMinPort: RTC_MIN_PORT,
  rtcMaxPort: RTC_MAX_PORT,
  numWorkers: NUM_WORKERS,

  mediaCodecs: [
    {
      kind:      'audio',
      mimeType:  'audio/opus',
      clockRate: 48000,
      channels:  2,
      parameters: {
        'useinbandfec':      1,
        'usedtx':            1,
        'maxplaybackrate':   48000,
        'stereo':            1,
        'sprop-stereo':      1,
        'minptime':          10,
        'ptime':             20,
        'maxaveragebitrate': OPUS_MAX_KBPS * 1000,
      },
    },
    {
      kind:      'video',
      mimeType:  'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
        'x-google-min-bitrate':   100,
        'x-google-max-bitrate':   VIDEO_MAX_KBPS,
      },
    },
    {
      kind:      'video',
      mimeType:  'video/VP9',
      clockRate: 90000,
      parameters: {
        'profile-id':             2,
        'x-google-start-bitrate': 1000,
        'x-google-min-bitrate':   100,
        'x-google-max-bitrate':   VIDEO_MAX_KBPS,
      },
    },
    {
      kind:      'video',
      mimeType:  'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode':      1,
        'profile-level-id':        '42e01f',
        'level-asymmetry-allowed': 1,
      },
    },
  ],

  webRtcTransport: {
    listenIps: [
      {
        ip:          process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
      },
    ],
    enableUdp:  true,
    enableTcp:  true,
    preferUdp:  true,
    initialAvailableOutgoingBitrate: 800_000,
    maxIncomingBitrate: 1_500_000,
  },
};

if (!config.announcedIp && process.env.NODE_ENV === 'production') {
  logger.warn(
    '[SFU] UYARI: MEDIASOUP_ANNOUNCED_IP tanımlanmamış. ' +
    'Prodüksiyonda remote peer\'lar ses kanallarına bağlanamayabilir.'
  );
}
