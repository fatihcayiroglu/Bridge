import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mountMock, unmountMock } = vi.hoisted(() => ({
  mountMock: vi.fn((_component: unknown, options: any) => ({ options, id: Symbol('settings-modal') })),
  unmountMock: vi.fn(),
}));

vi.mock('svelte', () => ({ mount: mountMock, unmount: unmountMock }));
vi.mock('../js/core/server-settings/ServerSettingsModal.svelte', () => ({ default: {} }));

describe('server settings modal lifecycle owner', () => {
  beforeEach(() => {
    vi.resetModules();
    mountMock.mockClear();
    unmountMock.mockClear();
    document.body.innerHTML = '';
  });

  it('replaces an existing modal with one real Svelte unmount', async () => {
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');
    await mod.mountServerSettingsModal('general');
    const first = mountMock.mock.results[0]!.value;
    await mod.mountServerSettingsModal('roles');
    expect(unmountMock).toHaveBeenCalledTimes(1);
    expect(unmountMock).toHaveBeenCalledWith(first);
    expect(mountMock).toHaveBeenCalledTimes(2);
    expect(mountMock.mock.calls[1]![1].props.initialTab).toBe('roles');
  });

  it('lets only the newest concurrent request mount after async loading', async () => {
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');
    const first = mod.mountServerSettingsModal('general');
    const second = mod.mountServerSettingsModal('audit');
    await Promise.all([first, second]);
    expect(mountMock).toHaveBeenCalledTimes(1);
    expect(mountMock.mock.calls[0]![1].props.initialTab).toBe('audit');
  });

  it('does not let a stale close callback unmount the replacement modal', async () => {
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');
    await mod.mountServerSettingsModal('general');
    const firstClose = mountMock.mock.calls[0]![1].props.onClose as () => void;
    await mod.mountServerSettingsModal('roles');
    const replacement = mountMock.mock.results[1]!.value;
    expect(unmountMock).toHaveBeenCalledTimes(1);

    firstClose();
    expect(unmountMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('server-settings-svelte-mount')).not.toBeNull();

    mod.unmountServerSettingsModal();
    expect(unmountMock).toHaveBeenCalledWith(replacement);
    expect(document.getElementById('server-settings-svelte-mount')).toBeNull();
  });

  it('invalidates an in-flight mount when explicitly unmounted', async () => {
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');
    const pending = mod.mountServerSettingsModal('plugins');
    mod.unmountServerSettingsModal();
    await pending;
    expect(mountMock).not.toHaveBeenCalled();
  });

  it('the live close callback disposes exactly once', async () => {
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');
    await mod.mountServerSettingsModal('general');
    const close = mountMock.mock.calls[0]![1].props.onClose as () => void;
    const instance = mountMock.mock.results[0]!.value;

    close();
    close();

    expect(unmountMock).toHaveBeenCalledOnce();
    expect(unmountMock).toHaveBeenCalledWith(instance);
    expect(document.getElementById('server-settings-svelte-mount')).toBeNull();
  });

  it('reuses an existing host element instead of duplicating ids', async () => {
    const existing = document.createElement('div');
    existing.id = 'server-settings-svelte-mount';
    document.body.appendChild(existing);
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');

    await mod.mountServerSettingsModal('media');

    expect(document.querySelectorAll('#server-settings-svelte-mount')).toHaveLength(1);
    expect(mountMock.mock.calls[0]![1].target).toBe(existing);
  });

  it('removes its host and logs when mounting rejects', async () => {
    mountMock.mockImplementationOnce(() => { throw new Error('mount failed'); });
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');

    await expect(mod.mountServerSettingsModal('general')).resolves.toBeUndefined();

    expect(document.getElementById('server-settings-svelte-mount')).toBeNull();
  });

  it('can dispose safely after another owner detached the host', async () => {
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');
    await mod.mountServerSettingsModal('general');
    const close = mountMock.mock.calls[0]![1].props.onClose as () => void;
    document.getElementById('server-settings-svelte-mount')!.remove();

    expect(() => close()).not.toThrow();
    expect(unmountMock).toHaveBeenCalledOnce();
  });

  it('does not re-remove a host detached during a failed mount', async () => {
    mountMock.mockImplementationOnce((_component: unknown, options: any) => {
      options.target.remove();
      throw new Error('detached failure');
    });
    const mod = await import('../js/core/server-settings/server-settings-svelte.ts');

    await expect(mod.mountServerSettingsModal('general')).resolves.toBeUndefined();

    expect(document.getElementById('server-settings-svelte-mount')).toBeNull();
  });
});
