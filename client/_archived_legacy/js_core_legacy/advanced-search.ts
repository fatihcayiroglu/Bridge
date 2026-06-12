// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AdvancedSearchPanel.svelte
//              client/js/core/advanced-search-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/advanced-search.ts
// Gelişmiş Arama UI — from: before: after: has:file filtreleri + sayfalama
// Sprint 38: window.* → BridgeRegistry.register/wrap geçişi

import { BridgeRegistry } from './bridge-registry.js';
import { getAPI } from './globals.js';
import { escHtml } from './utils.js';

// ── Domain types ─────────────────────────────────────────────────────────────
interface GsMessage {
  _id: string;
  displayName?: string;
  username?: string;
  content?: string;
  createdAt: string;
  channelId?: string;
  /** Server tarafından highlight() ile üretilmiş <mark> içeren snippet */
  highlight?: string;
  /** Server tarafından eklenen kanal adı */
  channelName?: string;
}
interface GsData {
  messages?: GsMessage[];
  messagesHasMore?: boolean;
  messagesTotalCount?: number;
  error?: string;
  [k: string]: unknown;
}

// ── Filter bar injection ──────────────────────────────────────────────────────
function injectSearchFilters(): void {
  const modal = document.getElementById('global-search-modal');
  if (!modal || modal.dataset['v44']) return;
  modal.dataset['v44'] = '1';
  const inputWrap =
    modal.querySelector('.gs-input-wrap') ??
    (modal.querySelector('input') as HTMLInputElement | null)?.parentElement;
  if (!inputWrap) return;

  const filterBar = document.createElement('div');
  filterBar.id = 'gs-filter-bar';
  filterBar.innerHTML = `
    <div class="gs-filter-row">
      <span class="gs-filter-label">Filtreler:</span>
      <label class="gs-chip"><span>👤 Kim:</span>
        <input id="gsf-from" type="text" placeholder="kullanıcı adı" class="gs-chip-input"></label>
      <label class="gs-chip"><span>📅 Önce:</span>
        <input id="gsf-before" type="date" class="gs-chip-input"></label>
      <label class="gs-chip"><span>📅 Sonra:</span>
        <input id="gsf-after" type="date" class="gs-chip-input"></label>
      <label class="gs-chip"><span>📁 Sadece:</span>
        <select id="gsf-has" class="gs-chip-input">
          <option value="">Tümü</option>
          <option value="file">Dosyalar</option>
          <option value="image">Resimler</option>
          <option value="link">Linkler</option>
        </select></label>
      <label class="gs-chip"><span>#️⃣ Kanal:</span>
        <input id="gsf-in" type="text" placeholder="kanal-adı" class="gs-chip-input"></label>
      <button class="gs-clear-filters" data-bridge-action="clearGsFilters">✕ Temizle</button>
    </div>
    <div id="gs-filter-hint" style="font-size:11px;color:var(--text-muted);margin-top:4px;padding-left:4px">
      💡 İpucu: Sorguda <code>from:ahmet</code>, <code>before:2024-01-01</code>, <code>has:file</code>, <code>has:link</code> yazabilirsiniz
    </div>`;
  inputWrap.after(filterBar);

  filterBar.querySelectorAll('input,select').forEach((el) => {
    el.addEventListener('change', () => {
      const q = (document.getElementById('gs-input') as HTMLInputElement | null)?.value;
      if (q) void BridgeRegistry.call('doGlobalSearch', q);
    });
  });
}

function buildFullQ(q: string): string {
  let full = q;
  const from   = (document.getElementById('gsf-from')   as HTMLInputElement  | null)?.value?.trim();
  const before = (document.getElementById('gsf-before') as HTMLInputElement  | null)?.value;
  const after  = (document.getElementById('gsf-after')  as HTMLInputElement  | null)?.value;
  const has    = (document.getElementById('gsf-has')    as HTMLSelectElement | null)?.value;
  const inChan = (document.getElementById('gsf-in')     as HTMLInputElement  | null)?.value?.trim();
  if (from)   full += ` from:${from}`;
  if (before) full += ` before:${before}`;
  if (after)  full += ` after:${after}`;
  if (has)    full += ` has:${has}`;
  if (inChan) full += ` in:${inChan.replace(/^#/, '')}`;
  return full;
}

