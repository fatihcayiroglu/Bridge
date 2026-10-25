// Adapt Node's actual summary to the same zero-skip policy as Bridge's Jest gates.
module.exports = async function* noSkips(source) {
  let summary;
  for await (const event of source) {
    if (event.type === 'test:summary') summary = event.data;
  }
  const counts = summary && summary.counts;
  if (!summary || !summary.success || !counts || counts.tests < 1 ||
      counts.skipped !== 0 || counts.todo !== 0 || counts.cancelled !== 0 || counts.failed !== 0) {
    throw new Error('Core unit gate requires executed tests, zero skips/todos/cancellations and zero failures');
  }
  yield JSON.stringify({framework: 'node:test', success: summary.success, counts}) + '\n';
};
