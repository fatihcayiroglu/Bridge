// Failure diagnostics for the real-browser Android acceptance harness. Pure functions, no
// I/O. Run 40676969700 (#547) failed at stage normal-settings-ca-install with only
// {"status":"FAIL","stage":..,"passed":0,"failed":0,"notExecuted":3}: the code, the last
// wait and the screen were written to an artifact that is not always downloadable, and
// every adb failure was collapsed into ADB_COMMAND_FAILED. These helpers make the first
// failure self-describing in the job log WITHOUT printing anything secret:
//   - adb arguments after the subcommand are never printed (`locksettings set-pin <pin>`,
//     `input text <pin>` carry the emulator PIN);
//   - any 32+ character run, any 6-digit number and every exact secret is masked.
const TOKEN_RUN = /[A-Za-z0-9+/_=-]{32,}/g;

export function redact(value, max = 160, secrets = []) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[secret]');
  return text.replace(TOKEN_RUN, '[redacted]').replace(/\b\d{6}\b/g, '[pin]').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** What an adb call did, without its arguments: `args` is [subcommand-ish tokens..., values...]. */
export function adbFailure(args, result, secrets = []) {
  return {
    command: args.slice(0, 3).map((token) => redact(token, 40, secrets)).join(' '),
    exit: result?.status ?? null,
    signal: result?.signal ?? null,
    timedOut: result?.error?.code === 'ETIMEDOUT',
    stderr: redact(result?.stderr, 160, secrets),
  };
}

/** Visible strings of a UI hierarchy (text, then content-desc), de-duplicated and bounded. */
export function visibleText(nodes, limit = 40, secrets = []) {
  const seen = new Set();
  for (const node of nodes ?? []) {
    for (const raw of [node.text, node['content-desc']]) {
      const text = redact(raw, 120, secrets);
      if (text) seen.add(text);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}

export function failureReport({ facts, nodes = [], secrets = [] }) {
  return {
    failure: facts.failure ?? null,
    stage: facts.stage ?? null,
    lastWait: facts.lastWait ?? null,
    errorKind: facts.errorKind ?? null,
    errorMessage: facts.errorMessage ?? null,
    activity: redact(facts.failureActivity ?? '', 120, secrets),
    packages: [...new Set(nodes.map((node) => node.package).filter(Boolean))].slice(0, 12),
    visibleText: visibleText(nodes, 40, secrets),
    firstAdbFailure: facts.firstAdbFailure ?? null,
    uiDumpFailures: (facts.uiDumpFailures ?? []).slice(0, 5),
    anrEvidence: (facts.anrEvidence ?? []).slice(0, 12),
    anrDialogsAnswered: (facts.anrDialogs ?? []).map((name) => redact(name, 40, secrets)).slice(0, 10),
  };
}
