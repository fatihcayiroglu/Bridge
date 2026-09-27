// scripts/medialab/lib/util.mjs — shared scenario helpers.

import { sleep } from './lab.mjs';
import { audibleSenders, rtp, firstAudible, connectTimes } from './analysis.mjs';

export { sleep };

export async function waitUntil(fn, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return { ok: true, value: last, ms: Date.now() - start };
    await sleep(intervalMs);
  }
  return { ok: false, value: last, ms: Date.now() - start };
}

/** Wait until `receiver` decodes the tone of every index in `senders`. */
export async function waitAudible(receiver, senders, others, timeoutMs = 15_000) {
  return waitUntil(async () => {
    const s = await receiver.sample();
    const heard = audibleSenders(s, others);
    return senders.every((i) => heard.includes(i)) ? { heard, sample: s } : null;
  }, { timeoutMs });
}

/** Wait until `receiver` decodes NONE of the tones in `senders`. */
export async function waitSilent(receiver, senders, others, timeoutMs = 15_000) {
  return waitUntil(async () => {
    const s = await receiver.sample();
    const heard = audibleSenders(s, others);
    return senders.every((i) => !heard.includes(i)) ? { heard, sample: s } : null;
  }, { timeoutMs });
}

/** Everyone in `clients` joins `room` in order; returns join timestamps. */
export async function joinAll(clients, room, { gapMs = 500 } = {}) {
  const t = {};
  for (const c of clients) {
    t[c.index] = await c.joinVoice(room);
    await sleep(gapMs);
  }
  return t;
}

/** Per-client join timings measured from the UI click (ms). */
export async function joinTimings(c, peers) {
  const events = await c.events(c.joinedAt);
  const tl = await c.timeline(c.joinedAt);
  const times = connectTimes(events, c.joinedAt);
  const firstOut = tl.find((e) => e.outA > 0);
  const firstIn = {};
  for (const p of peers) {
    const at = firstAudible(tl, p.index, c.joinedAt);
    firstIn[p.index] = at ? at - c.joinedAt : null;
  }
  return { ...times, firstAudioSentMs: firstOut ? firstOut.t - c.joinedAt : null, firstToneDecodedMs: firstIn };
}

/** Selected ICE path of each live transport, for evidence. */
export function paths(sample) {
  return rtp(sample).pairs.map((p) => `${p.local?.type}/${p.local?.protocol}${p.local?.relayProtocol ? `(${p.local.relayProtocol})` : ''}->${p.remote?.type}:${p.remote?.address}:${p.remote?.port}`);
}

export function redirects(c) {
  return c.console.filter((m) => /targeted signaling/.test(m.text)).length;
}
