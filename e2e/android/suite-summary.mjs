#!/usr/bin/env node
// e2e/android/suite-summary.mjs — Markdown job summary of one Android journey
// run, for $GITHUB_STEP_SUMMARY. Reads android-evidence.json and prints only
// fixed fields (suite, category, ids, statuses, static titles, totals): never
// errors, details, device facts or anything else from the run.
//
//   node e2e/android/suite-summary.mjs e2e/android/results/android-evidence.json

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SUITE_HEADINGS = {
  product: 'Android product journeys (mandatory Bridge reliability suite)',
  'upstream-webview-controls': 'DIAGNOSTIC, NON-GATING: upstream Android WebView reproduction controls (#209)',
};

const STATUSES = new Set(['PASS', 'FAIL', 'SKIPPED', 'MEASURED']);
const cell = (value) => String(value).replace(/[|\r\n]/g, ' ').slice(0, 160);

/** Markdown for an evidence summary object, or for a missing/unreadable one (null). */
export function formatSuiteSummary(evidence) {
  if (!evidence || typeof evidence !== 'object' || !Array.isArray(evidence.results)) {
    return '## Android journeys\n\n**No evidence file: the run did not complete.** ' +
      'This is a failure, not a pass. See the job log.\n';
  }
  const suite = Object.hasOwn(SUITE_HEADINGS, evidence.suite) ? evidence.suite : 'unknown';
  const lines = [`## ${SUITE_HEADINGS[suite] ?? 'Android journeys (unknown suite)'}`, ''];
  if (suite === 'upstream-webview-controls') {
    lines.push('These unmitigated debug Activities contain no Bridge code. They reproduce the ' +
      'unfixed-WebView FontsProvider stable-reference leak (WebView 113 on this image; fixed upstream ' +
      'in 117.0.5938.29 / 118.0.5971.0) and are exposed to its DEPENDENCY DIED kill. ' +
      'They do not gate pull requests; the product suite in Mobile Android does. ' +
      '**A FAIL here is a real failure and is never counted as a pass.**', '');
  }
  lines.push(`Evidence category: ${cell(evidence.evidenceCategory ?? 'unknown')}`, '');
  const totals = { PASS: 0, FAIL: 0, SKIPPED: 0, MEASURED: 0 };
  lines.push('| Check | Status | Title |', '| --- | --- | --- |');
  for (const result of evidence.results) {
    const status = STATUSES.has(result?.status) ? result.status : 'FAIL';
    totals[status] += 1;
    lines.push(`| ${cell(result?.id ?? '?')} | ${status === 'FAIL' ? '**FAIL**' : status} | ${cell(result?.title ?? '')} |`);
  }
  lines.push('', `Totals: pass=${totals.PASS} fail=${totals.FAIL} skipped=${totals.SKIPPED} ` +
    `measured=${totals.MEASURED} (skipped and measured are never counted as pass)`, '');
  return lines.join('\n');
}

/** Separate calibration verdict; stale/missing/foreign evidence never passes. */
export function formatCrashControlSummary(product, control) {
  const valid = product?.suite === 'product' && typeof product.commit === 'string' &&
    /^[a-f0-9]{40}$/.test(product.commit) && control?.commit === product.commit &&
    control.case === 'CR00' && control.evidenceCategory === 'AUTOMATED / EMULATOR' && control.status === 'PASS';
  const status = valid ? 'PASS' : 'FAIL';
  return { status, markdown: '\n## CR00 Java crash diagnostic calibration\n\n**' + status + '**\n\n' +
    'This separate, post-product calibration is excluded from product journey totals. ' +
    'Missing, invalid or stale evidence fails this gate. See java-crash-control.json.\n' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let evidence = null;
  try {
    evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  } catch { /* reported as a missing run below */ }
  process.stdout.write(formatSuiteSummary(evidence));
  if (evidence?.suite === 'product') {
    let control = null;
    try {
      control = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[2]), 'java-crash-control.json'), 'utf8'));
    } catch { /* explicitly fails the calibration summary below */ }
    const summary = formatCrashControlSummary(evidence, control);
    process.stdout.write(summary.markdown);
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}
