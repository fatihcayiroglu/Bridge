// #491: privacy-bounded lifecycle of explicit navigation intents (native deep
// links) versus automatic restoration. EX01 cycle 3 cold-deep-link restored
// the remembered channel and never selected the deep-link target; the run
// could not show where the intent was lost. Fixed stage names, counts and
// booleans only: never IDs, URLs, names or tokens.

export type IntentStage =
  | 'received' | 'queued-for-sign-in' | 'dispatched' | 'shell-not-ready'
  | 'lookup-found' | 'lookup-missing' | 'navigated' | 'not-navigated' | 'route-error';
export type NavigateBranch = 'direct' | 'pending-same-server' | 'pending-switch' | 'unavailable' | 'rejected';
export type PendingOutcome = 'selected' | 'missing' | 'timeout' | 'superseded' | 'logout' | 'load-failed';

interface IntentRecord {
  stages: IntentStage[];
  serversAtRoute: number | null;
  branch: NavigateBranch | null;
  pendingOutcome: PendingOutcome | null;
}

const MAX_INTENTS = 4;
const MAX_STAGES = 12;
const intents: IntentRecord[] = [];
let autoRestoreWhileIntentPending = 0;
let autoSelections = 0;

function current(): IntentRecord | undefined {
  return intents[intents.length - 1];
}

/** A new explicit intent (one native channel link). */
export function beginIntent(): void {
  intents.push({ stages: ['received'], serversAtRoute: null, branch: null, pendingOutcome: null });
  if (intents.length > MAX_INTENTS) intents.shift();
}

export function noteIntentStage(stage: IntentStage, servers?: number): void {
  const record = current();
  if (!record) return;
  if (record.stages.length < MAX_STAGES) record.stages.push(stage);
  if (servers !== undefined) record.serversAtRoute = Math.min(Math.max(0, servers | 0), 999);
}

export function noteNavigateBranch(branch: NavigateBranch): void {
  const record = current();
  if (record && record.branch === null) record.branch = branch;
}

export function notePendingOutcome(outcome: PendingOutcome): void {
  const record = current();
  if (record && record.pendingOutcome === null) record.pendingOutcome = outcome;
}

const TERMINAL: ReadonlySet<IntentStage> = new Set<IntentStage>(
  ['navigated', 'not-navigated', 'lookup-missing', 'shell-not-ready', 'route-error']);

/** An automatic (non-user) channel selection, counted against any explicit intent still in flight. */
export function noteAutoSelection(): void {
  autoSelections = Math.min(autoSelections + 1, 999);
  const record = current();
  const last = record?.stages[record.stages.length - 1];
  if (record && last && !TERMINAL.has(last)) {
    autoRestoreWhileIntentPending = Math.min(autoRestoreWhileIntentPending + 1, 999);
  }
}

export function navigationIntentStatus(): {
  intents: IntentRecord[]; autoSelections: number; autoRestoreWhileIntentPending: number;
} {
  return JSON.parse(JSON.stringify({ intents, autoSelections, autoRestoreWhileIntentPending })) as {
    intents: IntentRecord[]; autoSelections: number; autoRestoreWhileIntentPending: number;
  };
}

if (typeof window !== 'undefined' && !Object.prototype.hasOwnProperty.call(window, '__bridgeNavigationIntentV1')) {
  Object.defineProperty(window, '__bridgeNavigationIntentV1', {
    value: Object.freeze({ status: navigationIntentStatus }),
    enumerable: false, configurable: false, writable: false,
  });
}

/** Test-only reset; never used by production code. */
export function resetNavigationIntentDiagnosticsForTests(): void {
  intents.length = 0;
  autoSelections = 0;
  autoRestoreWhileIntentPending = 0;
}
