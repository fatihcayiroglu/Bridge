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
import { MAX_BUNDLE_BYTES } from '../js/core/server-settings/portable-community-import.ts';

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
  it('submits the exact manually selected target when a signed source ID is __proto__', async () => {
    const signed = JSON.parse(BUNDLE);
    signed.structure.channels[0].sourceId = '__proto__';
    // No name match: the owner must select the destination explicitly.
    signed.structure.channels[0].name = 'renamed-general';
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle(JSON.stringify(signed));
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-map-channels')).not.toBeNull());
    const reserved = document.querySelector<HTMLSelectElement>('#pci-channels-__proto__');
    expect(reserved).not.toBeNull();
    expect(reserved!.value).toBe('');
    await fireEvent.change(document.querySelector('#pci-categories-sc1')!, { target: { value: 'tc1' } });
    await fireEvent.change(reserved!, { target: { value: 'tch1' } });
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
    await waitFor(() => expect(q<HTMLButtonElement>('pci-review')!.disabled).toBe(false));
    await fireEvent.click(q('pci-review')!);
    await waitFor(() => expect(q('pci-review-result')).not.toBeNull());
    expect(calls.find(call => call.url.endsWith('/signed-mapping-review'))?.body?.mapping)
      .toMatchObject({ channels: [{ sourceId: '__proto__', targetId: 'tch1' }, { sourceId: 'sch2', targetId: 'tch3' }] });
  });

  it('distinguishes same-named destination channels before the owner chooses an exact mapping', async () => {
    routes['/portable-export'] = () => respond(200, { ...TARGET, channels: [
      ...TARGET.channels, { sourceId: 'tch2', name: 'general', type: 'text', order: 2 },
    ] });
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-map-channels')).not.toBeNull());
    const select = document.querySelector<HTMLSelectElement>('#pci-channels-sch1')!;
    expect(select.value).toBe(''); // ambiguous names must never select a row implicitly
    const options = [...select.options].filter(option => option.value);
    expect(new Set(options.map(option => option.textContent)).size).toBe(2);
    for (const option of options) expect(option.textContent).toContain(option.value);
    const voice = document.querySelector<HTMLSelectElement>('#pci-channels-sch2')!;
    expect([...voice.options].find(option => option.value === 'tch3')?.textContent).toBe('chat');

    await fireEvent.change(document.querySelector('#pci-categories-sc1')!, { target: { value: 'tc1' } });
    await fireEvent.change(select, { target: { value: 'tch2' } });
    await fireEvent.change(voice, { target: { value: 'tch3' } });
    await fireEvent.click(q('pci-review')!);
    await waitFor(() => expect(q('pci-review-result')).not.toBeNull());
    expect(calls.find(call => call.url.endsWith('/signed-mapping-review'))?.body?.mapping)
      .toMatchObject({ channels: [{ sourceId: 'sch1', targetId: 'tch2' }, { sourceId: 'sch2', targetId: 'tch3' }] });
  });

  it('distinguishes same-named signed source rows in their accessible mapping labels', async () => {
    const bundle = JSON.parse(BUNDLE);
    bundle.structure.channels.push({ sourceId: 'sch3', name: 'general', type: 'text', order: 3 });
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle(JSON.stringify(bundle));
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-map-channels')).not.toBeNull());
    for (const id of ['sch1', 'sch3']) {
      expect(document.querySelector(`label[for="pci-channels-${id}"]`)?.textContent).toContain(id);
    }
    expect(document.querySelector('label[for="pci-channels-sch2"]')?.textContent).toBe('lounge');
  });

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

  it('keeps an opaque apply result uncertain while showing verification and configuration failures honestly', async () => {
    routes['/portable-import/mapped-apply'] = () => respond(422, { code: 'PORTABLE_MAPPED_APPLY_UNAVAILABLE' });
    await toReview();
    await fireEvent.click(q('pci-confirm')!);
    await fireEvent.click(q('pci-approve')!);
    await waitFor(() => expect(q('pci-apply')).not.toBeNull());
    await fireEvent.click(q('pci-apply')!);
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('unknown'));
    expect(q('pci-outcome')!.textContent?.trim()).toBe(t('pci_unknown'));
    expect(q('pci-apply')).toBeNull();
    expect(q('pci-applied')).toBeNull();
    expect(q('pci-again')).not.toBeNull();
    expect(calls.filter(call => call.url.endsWith('/mapped-apply'))).toHaveLength(1);
    expect(document.body.innerHTML).not.toContain(TOKEN);
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

/** A response the test releases by hand, to interleave owner input with a pending request. */
function deferred(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}
async function toMapping(): Promise<void> {
  render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
  await loadBundle();
  await waitFor(() => expect(q('pci-claims')).not.toBeNull());
  await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
  await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
  await fireEvent.click(q('pci-prepare')!);
  await waitFor(() => expect(q('pci-map-channels')).not.toBeNull());
  await fireEvent.change(document.querySelector('#pci-categories-sc1')!, { target: { value: 'tc1' } });
  await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
}
async function toApproval(): Promise<void> {
  await toReview();
  await fireEvent.click(q('pci-confirm')!);
  await fireEvent.click(q('pci-approve')!);
  await waitFor(() => expect(q('pci-apply')).not.toBeNull());
}

describe('PortableTab — refusals and causes', () => {
  it('reports an error instead of hanging when no API client is available', async () => {
    BridgeRegistry.unregister('apiFetch');
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await fireEvent.click(q('pci-export')!);
    await waitFor(() => expect(q('pci-export-error')?.textContent?.trim()).toBe(t('pci_error')));
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('error'));
    expect(q('pci-map-channels')).toBeNull();
  });

  it('explains a failed export by its cause and never downloads a partial snapshot', async () => {
    const created: Blob[] = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = vi.fn((b: Blob) => { created.push(b); return 'blob:x'; }) as typeof URL.createObjectURL;
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    const cases: Array<[() => Response, string]> = [
      [() => respond(403, { code: 'STEP_UP_REQUIRED' }), t('pci_proof_needed')],
      [() => respond(403, { error: 'Only the owner' }), t('pci_owner_only')],
      // A 200 that lacks one of the three signed documents is not a snapshot.
      [() => respond(200, { structure: SOURCE, permissions: { integrity: { digest: H('b') } } }), t('pci_error')],
      // An unreadable body is classified by its status alone.
      [() => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('html'); } }) as unknown as Response, t('pci_error')],
    ];
    for (const [answer, text] of cases) {
      routes['/portable-export/attested-pair'] = answer;
      await fireEvent.click(q('pci-export')!);
      await waitFor(() => expect(q('pci-export-error')?.textContent?.trim()).toBe(text));
    }
    expect(created).toHaveLength(0);
    URL.createObjectURL = original;
  });

  it('ignores an empty choice, refuses an oversized file unread, and drops a slower earlier file', async () => {
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    const input = q<HTMLInputElement>('pci-file')!;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    await fireEvent.change(input);
    expect(q('pci-file-error')).toBeNull();
    expect(q('pci-claims')).toBeNull();

    const text = vi.fn(async () => BUNDLE);
    Object.defineProperty(input, 'files', { value: [{ size: MAX_BUNDLE_BYTES + 1, text }], configurable: true });
    await fireEvent.change(input);
    await waitFor(() => expect(q('pci-file-error')).not.toBeNull());
    expect(text).not.toHaveBeenCalled();

    // The owner picks a file, then another before the first was read: only the later one counts.
    let releaseFirst!: (value: string) => void;
    const slow = new Promise<string>((r) => { releaseFirst = r; });
    Object.defineProperty(input, 'files', { value: [{ size: 10, text: () => slow }], configurable: true });
    await fireEvent.change(input);
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    releaseFirst('not json');
    await new Promise((r) => setTimeout(r, 0));
    expect(q('pci-file-error')).toBeNull();
    expect(q('pci-claims')).not.toBeNull();
  });

  it('says why an expected source address is not accepted', async () => {
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'http://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    expect(document.body.textContent).toContain(t('pci_origin_invalid'));
    expect(q<HTMLButtonElement>('pci-prepare')!.disabled).toBe(true);
    expect(q('pci-mismatch')).toBeNull();
  });

  it('refuses to map when the live target fingerprint or the owner structure is unusable', async () => {
    const attempt = async (expected: string) => {
      render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
      await loadBundle();
      await waitFor(() => expect(q('pci-claims')).not.toBeNull());
      await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
      await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
      await fireEvent.click(q('pci-prepare')!);
      await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe(expected));
      expect(q('pci-map-channels')).toBeNull();
      cleanup();
    };
    routes['/portable-import/target-fingerprint'] = () => respond(200, { targetTopologyDigest: 42 });
    await attempt('error');
    routes['/portable-import/target-fingerprint'] = () => respond(200, { targetTopologyDigest: H('e') });
    routes['/portable-export'] = () => respond(403, { error: 'Only the owner' });
    await attempt('not_owner');
    routes['/portable-export'] = () => respond(200, { ...TARGET, integrity: { digest: 'not-a-digest' } });
    await attempt('error');
  });

  it('explains a duplicate mapping choice', async () => {
    const two = JSON.stringify({
      ...JSON.parse(BUNDLE),
      structure: { ...SOURCE, categories: [{ sourceId: 'sc1', name: 'OPS', position: 0 }, { sourceId: 'sc2', name: 'DEV', position: 1 }] },
    });
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle(two);
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(q('pci-map-categories')).not.toBeNull());
    await fireEvent.change(document.querySelector('#pci-categories-sc1')!, { target: { value: 'tc1' } });
    await fireEvent.change(document.querySelector('#pci-categories-sc2')!, { target: { value: 'tc1' } });
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
    expect(q('pci-map-problem')?.textContent?.trim()).toBe(t('pci_map_duplicate'));
    expect(q<HTMLButtonElement>('pci-review')!.disabled).toBe(true);
  });

  it('asks for a fresh proof when approval needs one, and treats a malformed or invalid approval as an error', async () => {
    const cases: Array<[() => Response, string, string]> = [
      [() => respond(403, { code: 'STEP_UP_REQUIRED' }), 'proof_needed', t('pci_proof_needed')],
      [() => respond(201, { approvalToken: TOKEN, expiresAt: 'never' }), 'error', t('pci_error')],
      [() => respond(400, { code: 'PORTABLE_OWNER_APPROVAL_INVALID' }), 'invalid', t('pci_error')],
    ];
    for (const [answer, outcome, text] of cases) {
      routes['/portable-import/owner-approval'] = answer;
      await toReview();
      await fireEvent.click(q('pci-confirm')!);
      await fireEvent.click(q('pci-approve')!);
      await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe(outcome));
      expect(q('pci-outcome')!.textContent?.trim()).toBe(text);
      expect(q('pci-outcome')!.className).toContain('pci-error');
      expect(q('pci-apply')).toBeNull();
      expect(document.body.innerHTML).not.toContain(TOKEN);
      cleanup();
    }
  });

  it('never reports success for an apply answer that did not commit', async () => {
    routes['/portable-import/mapped-apply'] = () => respond(200, { applied: true, transactionCommitted: false });
    await toApproval();
    await fireEvent.click(q('pci-apply')!);
    await waitFor(() => expect(q('pci-outcome')?.getAttribute('data-outcome')).toBe('error'));
    expect(q('pci-applied')).toBeNull();
    expect(q('pci-apply')).toBeNull();
  });

  it('shows zero counts rather than inventing them when a committed apply omits them', async () => {
    routes['/portable-import/mapped-apply'] = () => respond(200, { applied: true, transactionCommitted: true });
    await toApproval();
    await fireEvent.click(q('pci-apply')!);
    await waitFor(() => expect(q('pci-applied')).not.toBeNull());
    expect(q('pci-applied')!.textContent?.trim()).toBe(t('pci_applied', undefined, { categories: 0, roles: 0, channels: 0 }));
    // After a finished import the owner can start a fresh check of the live target.
    const before = calls.filter(c => c.url.endsWith('target-fingerprint')).length;
    await fireEvent.click(q('pci-again')!);
    await waitFor(() => expect(calls.filter(c => c.url.endsWith('target-fingerprint')).length).toBe(before + 1));
  });

  it('says nothing is renamed and treats a review without counts as having no findings', async () => {
    routes['/portable-export'] = () => respond(200, {
      ...TARGET,
      categories: [{ sourceId: 'tc1', name: 'OPS', position: 0 }],
      channels: [{ sourceId: 'tch1', name: 'general', type: 'text', order: 1 }, { sourceId: 'tch3', name: 'lounge', type: 'voice', order: 3 }],
    });
    routes['/portable-import/signed-mapping-review'] = () => respond(200, { reviewFingerprint: H('f') });
    await toReview();
    expect(document.body.textContent).toContain(t('pci_renames_none'));
    expect(q('pci-renames')).toBeNull();
    expect(q('pci-widening')).toBeNull();
    expect(q('pci-approve')).not.toBeNull();
  });

  it('labels a role rename as a role', async () => {
    routes['/portable-export'] = () => respond(200, { ...TARGET, roles: [{ sourceId: 'tr1', name: 'crew', position: 1, permissions: 256 }] });
    await toReview();
    expect(q('pci-renames')?.textContent).toContain(`${t('pci_kind_roles')}: crew → Crew`);
  });
});

