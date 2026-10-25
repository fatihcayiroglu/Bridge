import { normalizeServerUrl, type ServerUrlOptions, type ServerUrlRejection } from './server-origin';

/** Same public liveness protocol and deadline as the existing desktop client. */
export const SERVER_PROBE_TIMEOUT_MS = 8_000;
export function isBridgeLiveness(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    'status' in value && value.status === 'ok' && 'check' in value && value.check === 'liveness';
}

export type ProbeTransport = (url: string, init: {
  method: 'GET'; redirect: 'error'; credentials: 'omit'; signal: AbortSignal;
}) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export type ConnectionSnapshot =
  | { state: 'idle' }
  | { state: 'checking'; origin: string }
  | { state: 'connected'; origin: string }
  | { state: 'error'; reason: ServerUrlRejection | 'not-bridge' | 'unavailable' };

type Job = { generation: number; controller: AbortController; timer: ReturnType<typeof setTimeout> };

/** No UI framework, cookies, credentials, persistent state or telemetry. */
export class ServerConnection {
  private generation = 0;
  private input = '';
  private snapshot: ConnectionSnapshot = { state: 'idle' };
  private job: Job | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly transport: ProbeTransport, private readonly options: ServerUrlOptions = {}) {}

  getSnapshot = (): ConnectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(value: ConnectionSnapshot): void {
    this.snapshot = value;
    for (const listener of this.listeners) listener();
  }

  private cancel(): void {
    this.generation += 1;
    const previous = this.job;
    this.job = null;
    if (previous) { clearTimeout(previous.timer); previous.controller.abort(); }
  }

  setTarget(input: string): void {
    this.cancel();
    this.input = input;
    this.publish({ state: 'idle' });
  }

  async connect(): Promise<void> {
    this.cancel();
    const target = normalizeServerUrl(this.input, this.options);
    if (!target.ok) { this.publish({ state: 'error', reason: target.reason }); return; }
    const controller = new AbortController();
    const job: Job = { generation: this.generation, controller,
      timer: setTimeout(() => {
        if (this.job !== job) return;
        this.job = null;
        controller.abort();
        if (this.generation === job.generation && this.job === null) {
          this.publish({ state: 'error', reason: 'unavailable' });
        }
      }, SERVER_PROBE_TIMEOUT_MS) };
    this.job = job;
    const current = (): boolean => this.job === job && job.generation === this.generation;
    this.publish({ state: 'checking', origin: target.origin });
    try {
      const response = await this.transport(target.origin + '/api/health/live', {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      });
      if (!current()) return;
      if (!response.ok) { this.publish({ state: 'error', reason: 'not-bridge' }); return; }
      const body = await response.json();
      if (!current()) return;
      this.publish(isBridgeLiveness(body) ? { state: 'connected', origin: target.origin }
        : { state: 'error', reason: 'not-bridge' });
    } catch {
      if (current()) this.publish({ state: 'error', reason: 'unavailable' });
    } finally {
      clearTimeout(job.timer);
      if (current()) this.job = null;
    }
  }

  dispose(): void { this.cancel(); this.listeners.clear(); this.snapshot = { state: 'idle' }; }
}
