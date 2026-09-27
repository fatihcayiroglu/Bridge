import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mount, unmount, registry } = vi.hoisted(() => ({
  mount: vi.fn(() => ({ instance: 1 })),
  unmount: vi.fn(),
  registry: {} as Record<string, unknown>,
}));

vi.mock('svelte', () => ({ mount, unmount }));
vi.mock('../js/admin/AdminPanel.svelte', () => ({ default: {} }));
vi.mock('../js/core/bridge-registry.ts', () => ({ BridgeRegistry: {
  register(key: string, value: unknown) { registry[key] = value; },
  unregister(key: string) { delete registry[key]; },
} }));

beforeEach(async () => {
  // Removing the prior test DOM may trigger its MutationObserver. Let that old
  // module finish cleanup before resetting modules/mock call history.
  document.body.innerHTML = '<div class="toolbar"><div class="u-action-btn" data-bridge-action="openSettingsModal"></div></div>';
  await Promise.resolve();
  vi.resetModules(); mount.mockClear(); unmount.mockClear();
  for (const key of Object.keys(registry)) delete registry[key];
  await import('../js/admin/admin-svelte.ts');
  if (typeof registry.openAdminDashboard !== 'function') {
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
  }
});

describe('admin Svelte lifecycle owner', () => {
  it('registers open/close APIs and performs real Svelte unmount before removing the container', async () => {
    const open = registry.openAdminDashboard as () => void;
    const close = registry.closeAdminDashboard as () => void;
    expect(open).toBeTypeOf('function'); expect(close).toBeTypeOf('function');
    open();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(document.getElementById('admin-overlay')).toBeTruthy();
    close();
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(document.getElementById('admin-overlay')).toBeNull();
    close();
    expect(unmount).toHaveBeenCalledTimes(1);
    open();
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it('open toggles an existing panel through the same unmount owner', () => {
    const open = registry.openAdminDashboard as () => void;
    open(); open();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(document.getElementById('admin-overlay')).toBeNull();
  });

  it('admin button is injected once only for admins and keyboard activation opens the dashboard', () => {
    const inject = registry.adminInjectButton as (u: unknown) => void;
    inject(null); inject({ isAdmin: false });
    expect(document.getElementById('btn-admin')).toBeNull();
    inject({ isAdmin: true }); inject({ isAdmin: true });
    const button = document.getElementById('btn-admin')!;
    expect(document.querySelectorAll('#btn-admin')).toHaveLength(1);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(mount).toHaveBeenCalledTimes(1);
  });
});