describe('PortableTab — late answers never overwrite newer owner input', () => {
  it('drops a target check answer that arrives after the owner edited the expected source', async () => {
    const pending = deferred();
    routes['/portable-import/target-fingerprint'] = () => pending.promise;
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-2' } });
    pending.resolve(respond(200, { targetTopologyDigest: H('e') }));
    await new Promise((r) => setTimeout(r, 0));
    expect(q('pci-map-channels')).toBeNull();
    expect(calls.some(c => c.url === '/portable-export')).toBe(false);
    // The owner is not locked out: the corrected source can be checked.
    expect(q<HTMLButtonElement>('pci-prepare')!.disabled).toBe(false);
  });

  it('drops a structure answer that arrives after the owner edited the expected source', async () => {
    const pending = deferred();
    routes['/portable-export'] = () => pending.promise;
    render(PortableTab, { props: { serverId: 'dst-1', isOwner: true } });
    await loadBundle();
    await waitFor(() => expect(q('pci-claims')).not.toBeNull());
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://source.example' } });
    await fireEvent.input(q('pci-source-id')!, { target: { value: 'src-1' } });
    await fireEvent.click(q('pci-prepare')!);
    await waitFor(() => expect(calls.some(c => c.url === '/portable-export')).toBe(true));
    await fireEvent.input(q('pci-origin')!, { target: { value: 'https://other.example' } });
    pending.resolve(respond(200, TARGET));
    await new Promise((r) => setTimeout(r, 0));
    expect(q('pci-map-channels')).toBeNull();
    expect(q<HTMLButtonElement>('pci-prepare')!.disabled).toBe(false);
  });

  it('drops a review answer that arrives after a mapping change', async () => {
    const pending = deferred();
    routes['/portable-import/signed-mapping-review'] = () => pending.promise;
    await toMapping();
    await fireEvent.click(q('pci-review')!);
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: '' } });
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
    pending.resolve(respond(200, { reviewFingerprint: H('f'), counts: {} }));
    await new Promise((r) => setTimeout(r, 0));
    expect(q('pci-review-result')).toBeNull();
    expect(q('pci-approve')).toBeNull();
    // The changed mapping can be reviewed again.
    expect(q<HTMLButtonElement>('pci-review')!.disabled).toBe(false);
  });

  it('drops an approval that arrives after a mapping change, so its token is never offered', async () => {
    const pending = deferred();
    routes['/portable-import/owner-approval'] = () => pending.promise;
    await toReview();
    await fireEvent.click(q('pci-confirm')!);
    await fireEvent.click(q('pci-approve')!);
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: '' } });
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
    pending.resolve(respond(201, { approvalToken: TOKEN, expiresAt: new Date(Date.now() + 120_000).toISOString() }));
    await new Promise((r) => setTimeout(r, 0));
    expect(q('pci-apply')).toBeNull();
    expect(q('pci-approved')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(q<HTMLButtonElement>('pci-review')!.disabled).toBe(false);
  });

  it('drops an apply answer that arrives after a mapping change instead of reporting it as this import', async () => {
    const pending = deferred();
    routes['/portable-import/mapped-apply'] = () => pending.promise;
    await toApproval();
    await fireEvent.click(q('pci-apply')!);
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: '' } });
    await fireEvent.change(document.querySelector('#pci-channels-sch2')!, { target: { value: 'tch3' } });
    pending.resolve(respond(200, { applied: true, transactionCommitted: true, changed: { categories: 1, roles: 0, channels: 1 } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(q('pci-applied')).toBeNull();
    expect(q('pci-outcome')).toBeNull();
    expect(q('pci-apply')).toBeNull();
    // The owner reviews the live state again instead of being stuck.
    expect(q<HTMLButtonElement>('pci-review')!.disabled).toBe(false);
  });
});
