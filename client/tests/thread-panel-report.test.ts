// client/tests/thread-panel-report.test.ts
//
// P7 B5: a thread reply can be reported like a channel message. The panel
// offers it on other people's replies only, posts to the thread route
// (POST /api/threads/:threadId/messages/:id/report) and tells the reporter the
// outcome. The dialog renders outside the panel: Escape closes only the dialog,
// and Enter in its note never sends the thread draft.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import ThreadPanel from '../js/core/ThreadPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const OWNED_KEYS = ['apiFetch', 'socket', 'getMe', 'toast', 'openThread', 'openExistingThread', 'closeThread'];
const REPORT_URL = '/api/threads/thr-1/messages/tm-other/report';

let apiFetch: ReturnType<typeof vi.fn>;
let toast: ReturnType<typeof vi.fn>;
let reportResponse: () => Promise<Response>;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) { await tick(); await Promise.resolve(); }
}

const panel = () => document.querySelector('.thread-panel');
const dialog = () => document.querySelector('.report-dialog');
const reportButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.thread-report')];
const reportCalls = () => apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/report'));

async function openPanel(): Promise<void> {
  render(ThreadPanel);
  BridgeRegistry.call('openExistingThread', 'thr-1', '');
  await waitFor(() => expect(panel()).not.toBeNull());
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  reportResponse = async () => response({ reported: true, created: true, id: 'rep-1' }, 201);
  apiFetch = vi.fn(async (url: string) => {
    if (url.endsWith('/report')) return reportResponse();
    if (url.includes('/messages')) {
      return response([
        { _id: 'tm-mine', userId: 'me', displayName: 'Ben', content: 'kendi yanıtım', createdAt: 1000 },
        { _id: 'tm-other', userId: 'u-2', displayName: 'Diğeri', content: 'kötü yanıt', createdAt: 2000 },
      ]);
    }
    return response({ _id: 'thr-1', channelId: 'ch-1', serverId: 'srv-1', name: 'Konu' });
  });
  toast = vi.fn();
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('getMe', (() => ({ _id: 'me' })) as never);
  BridgeRegistry.register('toast', toast as never);
  BridgeRegistry.register('socket', { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as never);
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ThreadPanel — reporting a reply', () => {
  it('offers the report action on other people\'s replies only', async () => {
    await openPanel();
    const buttons = reportButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest('.thread-message')!.textContent).toContain('kötü yanıt');
  });

  it('posts the reason and note to the thread route and closes on acceptance, restoring focus', async () => {
    await openPanel();
    const button = reportButtons()[0]!;
    button.click();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(panel()!.contains(dialog())).toBe(false);

    await fireEvent.change(document.querySelector<HTMLSelectElement>('.report-reason')!, { target: { value: 'harassment' } });
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>('.report-form textarea')!, { target: { value: '  tekrar ediyor  ' } });
    document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
    await waitFor(() => expect(dialog()).toBeNull());

    expect(reportCalls()).toHaveLength(1);
    const [url, init] = reportCalls()[0]!;
    expect(url).toBe(REPORT_URL);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reason: 'harassment', detail: 'tekrar ediyor' });
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'success');
    await flush();
    expect(document.activeElement).toBe(button);
    expect(panel()).not.toBeNull();
  });

  it('a duplicate report is still a success; a refused one keeps the dialog open with an error', async () => {
    await openPanel();
    reportResponse = async () => response({ reported: true, created: false, id: 'rep-1' }, 200);
    reportButtons()[0]!.click();
    await flush();
    document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
    await waitFor(() => expect(dialog()).toBeNull());
    expect(toast).toHaveBeenLastCalledWith(expect.any(String), 'success');

    for (const status of [400, 404, 503]) {
      reportResponse = async () => response({ error: 'x' }, status);
      reportButtons()[0]!.click();
      await flush();
      document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
      await waitFor(() => expect(document.querySelector('.report-dialog [role="alert"]')).not.toBeNull());
      expect(toast).toHaveBeenLastCalledWith(expect.any(String), 'error');
      document.querySelector<HTMLButtonElement>('.report-actions button')!.click();   // cancel
      await flush();
      expect(dialog()).toBeNull();
    }
  });

  it('an unverifiable reply (malformed response) or a network error is reported as a failure', async () => {
    await openPanel();
    for (const fail of [async () => response({ reported: true }, 201), async () => { throw new Error('offline'); }]) {
      reportResponse = fail;
      reportButtons()[0]!.click();
      await flush();
      document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
      await waitFor(() => expect(document.querySelector('.report-dialog [role="alert"]')).not.toBeNull());
      expect(toast).toHaveBeenLastCalledWith(expect.any(String), 'error');
      document.querySelector<HTMLButtonElement>('.report-actions button')!.click();
      await flush();
    }
  });

  it('Escape closes only the dialog, and Enter in the note never sends the thread draft', async () => {
    await openPanel();
    const composer = document.querySelector<HTMLTextAreaElement>('.thread-composer')!;
    await fireEvent.input(composer, { target: { value: 'taslak' } });
    reportButtons()[0]!.click();
    await flush();

    const note = document.querySelector<HTMLTextAreaElement>('.report-form textarea')!;
    await fireEvent.keyDown(note, { key: 'Enter' });
    await fireEvent.keyDown(document.querySelector('.report-dialog')!, { key: 'Escape' });
    await flush();

    expect(dialog()).toBeNull();
    expect(panel()).not.toBeNull();
    expect(apiFetch.mock.calls.some(([url, init]) => String(url) === '/api/threads/thr-1/messages'
      && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    expect(composer.value).toBe('taslak');
  });

  it('closing the panel drops an open report form', async () => {
    await openPanel();
    reportButtons()[0]!.click();
    await flush();
    expect(dialog()).not.toBeNull();
    BridgeRegistry.call('closeThread');
    await flush();
    expect(dialog()).toBeNull();
    expect(reportCalls()).toHaveLength(0);
  });
});
