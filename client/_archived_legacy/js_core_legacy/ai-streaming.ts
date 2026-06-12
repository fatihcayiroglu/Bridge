// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AiStreamingPanel.svelte
//              client/js/core/ai-streaming-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/ai-streaming.ts
// AI Streaming — SSE ile token token yanıt
// Sprint 33: JS → TS migration
// Sprint 40: window.* → ESM export + BridgeRegistry

import { getCurrentChannel, getAPI } from './globals.js';
import { BridgeRegistry } from './bridge-registry.js';

type TokenCb = (token: string) => void;
type DoneCb  = () => void;
type ErrCb   = (msg: string) => void;

// ── askAIStreaming ────────────────────────────────────────────────────────────

export function askAIStreaming(
  question:  string,
  channelId: string | undefined,
  onToken?:  TokenCb,
  onDone?:   DoneCb,
  onError?:  ErrCb,
): AbortController | undefined {
  if (!question?.trim()) return;
  const params = new URLSearchParams({ q: question });
  if (channelId) params.set('channelId', channelId);
  const token = localStorage.getItem('bridge_token');
  const url   = `${getAPI() ?? ''}/api/ai/ask/stream?${params}`;

  const ctrl = new AbortController();
  fetch(url, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError?.('AI yanıt vermedi'); return; }
    const reader = res.body!.getReader();
    const dec    = new TextDecoder();
    let buf      = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: token')) continue;
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6)) as { token?: string; done?: boolean; type?: string; message?: string };
            if (d.token !== undefined)        onToken?.(d.token);
            if ('done' in d || d.type === 'done') { onDone?.(); return; }
            if (d.message)                    { onError?.(d.message); return; }
          } catch { /* malformed SSE line */ }
        }
        if (line === 'event: done') { onDone?.(); return; }
      }
    }
    onDone?.();
  }).catch((err: Error) => {
    if (err.name !== 'AbortError') onError?.(err.message);
  });
  return ctrl;
}

// ── sendAIMessage streaming patch ────────────────────────────────────────────
// Kayıtlı sendAIMessage varsa SSE ile çalışacak şekilde wrap eder.

function _patchSendAIMessage(): boolean {
  const orig = BridgeRegistry.get<() => void>('sendAIMessage');
  if (typeof orig !== 'function') return false;

  BridgeRegistry.register('sendAIMessage', function (): void {
    const input  = document.getElementById('ai-input')  as HTMLInputElement | null;
    const output = document.getElementById('ai-output');
    const q      = input?.value?.trim() ?? '';
    if (!q || !output) { orig(); return; }

    if (input) input.value = '';
    const msgEl = document.createElement('div');
    msgEl.className = 'ai-response';
    msgEl.innerHTML = `<span class="ai-label">🤖</span><span class="ai-text"></span>`;
    output.appendChild(msgEl);
    output.scrollTop = output.scrollHeight;
    const textEl = msgEl.querySelector<HTMLElement>('.ai-text');

    askAIStreaming(
      q,
      (getCurrentChannel() as { _id?: string } | null)?._id,
      (tok) => { if (textEl) textEl.textContent += tok; output.scrollTop = output.scrollHeight; },
      () => { /* done */ },
      (err) => { if (textEl) textEl.textContent = `Hata: ${err}`; },
    );
  });
  return true;
}

if (!_patchSendAIMessage()) {
  document.addEventListener('DOMContentLoaded', _patchSendAIMessage);
}

// ── BridgeRegistry ───────────────────────────────────────────────────────────
BridgeRegistry.register('askAIStreaming', (q: unknown, ch: unknown, onToken: unknown, onDone: unknown, onError: unknown) =>
  askAIStreaming(q as string, ch as string | undefined, onToken as TokenCb, onDone as DoneCb, onError as ErrCb)
);
