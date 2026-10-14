// P7 C4 — owner-facing portable import/export tab: the full owner journey
// against a mocked apiFetch, every refusal state, and the token never leaking.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'en', localeTick: () => 0 };
});
import { t } from '../js/core/i18n/index.ts';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import PortableTab from '../js/core/server-settings/tabs/PortableTab.svelte';

const H = (c: string) => c.repeat(64);
const TOKEN = 'TokenThatMustNeverReachTheDomOrStorage_0123'.slice(0, 43);
const SOURCE = {
  categories: [{ sourceId: 'sc1', name: 'OPS', position: 0, collapsed: true }],
  roles: [{ sourceId: 'sr1', name: 'Crew', color: '#336699', position: 1, permissions: 256 }],
  channels: [{ sourceId: 'sch1', name: 'general', type: 'text', order: 1 }, { sourceId: 'sch2', name: 'lounge', type: 'voice', order: 2 }],
  integrity: { digest: H('a') },
};
const TARGET = {
  categories: [{ sourceId: 'tc1', name: 'Old', position: 0 }],
  roles: [{ sourceId: 'tr1', name: 'Crew', position: 1, permissions: 256 }],
  channels: [{ sourceId: 'tch1', name: 'general', type: 'text', order: 1 }, { sourceId: 'tch3', name: 'chat', type: 'voice', order: 3 }],
  integrity: { digest: H('d') },
};
const BUNDLE = JSON.stringify({
  structure: SOURCE,
  permissions: { channels: [], integrity: { digest: H('b') } },
  attestation: {
    sourceOrigin: 'https://source.example', sourceServerId: 'src-1', keyFingerprint: H('c'),
    issuedAt: '2026-10-14T10:00:00.000Z', expiresAt: '2099-10-14T10:05:00.000Z', signature: 'sig',
  },
});

type Handler = (url: string, init?: RequestInit) => unknown;
let routes: Record<string, Handler>;
let calls: Array<{ url: string; body: Record<string, unknown> | null }>;

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
function key(url: string): string { return url.replace('/api/servers/dst-1', ''); }

