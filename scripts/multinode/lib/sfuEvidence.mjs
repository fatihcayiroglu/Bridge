// Test-only router ownership evidence from child-process IPC. The Bridge
// production logger must not expose channel IDs to reconstruct this timeline.
export const SFU_EVIDENCE_TAG = 'bridge:sfu:evidence:v1';

export class SfuRouterEvidence {
  constructor() { this.events = []; }

  record(node, generation, message) {
    if (message?.tag !== SFU_EVIDENCE_TAG) return false;
    if (!['opened', 'closed'].includes(message.event)) return false;
    if (typeof node !== 'string' || !Number.isSafeInteger(generation) ||
        typeof message.channelId !== 'string' || !message.channelId || message.channelId.length > 256 ||
        !Number.isSafeInteger(message.at) || message.at <= 0) {
      throw new Error('Invalid SFU lifecycle IPC evidence');
    }
    this.events.push({ node, generation, event: message.event, channelId: message.channelId, at: message.at });
    return true;
  }

  creators(channelId) {
    // Keep duplicates: "exactly one router" must mean one creation event,
    // not merely one distinct node name that may have created it twice.
    return this.events.filter(e => e.channelId === channelId && e.event === 'opened').map(e => e.node);
  }

  intervals(channelId, exitHistory = []) {
    const out = [];
    const anomalies = [];
    const events = this.events.filter(e => e.channelId === channelId)
      .map((e, index) => ({ ...e, index }))
      .sort((a, b) => a.at - b.at || a.index - b.index);
    const active = new Map();
    for (const e of events) {
      const key = `${e.node}/${e.generation}`;
      const exit = exitHistory.find(x => x.name === e.node && x.generation === e.generation)?.at ?? Infinity;
      if (e.at > exit) {
        anomalies.push('lifecycle event after process exit');
        continue;
      }
      if (e.event === 'opened') {
        if (active.has(key)) anomalies.push('duplicate live router opened');
        else active.set(key, e);
      } else {
        const opened = active.get(key);
        if (!opened) anomalies.push('router closed without observed open');
        else {
          out.push({ node: e.node, generation: e.generation, from: opened.at, to: e.at });
          active.delete(key);
        }
      }
    }
    for (const opened of active.values()) {
      const exit = exitHistory.find(x => x.name === opened.node && x.generation === opened.generation)?.at ?? Infinity;
      out.push({ node: opened.node, generation: opened.generation, from: opened.at, to: exit });
    }
    return { intervals: out, anomalies };
  }

  splitBrain(channelId, exitHistory = []) {
    const { intervals, anomalies } = this.intervals(channelId, exitHistory);
    const overlaps = [];
    for (let i = 0; i < intervals.length; i++) {
      for (let k = i + 1; k < intervals.length; k++) {
        const a = intervals[i]; const b = intervals[k];
        if ((a.node !== b.node || a.generation !== b.generation) && a.from < b.to && b.from < a.to) {
          overlaps.push([a.node, b.node].sort().join('∩'));
        }
      }
    }
    return {
      observed: intervals.length,
      intervals: intervals.map(x => `${x.node}[${x.to === Infinity ? 'open' : `${x.to - x.from}ms`}]`).join(' ') || 'none-observed',
      overlaps,
      anomalies,
    };
  }
}
