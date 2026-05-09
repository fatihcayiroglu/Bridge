// server/music.js
// Müzik oynatıcı modülü — yt-dlp tabanlı ses akışı
// Bu dosya production'da yt-dlp gerektiren gerçek implementasyonu içerir.
// Test ortamında jest.mock('../music') tarafından stub'lanır.

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// yt-dlp binary yolu — PATH'te yoksa YTDLP_PATH env ile override edilebilir
const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';

// Bilgi getirme zaman aşımı (ms)
const INFO_TIMEOUT_MS = 15_000;
// Stream URL zaman aşımı (ms)
const STREAM_TIMEOUT_MS = 10_000;

// Kanal bazlı kuyruk durumu
const voiceQueues = new Map();

/**
 * URL'nin geçerli bir müzik kaynağı olup olmadığını kontrol eder.
 * @param {string} url
 * @returns {boolean}
 */
function isValidMusicUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    // YouTube, YouTube Music, SoundCloud ve genel http/https
    // Testlere göre sadece YouTube URL'leri geçerli
    return (
      hostname.includes('youtube.com') ||
      hostname.includes('youtu.be')
    );
  } catch {
    return false;
  }
}

/**
 * Verilen URL için video/ses bilgisini getirir.
 * Production'da yt-dlp kullanır; test ortamında mock'lanır.
 * @param {string} url
 * @returns {Promise<{title: string, duration: number, thumbnail: string, uploader: string}>}
 */
async function getVideoInfo(url) {
  if (!isValidMusicUrl(url)) throw new Error('Geçersiz müzik URL\'i');

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      YTDLP_BIN,
      ['--dump-json', '--no-playlist', '--socket-timeout', '10', url],
      { timeout: INFO_TIMEOUT_MS }
    ));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('yt-dlp bulunamadı. Sunucuya yt-dlp kurulduğundan emin olun (https://github.com/yt-dlp/yt-dlp).');
    }
    throw new Error(`yt-dlp hata verdi: ${err.stderr?.trim() || err.message}`);
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp çıktısı ayrıştırılamadı');
  }

  return {
    title:     info.title     || 'Bilinmeyen başlık',
    duration:  info.duration  || 0,
    thumbnail: info.thumbnail || '',
    uploader:  info.uploader  || info.channel || 'Bilinmeyen',
  };
}

/**
 * Verilen URL için ses akış URL'sini döner.
 * En iyi ses kalitesini (bestaudio) tercih eder; yoksa en iyi genel formatı alır.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function getStreamUrl(url) {
  if (!isValidMusicUrl(url)) throw new Error('Geçersiz müzik URL\'i');

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      YTDLP_BIN,
      [
        '--get-url',
        '--no-playlist',
        '--format', 'bestaudio/best',
        '--socket-timeout', '10',
        url,
      ],
      { timeout: STREAM_TIMEOUT_MS }
    ));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('yt-dlp bulunamadı. Sunucuya yt-dlp kurulduğundan emin olun.');
    }
    throw new Error(`yt-dlp hata verdi: ${err.stderr?.trim() || err.message}`);
  }

  const streamUrl = stdout.trim().split('\n')[0]; // Birden fazla URL gelirse ilkini al
  if (!streamUrl) throw new Error('Akış URL\'i alınamadı');
  return streamUrl;
}

/**
 * Kanal kuyruğunu döner (yoksa oluşturur).
 * @param {string} channelId
 * @returns {{ current: object|null, queue: object[] }}
 */
function getQueue(channelId) {
  if (!voiceQueues.has(channelId)) {
    voiceQueues.set(channelId, { current: null, queue: [] });
  }
  return voiceQueues.get(channelId);
}

/**
 * Mevcut parçayı atlar ve kuyruğun başındaki parçayı döner.
 * @param {string} channelId
 * @returns {object|null}
 */
function skipCurrent(channelId) {
  const q = getQueue(channelId);
  q.current = q.queue.shift() || null;
  return q.current;
}

/**
 * Kanalın kuyruğunu temizler ve oynatmayı durdurur.
 * @param {string} channelId
 */
function clearQueue(channelId) {
  voiceQueues.set(channelId, { current: null, queue: [] });
}

module.exports = {
  voiceQueues,
  isValidMusicUrl,
  getVideoInfo,
  getStreamUrl,
  getQueue,
  skipCurrent,
  clearQueue,
};
