// Explicit acceptance inventory: removing a required check from the runner
// cannot turn a shorter/empty report into a successful native suite.
export const PRODUCT_CHECKS = Object.freeze([
  'A01', 'CS01', 'A02', 'FD01', 'PN01', 'A03', 'M01', 'M02', 'L01', 'L02', 'D2L01',
  'L03', 'L04', 'N01', 'N02', 'D01', 'K01', 'K02', 'DL01', 'DL04', 'DL02', 'DL03',
  'P01', 'P03', 'V02', 'P06', 'P07', 'V03', 'P02', 'UI01', 'UI02', 'F01', 'P05', 'LO01', 'ANR01', 'PD01',
]);
export const PRODUCT_MEASUREMENTS = Object.freeze(['FD02', 'P04', 'N03', 'PERF02', 'PERF01', 'ANR03', 'ANR02', 'SF01', 'SF02', 'SF03', 'SF04', 'SF05']);

export function assessSuiteEvidence(evidence, { expectedCommit = null, expectedSuite = 'product' } = {}) {
  const fail = reason => ({ status: 'FAIL', reason });
  if (!evidence || typeof evidence !== 'object') return fail('missing-evidence');
  if (!['product', 'upstream-webview-controls'].includes(evidence.suite) || evidence.suite !== expectedSuite) return fail('invalid-suite');
  if (typeof evidence.commit !== 'string' || !/^[a-f0-9]{40}$/.test(evidence.commit)) return fail('invalid-commit');
  if (expectedCommit !== null && evidence.commit !== expectedCommit) return fail('unexpected-commit');
  if (!['AUTOMATED / EMULATOR', 'AUTOMATED / REAL DEVICE'].includes(evidence.evidenceCategory)) return fail('non-native-evidence');
  if (!Array.isArray(evidence.results) || evidence.results.length === 0 || evidence.results.length > 128) return fail('invalid-results');
  const ids = new Set();
  const totals = { pass: 0, fail: 0, skipped: 0, measured: 0 };
  for (const row of evidence.results) {
    if (!row || typeof row.id !== 'string' || !/^[A-Z][A-Z0-9-]{0,15}$/.test(row.id) || ids.has(row.id)) return fail('invalid-results');
    ids.add(row.id);
    if (!['PASS', 'FAIL', 'SKIPPED', 'MEASURED'].includes(row.status)) return fail('invalid-results');
    totals[row.status.toLowerCase()]++;
  }
  if (totals.fail || totals.skipped) return fail('failed-or-skipped');
  if (evidence.suite === 'product' && (ids.size !== PRODUCT_CHECKS.length + PRODUCT_MEASUREMENTS.length ||
      PRODUCT_CHECKS.some(id => !evidence.results.some(row => row.id === id && row.status === 'PASS')) ||
      PRODUCT_MEASUREMENTS.some(id => !evidence.results.some(row => row.id === id && row.status === 'MEASURED')))) {
    return fail('incomplete-product');
  }
  if (Object.keys(totals).some(key => evidence.totals?.[key] !== totals[key])) return fail('inconsistent-totals');
  return { status: 'PASS', reason: null };
}
