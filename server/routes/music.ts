'use strict';
const QUEUE_MAX = 25;
const queues = {};

function getQueue(channelId) {
  if (!queues[channelId]) queues[channelId] = { current: null, queue: [] };
  return queues[channelId];
}

function isValidMusicUrl(url) {
  try {
    const u = new URL(url);
    return ['youtube.com', 'youtu.be', 'soundcloud.com'].some(h => u.hostname.includes(h));
  } catch { return false; }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function getVideoInfo(url) { return { title: `Track from ${url}`, duration: 180, url }; }
async function getStreamUrl(url) { return url; }

function skipCurrent(channelId) {
  const q = getQueue(channelId);
  q.current = q.queue.shift() || null;
  return q.current;
}

function clearQueue(channelId) {
  queues[channelId] = { current: null, queue: [] };
}

async function handleMusicCommand(command, args, channelId, io) {
  const q = getQueue(channelId);
  if (command === '!play') {
    const url = args[0];
    if (!url) return { error: 'URL required' };
    if (!isValidMusicUrl(url)) return { error: 'Invalid music URL' };
    if (q.queue.length >= QUEUE_MAX) return { error: `Queue full (max ${QUEUE_MAX})` };
    const info = await getVideoInfo(url);
    if (!q.current) { q.current = info; return { nowPlaying: info }; }
    q.queue.push(info);
    return { queued: info, position: q.queue.length };
  }
  if (command === '!skip') {
    const next = skipCurrent(channelId);
    return next ? { nowPlaying: next } : { stopped: true };
  }
  if (command === '!stop') {
    clearQueue(channelId);
    return { stopped: true };
  }
  if (command === '!queue') {
    return { current: q.current, queue: q.queue };
  }
  if (command === '!help') {
    return { commands: ['!play <url>', '!skip', '!stop', '!queue'] };
  }
  return false;
}

module.exports = { handleMusicCommand, getQueue, skipCurrent, clearQueue, getVideoInfo, getStreamUrl, isValidMusicUrl, formatDuration, voiceQueues: queues };
export {};
