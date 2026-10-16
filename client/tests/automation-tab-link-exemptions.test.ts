// The real AutomationTab must not grant links to integrations by accident.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
let permissions = 8;
let current = true;
let rules: Array<{ _id: string; type: string; enabled: boolean; config: Record<string, unknown> }> = [];
let roster: Array<{ principal: string; installationId: string; name: string }> = [];
let apiMock: ReturnType<typeof vi.fn>;
vi.mock('../js/core/permissions/myPermissions.js', () => ({
  fetchMyPermissions: async () => permissions,
  hasPerm: (mask: number, flag: number) => (mask & flag) !== 0,
  PERM_MANAGE_ROLES: 4, PERM_MANAGE_SERVER: 8,
}));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => apiMock(...args) }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: { call: () => [{ _id: 'chan1', type: 'text', name: 'general' }] },
}));
vi.mock('../js/core/server-settings/stores/serverSettingsStore', () => ({
  getCurrentServerFromRegistry: () => ({ _id: 'server1' }),
  isStillCurrentServer: () => current,
}));
import AutomationTab from '../js/core/server-settings/tabs/AutomationTab.svelte';
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
async function mount() {
  render(AutomationTab);
  await waitFor(() => expect(document.querySelector('.state[aria-live]')).toBeNull());
  for (let i = 0; i < 8; i++) { await tick(); await Promise.resolve(); }
}
const boxes = () => [...document.querySelectorAll<HTMLInputElement>('.link-exemptions input[type=checkbox]')];
beforeEach(() => {
  current = true; permissions = 8;
  roster = [
    { principal: 'bot:bot1', installationId: 'install1', name: 'Build bot' },
    { principal: 'webhook:hook1', installationId: 'hook1', name: 'CI hook' },
  ];
  rules = [{ _id: 'rule1', type: 'link_filter', enabled: true, config: { exemptIntegrations: [] } }];
  apiMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      const patch = JSON.parse(String(options.body));
      if (patch.config) rules[0]!.config = { ...rules[0]!.config, ...patch.config };
      return ok({ updated: true });
    }
    if (url.endsWith('/automod/integrations')) return ok(roster);
    if (url.endsWith('/automod')) return ok(rules);
    if (url.endsWith('/roles') || url.endsWith('/outgoing-webhooks') || url.endsWith('/reaction-roles')) return ok([]);
    return ok([]);
  });
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks(); });
describe('integration-specific AutoMod link exemption picker', () => {
  it('lists only installed integrations for a link_filter rule', async () => {
    await mount();
    expect(boxes()).toHaveLength(2);
    expect(document.querySelector('.link-exemptions')?.textContent).toContain('Build bot');
  });
  it('sends only principals, not caller-supplied installation IDs', async () => {
    await mount();
    await fireEvent.click(boxes()[0]!);
    const patch = apiMock.mock.calls.find(c => c[1]?.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch[1].body))).toEqual({ config: { exemptIntegrations: ['bot:bot1'] } });
    expect(String(patch[1].body)).not.toContain('install1');
  });
  it('only ticks current installation, not stale exception bindings', async () => {
    rules[0]!.config.exemptIntegrations = [{ principal: 'bot:bot1', installationId: 'old-install' }];
    await mount();
    expect(boxes()[0]!.checked).toBe(false);
  });
  it('does not render picker on blocked-word rules', async () => {
    rules = [{ _id: 'words', type: 'blocked_words', enabled: true, config: { words: ['x'] } }];
    await mount();
    expect(boxes()).toHaveLength(0);
  });
  it('never requests manager-only integrations without MANAGE_SERVER', async () => {
    permissions = 0;
    await mount();
    expect(boxes()).toHaveLength(0);
    expect(apiMock.mock.calls.some(call => String(call[0]).includes('/automod/integrations'))).toBe(false);
  });
  it('invalid integration roster does not create phantom checked exemptions', async () => {
    roster = [{ principal: 'bot:bot1', installationId: '', name: '' }];
    rules[0]!.config.exemptIntegrations = [{ principal: 'bot:bot1', installationId: 'install1' }];
    await mount();
    expect(boxes()[0]?.checked).not.toBe(true);
  });
});