// ── Core search ───────────────────────────────────────────────────────────────
async function doGlobalSearch(q: string): Promise<void> {
  injectSearchFilters();
  const currentServer = BridgeRegistry.get<() => { _id: string } | null>('getCurrentServer')?.();
  if (!currentServer) return;
  const res = document.getElementById('gs-results');
  if (!res) return;

  const gsTab = (BridgeRegistry.call('getGsTab') as string | undefined) ?? 'messages';
  const fullQ = buildFullQ(q);
  res.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Aranıyor...</div>';

  try {
    const API    = getAPI();
    const token  = localStorage.getItem('token');
    const params = new URLSearchParams({ q: fullQ, serverId: currentServer._id, type: gsTab });
    const r      = await fetch(`${API}/api/search?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data   = await r.json() as GsData;

    if (!r.ok) {
      // 503 → FTS backend hazır değil: kullanıcıya dost mesaj göster
      const userMsg = r.status === 503
        ? 'Arama indeksi henüz hazır değil. Lütfen birkaç dakika sonra tekrar deneyin.'
        : (data.error ?? 'Arama başarısız');
      res.innerHTML = `<div style="color:var(--red);padding:16px">${escHtml(userMsg)}</div>`;
      return;
    }

    BridgeRegistry.call('renderGsResults', data, q);
    if (data.messagesHasMore) {
      const btn = document.createElement('button');
      btn.className   = 'gs-load-more';
      btn.textContent = `⬇️ Daha fazla (${data.messagesTotalCount ?? ''} sonuç)`;
      btn.onclick     = () => void BridgeRegistry.call('loadMoreSearchResults', fullQ, 25);
      res.appendChild(btn);
    }
  } catch {
    res.innerHTML = '<div style="color:var(--red);padding:16px">Arama başarısız</div>';
  }
}

function clearGsFilters(): void {
  ['gsf-from', 'gsf-before', 'gsf-after', 'gsf-in'].forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = '';
  });
  const sel = document.getElementById('gsf-has') as HTMLSelectElement | null;
  if (sel) sel.value = '';
  const q = (document.getElementById('gs-input') as HTMLInputElement | null)?.value;
  if (q) void BridgeRegistry.call('doGlobalSearch', q);
}

async function loadMoreSearchResults(fullQ: string, offset: number): Promise<void> {
  const res = document.getElementById('gs-results');
  const currentServer = BridgeRegistry.get<() => { _id: string } | null>('getCurrentServer')?.();
  if (!res || !currentServer) return;

  const API    = getAPI();
  const token  = localStorage.getItem('token');
  const params = new URLSearchParams({ q: fullQ, serverId: currentServer._id, type: 'messages', offset: String(offset) });
  const r      = await fetch(`${API}/api/search?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data   = await r.json() as GsData;
  res.querySelector('.gs-load-more')?.remove();
  BridgeRegistry.call('renderGsResults', { messages: data.messages ?? [] }, fullQ.split(' ')[0], true);

  if (data.messagesHasMore) {
    const btn = document.createElement('button');
    btn.className   = 'gs-load-more';
    btn.textContent = '⬇️ Daha fazla';
    btn.onclick     = () => void BridgeRegistry.call('loadMoreSearchResults', fullQ, offset + 25);
    res.appendChild(btn);
  }
}

function renderGsResults(data: GsData, q: string, append = false): void {
  const res = document.getElementById('gs-results');
  if (!res) return;
  if (!append) {
    // default render — mevcut (non-append) davranışı koru
    res.innerHTML = '';
    for (const msg of data.messages ?? []) _appendGsResult(res, msg);
    return;
  }
  for (const msg of data.messages ?? []) _appendGsResult(res, msg);
}

function _appendGsResult(res: HTMLElement, msg: GsMessage): void {
  const div = document.createElement('div');
  div.className = 'gs-result-item';

  // Tarih + saat — toLocaleString ile hem gün hem saat göster
  const dateStr = escHtml(
    new Date(msg.createdAt).toLocaleString('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  );

  // Kanal adı: server'dan gelen channelName varsa kullan, yoksa id son 6 karakter
  const chanLabel = msg.channelName
    ? escHtml(msg.channelName)
    : escHtml(msg.channelId?.slice(0, 6) ?? '?');

  // highlight: server <mark> tag'leri içerebilir — güvenli subset olarak izin ver
  // (server zaten escHtml çalıştırıyor; sadece <mark> açıp kapıyoruz)
  const highlightHtml = msg.highlight
    ? msg.highlight.replace(/<(?!\/?mark>)/gi, '&lt;')   // <mark> dışındakileri escape et
    : escHtml(msg.content?.slice(0, 200) ?? '[dosya]');

  div.innerHTML = `
    <div class="gs-result-meta">
      <strong>${escHtml(msg.displayName ?? msg.username ?? '?')}</strong>
      <span class="gs-result-time">${dateStr}</span>
      <span class="gs-result-chan">#${chanLabel}</span>
    </div>
    <div class="gs-result-text">${highlightHtml}</div>`;
  div.onclick = () => {
    BridgeRegistry.call('jumpToMessage', msg._id, msg.channelId ?? '');
    BridgeRegistry.call('closeGlobalSearch');
  };
  res.appendChild(div);
}

// ── Registry kayıtları ────────────────────────────────────────────────────────
// wrap: mevcut kayıt varsa üzerine yaz; yoksa doğrudan register
BridgeRegistry.wrap('doGlobalSearch', (_orig, ...args) =>
  doGlobalSearch(args[0] as string));
BridgeRegistry.wrap('renderGsResults', (_orig, ...args) =>
  renderGsResults(args[0] as GsData, args[1] as string, args[2] as boolean | undefined));
BridgeRegistry.register('clearGsFilters',        clearGsFilters);
BridgeRegistry.register('loadMoreSearchResults',  loadMoreSearchResults as (...a: unknown[]) => unknown);

export { doGlobalSearch, clearGsFilters, loadMoreSearchResults, renderGsResults };
