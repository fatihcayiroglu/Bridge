import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import E2EEToggle from '../js/core/E2EEToggle.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const apiFetch = vi.fn();
const toast = vi.fn();
let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host);
  apiFetch.mockReset(); toast.mockReset();
  BridgeRegistry.unregister('apiFetch'); BridgeRegistry.unregister('toast');
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('toast', toast as never);
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null; host.remove();
  BridgeRegistry.unregister('apiFetch'); BridgeRegistry.unregister('toast');
});

describe('explicit E2EE toggle component contract', () => {
  it('stays invisible unless feature-status is a successful literal true', async () => {
    apiFetch.mockResolvedValueOnce(response(503, { enabled: true }));
    instance = mount(E2EEToggle, { target: host, props: { channelId: 'c1' } });
    await settle();
    expect(host.querySelector('.e2ee-btn')).toBeNull();
    await unmount(instance); instance = null; host.innerHTML = '';

    apiFetch.mockResolvedValueOnce(response(200, { enabled: 'true' }));
    instance = mount(E2EEToggle, { target: host, props: { channelId: 'c1' } });
    await settle();
    expect(host.querySelector('.e2ee-btn')).toBeNull();
  });

  it('toggles only after explicit feature enablement and sends the channel-scoped PATCH', async () => {
    apiFetch.mockResolvedValueOnce(response(200, { enabled: true }));
    instance = mount(E2EEToggle, { target: host, props: { channelId: 'channel/1', initialEnabled: false } });
    await settle();
    const button = host.querySelector<HTMLButtonElement>('.e2ee-btn')!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');

    apiFetch.mockResolvedValueOnce(response(200, { e2eeEnabled: true }));
    button.click();
    await settle();
    expect(apiFetch).toHaveBeenLastCalledWith('/api/channels/channel/1/e2ee', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    }));
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('etkinleştirildi'), 'success');
  });

  it('keeps prior state and shows an alert on HTTP/malformed response failures', async () => {
    apiFetch.mockResolvedValueOnce(response(200, { enabled: true }));
    instance = mount(E2EEToggle, { target: host, props: { channelId: 'c1', initialEnabled: true } });
    await settle();
    const button = host.querySelector<HTMLButtonElement>('.e2ee-btn')!;
    expect(button.getAttribute('aria-pressed')).toBe('true');

    apiFetch.mockResolvedValueOnce(response(200, { e2eeEnabled: 'false' }));
    button.click(); await settle();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('değiştirilemedi');
    expect(button.disabled).toBe(false);

    apiFetch.mockResolvedValueOnce(response(500, {}));
    button.click(); await settle();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('fails closed if the API registry owner disappears after mount', async () => {
    apiFetch.mockResolvedValueOnce(response(200, { enabled: true }));
    instance = mount(E2EEToggle, { target: host, props: { channelId: 'c1' } });
    await settle();
    BridgeRegistry.unregister('apiFetch');
    host.querySelector<HTMLButtonElement>('.e2ee-btn')!.click();
    await settle();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
