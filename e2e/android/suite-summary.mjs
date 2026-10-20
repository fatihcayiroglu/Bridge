#!/usr/bin/env node
// e2e/android/suite-summary.mjs — Markdown job summary of one Android journey
// run, for $GITHUB_STEP_SUMMARY. Reads android-evidence.json and prints only
// fixed fields (suite, category, ids, statuses, static titles, totals): never
// errors, details or anything else from the run. With a WebView arm (#209
// comparison jobs) it also prints the observed provider, reduced to a fixed
// kind enum and an integer major version; no other device fact.
//
//   node e2e/android/suite-summary.mjs e2e/android/results/android-evidence.json [webview-arm]

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyWebViewArm } from './exit-diagnostics.mjs';

const SUITE_HEADINGS = {
  product: 'Android product journeys (mandatory Bridge reliability suite)',
  'upstream-webview-controls': 'DIAGNOSTIC, NON-GATING: upstream Android WebView reproduction controls (#209)',
};
// The product suite run on a #209 comparison arm is not the required gate.
const PRODUCT_ARM_HEADING = 'DIAGNOSTIC, NON-GATING: Bridge product journeys on a controlled WebView arm (#209)';

// #209 controlled comparison: which WebView provider the job is meant to run
// on. Fixed text per allowlisted arm; anything else is reported as unknown.
// The provider actually observed is printed separately, from the evidence.
const WEBVIEW_ARMS = {
  system: 'system: the image\'s own WebView provider (no provider switch)',
  'chromium-fixed': 'chromium-fixed: pinned Chromium SystemWebView 158.0.8114.0 selected as the provider (fixed upstream)',
};

const STATUSES = new Set(['PASS', 'FAIL', 'SKIPPED', 'MEASURED']);
const cell = (value) => String(value).replace(/[|\r\n]/g, ' ').slice(0, 160);

/** Markdown for an evidence summary object, or for a missing/unreadable one (null). */
export function formatSuiteSummary(evidence, webviewArm = null) {
  if (!evidence || typeof evidence !== 'object' || !Array.isArray(evidence.results)) {
    return '## Android journeys\n\n**No evidence file: the run did not complete.** ' +
      'This is a failure, not a pass. See the job log.\n';
  }
  const suite = Object.hasOwn(SUITE_HEADINGS, evidence.suite) ? evidence.suite : 'unknown';
  const heading = suite === 'product' && webviewArm !== null ? PRODUCT_ARM_HEADING
    : SUITE_HEADINGS[suite] ?? 'Android journeys (unknown suite)';
  const lines = [`## ${heading}`, ''];
  if (suite === 'product' && webviewArm !== null) {
    lines.push('The Bridge product journeys on a #209 comparison WebView arm. This job is ' +
      '**not the required gate**: the required product gate is the Mobile Android workflow. ' +
      '**A FAIL here is a real failure and is never counted as a pass.**', '');
  }
  if (suite === 'upstream-webview-controls') {
    lines.push('These unmitigated debug Activities contain no Bridge code. On an unfixed WebView ' +
      '(113 on this image; fixed upstream in 117.0.5938.29 / 118.0.5971.0) they reproduce the ' +
      'FontsProvider stable-reference leak and are exposed to its DEPENDENCY DIED kill. ' +
      'They do not gate pull requests; the product suite in Mobile Android does. ' +
      '**A FAIL here is a real failure and is never counted as a pass.**', '');
  }
  if (webviewArm !== null) {
    lines.push(`WebView arm: ${Object.hasOwn(WEBVIEW_ARMS, webviewArm) ? WEBVIEW_ARMS[webviewArm] : 'unknown'}`, '');
    const arm = verifyWebViewArm(webviewArm, evidence.facts?.device?.webview);
    const observed = `${arm.observedProviderKind}, major version ${arm.observedMajorVersion ?? 'unknown'}`;
    lines.push(`Observed WebView provider (device facts): ${observed}`, '');
    if (!arm.matches) {
      const expected = arm.expectedProviderKind === null ? 'a known arm'
        : `${arm.expectedProviderKind}, major version >= ${arm.expectedMinMajorVersion}`;
      lines.push(`**WebView arm MISMATCH: expected ${expected}, observed ${observed}. ` +
        'These results do not describe the named arm.**', '');
    }
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let evidence = null;
  try {
    evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  } catch { /* reported as a missing run below */ }
  process.stdout.write(formatSuiteSummary(evidence, process.argv[3] ?? null));
}