beforeEach(() => {
  document.body.innerHTML = '';
  calls = [];
  routes = {
    '/portable-import/target-fingerprint': () => respond(200, { targetTopologyDigest: H('e') }),
    '/portable-export': () => respond(200, TARGET),
    '/portable-import/signed-mapping-review': () => respond(200, {
      reviewFingerprint: H('f'), counts: { unsafeRoleMappings: 0, unsupportedPermissionRows: 0 },
    }),
    '/portable-import/owner-approval': () => respond(201, { approvalToken: TOKEN, expiresAt: new Date(Date.now() + 120_000).toISOString() }),
    '/portable-import/mapped-apply': () => respond(200, {
      applied: true, transactionCommitted: true, changed: { categories: 1, roles: 1, channels: 2 },
    }),
  };
  BridgeRegistry.register('apiFetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: key(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const handler = routes[key(url)];
    if (!handler) throw new Error('unexpected ' + url);
    return handler(url, init);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);

async function loadBundle(text = BUNDLE): Promise<void> {
  const input = q<HTMLInputElement>('pci-file')!;
  const file = new File([text], 'snapshot.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await fireEvent.change(input);
}

async function toReview(): Promise<void> {
  render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
  await loadBundle();
  await waitFor(() => expect(q('pci-claims')).not.toBeNull());
  await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
  await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
  await fireEvent.click(q('pci-prepare')!);
  await waitFor(() => expect(q('pci-map-channels')).not.toBeNull());
  // Unambiguous names were pre-selected; the owner chooses the rest.
  await fireEvent.change(document.querySelector('#pci-categories-sc1')!, { target: { value: 'tc1' } });
  await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
  await waitFor(() => expect(q<HTMLButtonElement>('pci-review')!.disabled).toBe(false));
  await fireEvent.click(q('pci-review')!);
  await waitFor(() => expect(q('pci-review-result')).not.toBeNull());
}

describe('PortableTab', () => {
  it('shows only an explanation to a non-owner and makes no request', () => {
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: false } });
    expect(q('pci-owner-only')?.textContent).toBe(t('pci_owner_only'));
    expect(q('pci-file')).toBeNull();
    expect(q('pci-export')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('downloads only the three signed documents, and explains when signing is not configured', async () => {
    const created: Blob[] = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = vi.fn((b: Blob) => { created.push(b); return 'blob:x'; }) as typeof URL.createObjectURL;
    routes['/portable-export/attested-pair'] = () => respond(200, {
      structure: SOURCE, permissions: { integrity: { digest: H('b') } }, attestation: { signature: 's' }, writesPerformed: false,
    });
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await fireEvent.click(q('pci-export')!);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(Object.keys(JSON.parse(await created[0]!.text()))).toEqual(['structure', 'permissions', 'attestation']);
    routes['/portable-export/attested-pair'] = () => respond(503, { code: 'PORTABLE_SOURCE_ATTESTED_EXPORT_UNAVAILABLE' });
    await fireEvent.click(q('pci-export')!);
    await waitFor(() => expect(q('pci-export-error')?.textContent?.trim()).toBe(t('pci_export_disabled')));
    URL.createObjectURL = original;
  });

  it('rejects a file that is not a signed snapshot', async () => {
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle('{"structure":{}}');
    await waitFor(() => expect(q('pci-file-error')).not.toBeNull());
    expect(q('pci-claims')).toBeNull();
  });

  it('warns when the owner-entered source differs from what the file claims', async () => {
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'other-community' } });
    expect(q('pci-mismatch')).not.toBeNull();
    // The owner's value, not the file's claim, is what gets verified.
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-map-channels')).not.toBeNull());
    await fireEvent.change(document.querySelector('#pci-categories-sc1')!, { target: { value: 'tc1' } });
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
    await fireEvent.click(q('pci-review')!);
    await waitFor(() => expect(calls.some(c => c.url.endsWith('signed-mapping-review'))).toBe(true));
    expect(calls.find(c => c.url.endsWith('signed-mapping-review'))!.body!.expectedSourceServerId).toBe('other-community');
  });

  it('runs review -> approve -> apply, shows what changes, and never exposes the approval token', async () => {
    await toReview();
    expect(q('pci-renames')?.textContent).toContain('Old → OPS');
    expect(q('pci-renames')?.textContent).toContain('chat → lounge');
    expect(q<HTMLButtonElement>('pci-approve')!.disabled).toBe(true);   // explicit consent first
    await fireEvent.click(q('pci-confirm')!);
    await fireEvent.click(q('pci-approve')!);
    await waitFor(() => expect(q('pci-apply')).not.toBeNull());
    const approval = calls.find(c => c.url.endsWith('owner-approval'))!.body!;
    expect(approval).toMatchObject({ confirmedReviewFingerprint: H('f'), confirmation: 'CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES' });
    expect(document.body.innerHTML).not.toContain(TOKEN);
    await fireEvent.click(q('pci-apply')!);
    await waitFor(() => expect(q('pci-applied')).not.toBeNull());
    expect(q('pci-applied')!.textContent).toBe(t('pci_applied', undefined, { categories: 1, roles: 1, channels: 2 }));
    const applyCall = calls.find(c => c.url.endsWith('mapped-apply'))!.body!;
    expect(applyCall).toMatchObject({ approvalToken: TOKEN, confirmation: 'APPLY_MAPPED_PORTABLE_METADATA_ONLY' });
    expect(q('pci-apply')).toBeNull();                                  // a token is never offered twice
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });

  it('reports "outcome unknown" (not failure) when the apply connection drops, and withdraws the token', async () => {
    routes['/portable-import/mapped-apply'] = () => { throw new TypeError('network down'); };
    await toReview();
    await fireEvent.click(q('pci-confirm')!);
    await fireEvent.click(q('pci-approve')!);
    await waitFor(() => expect(q('pci-apply')).not.toBeNull());
    await fireEvent.click(q('pci-apply')!);
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('unknown'));
    expect(q('pci-outcome')!.textContent?.trim()).toBe(t('pci_unknown'));
    expect(q('pci-apply')).toBeNull();
    expect(q('pci-again')).not.toBeNull();
  });

  it('shows a refused apply, a failed verification and a disabled installation honestly', async () => {
    routes['/portable-import/mapped-apply'] = () => respond(422, { code: 'PORTABLE_MAPPED_APPLY_UNAVAILABLE' });
    await toReview();
    await fireEvent.click(q('pci-confirm')!);
    await fireEvent.click(q('pci-approve')!);
    await waitFor(() => expect(q('pci-apply')).not.toBeNull());
    await fireEvent.click(q('pci-apply')!);
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('refused'));
    cleanup();

    routes['/portable-import/signed-mapping-review'] = () => respond(422, { code: 'PORTABLE_SIGNED_MAPPING_REVIEW_INVALID' });
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-map-channels')).not.toBeNull());
    await fireEvent.change(document.querySelector('#pci-categories-sc1')!, { target: { value: 'tc1' } });
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
    await fireEvent.click(q('pci-review')!);
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('unverified'));
    expect(q('pci-review-result')).toBeNull();
    cleanup();

    routes['/portable-import/target-fingerprint'] = () => respond(503, { code: 'PORTABLE_SIGNED_MAPPING_TRUST_UNAVAILABLE' });
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('disabled'));
  });

  it('blocks approval when the review reports role widening or unsupported grants', async () => {
    routes['/portable-import/signed-mapping-review'] = () => respond(200, {
      reviewFingerprint: H('f'), counts: { unsafeRoleMappings: 2, unsupportedPermissionRows: 1 },
    });
    await toReview();
    expect(q('pci-widening')?.textContent).toBe(t('pci_widening', undefined, { count: 2 }));
    expect(q('pci-unsupported')).not.toBeNull();
    expect(q('pci-approve')).toBeNull();
    expect(calls.some(c => c.url.endsWith('owner-approval'))).toBe(false);
  });

  it('withdraws an approval when it expires before it is applied', async () => {
    routes['/portable-import/owner-approval'] = () => respond(201, {
      approvalToken: TOKEN, expiresAt: new Date(Date.now() + 1_500).toISOString(),
    });
    await toReview();
    await fireEvent.click(q('pci-confirm')!);
    await fireEvent.click(q('pci-approve')!);
    await waitFor(() => expect(q('pci-apply')).not.toBeNull());
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('expired'), { timeout: 4_000 });
    expect(q('pci-apply')).toBeNull();
    expect(calls.some(c => c.url.endsWith('mapped-apply'))).toBe(false);
  });

  it('invalidates the review when the owner changes a mapping choice', async () => {
    await toReview();
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: '' } });
    expect(q('pci-review-result')).toBeNull();
    expect(q('pci-map-problem')?.textContent?.trim()).toBe(t('pci_map_unmapped'));
    expect(q<HTMLButtonElement>('pci-review')!.disabled).toBe(true);
  });
});
