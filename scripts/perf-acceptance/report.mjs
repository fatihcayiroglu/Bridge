// P7 #570: a report cannot claim a measurement it does not carry evidence for.
import { SCENARIOS, METRICS } from './scenarios.mjs';

export const STATUSES = ['EXECUTED', 'NOT EXECUTED'];

function fail(code, detail) { return { ok: false, code, detail }; }

/** EXECUTED needs provenance and raw samples for every required metric; NOT EXECUTED must carry no numbers. */
export function validateEntry(entry, scenario = SCENARIOS.find((s) => s.id === entry?.id)) {
  if (!entry || typeof entry !== 'object' || !scenario) return fail('UNKNOWN_SCENARIO', entry?.id);
  if (!STATUSES.includes(entry.status)) return fail('BAD_STATUS', entry.status);
  if (entry.status === 'NOT EXECUTED') {
    if (!Array.isArray(entry.missing) || entry.missing.length === 0) return fail('MISSING_REASON', entry.id);
    if (entry.measurements !== undefined || entry.samples !== undefined) return fail('NUMBERS_WITHOUT_EXECUTION', entry.id);
    return { ok: true };
  }
  const p = entry.provenance;
  if (!p || typeof p !== 'object') return fail('NO_PROVENANCE', entry.id);
  for (const key of ['os', 'osVersion', 'bridgeCommit', 'appVersion', 'machine', 'startedAt', 'endedAt']) {
    if (typeof p[key] !== 'string' || !p[key]) return fail('PROVENANCE_FIELD', `${entry.id}.${key}`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(p.bridgeCommit)) return fail('PROVENANCE_FIELD', `${entry.id}.bridgeCommit`);
  if (!Number.isFinite(p.durationSec) || p.durationSec < scenario.durationSec) return fail('TOO_SHORT', `${entry.id}`);
  if (scenario.needs.remoteClients && !(p.remoteClients >= scenario.needs.remoteClients)) return fail('TOO_FEW_REMOTE_CLIENTS', entry.id);
  if (scenario.realSfu && p.sfu !== 'real') return fail('SFU_NOT_REAL', entry.id);
  const samples = entry.samples;
  if (!samples || typeof samples !== 'object') return fail('NO_SAMPLES', entry.id);
  for (const metric of scenario.metrics) {
    const series = samples[metric];
    if (!Array.isArray(series) || series.length < 3 || !series.every((v) => Number.isFinite(v) || (v && typeof v === 'object'))) {
      return fail('RAW_SAMPLES_REQUIRED', `${entry.id}.${metric}`);
    }
  }
  for (const key of Object.keys(samples)) if (!(key in METRICS)) return fail('UNKNOWN_METRIC', `${entry.id}.${key}`);
  return { ok: true };
}

export function validateReport(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.scenarios)) return fail('BAD_REPORT');
  const seen = new Set();
  for (const entry of report.scenarios) {
    const r = validateEntry(entry);
    if (!r.ok) return r;
    if (seen.has(entry.id)) return fail('DUPLICATE', entry.id);
    seen.add(entry.id);
  }
  for (const s of SCENARIOS) if (!seen.has(s.id)) return fail('SCENARIO_MISSING', s.id);
  return { ok: true };
}

/** Overall verdict: anything NOT EXECUTED keeps the whole acceptance NOT COMPLETE; there is no PASS threshold here. */
export function summarize(report) {
  const counts = { executed: 0, notExecuted: 0 };
  for (const e of report.scenarios) e.status === 'EXECUTED' ? counts.executed++ : counts.notExecuted++;
  return { ...counts, complete: counts.notExecuted === 0 && counts.executed === SCENARIOS.length };
}
