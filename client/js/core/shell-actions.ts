// client/js/core/shell-actions.ts
// UX/P1 — KABUK EYLEM KÖPRÜSÜ (ölü `data-bridge-action` dispatcher'ının yerine).
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (canlı üründe ölçüldü)
// ════════════════════════════════════════════════════════════════════════════
// `index.html` içindeki dispatcher KLASİK (module olmayan) bir inline script'tir
// ve şu korumayı kullanır:
//
//     if (typeof BridgeRegistry !== 'undefined' && BridgeRegistry.has(action))
//
// Ancak `BridgeRegistry` bir ESM dışa aktarımıdır ve HİÇBİR YERDE `window`a
// atanmaz (`NotificationsTab.svelte` bunu zaten belgelemişti). Klasik script'te
// `typeof BridgeRegistry` daima `'undefined'`tır → registry dalı HİÇ çalışmaz →
// akış yalnızca 4 vakalık legacy `switch`e düşer.
//
// SONUÇ (canlı tarayıcıda tıklanarak ölçüldü — DOM'da 0 bayt değişim):
//     Direkt mesajlar  → ÖLÜ
//     Arkadaşlar       → ÖLÜ
//     Ara              → ÖLÜ   (Faz F'de "WORKING" sayılmıştı; düğme çalışmıyordu)
//     Sunucu ekle      → ÖLÜ
// Bu düğmelerin hepsinin registry KAYDI vardı; eksik olan KÖPRÜYDÜ.
// "Kayıt var" ≠ "kullanıcı ulaşabiliyor".
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN `window.BridgeRegistry` ATANMADI
// ════════════════════════════════════════════════════════════════════════════
// Global atamak eski dispatcher'ı canlandırırdı; ancak ZATEN bileşen tarafından
// bağlanmış düğmeler İKİ KEZ tetiklenirdi (ayarlar iki kez açılır, üye listesi
// iki kez değişip yerinde kalırdı). Yani çalışan düğmeleri BOZARDI.
//
// Bunun yerine bu modül, kod tabanının halihazırda kullandığı DELEGE DİNLEYİCİ
// desenini izler (`settings-modal-svelte.ts` ayarlar düğmesini böyle yakalar).
//
// ÇİFT TETİKLEME KORUMASI: aşağıdaki eylemler kendi sahipleri tarafından
// DOĞRUDAN bağlanır ve burada BİLEREK ele alınmaz.
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';

const log = createLogger('ShellActions');

/**
 * Kendi bileşeni tarafından zaten bağlanan eylemler — burada ELE ALINMAZ.
 *   sendMessage       → MessageInputPanel.svelte (gönder düğmesi)
 *   openSettingsModal → settings-modal-svelte.ts (delege dinleyici)
 *   toggleMemberList  → MemberListPanel.svelte   (#btn-members)
 *   openServerMenu    → ServerMenu.svelte        (#server-header-btn)
 */
const COMPONENT_BOUND = new Set([
  'sendMessage',
  'openSettingsModal',
  'toggleMemberList',
  'openServerMenu',
]);

// ── Final21 UX (U-14): telefonda kanal başlığı taşma menüsü ─────────────────
// 390 px'te on başlık simgesi kanal adını "# ge…"ye indiriyordu; sabitlenmişler telefonda
// hiç görünmüyordu. CSS telefonda yalnız aramayı ve "⋯"yi bırakır; bu menü gizlenen
// düğmeleri açılış anında listeler ve tıklamayı ASIL düğmeye iletir. Böylece durum
// (üye listesi aria-pressed), izinle eklenen düğmeler ve eylem sahipleri tek yerde kalır.
let moreMenu: HTMLElement | null = null;

function closeHeaderMore(restoreFocus: boolean): void {
  if (!moreMenu) return;
  moreMenu.remove();
  moreMenu = null;
  const trigger = document.getElementById('btn-header-more');
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus();
}

function openHeaderMore(trigger: HTMLElement): void {
  const bar = trigger.closest('.channel-header-actions');
  if (!bar) return;
  const sources = [...bar.querySelectorAll<HTMLButtonElement>(':scope > button')].filter((b) =>
    b !== trigger && b.id !== 'btn-search' && !b.hidden && !b.disabled && b.getAttribute('aria-hidden') !== 'true');
  if (!sources.length) return;
  const menu = document.createElement('div');
  menu.className = 'header-more-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', trigger.getAttribute('aria-label') ?? '');
  for (const source of sources) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    const icon = source.querySelector('svg')?.cloneNode(true);
    if (icon) item.append(icon);
    item.append(document.createTextNode(source.getAttribute('aria-label') ?? source.getAttribute('data-tip') ?? ''));
    item.addEventListener('click', () => { closeHeaderMore(false); source.click(); });
    menu.append(item);
  }
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHeaderMore(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') closeHeaderMore(false);
  });
  document.body.append(menu);
  const r = trigger.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  moreMenu = menu;
  trigger.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const more = target?.closest?.('#btn-header-more') as HTMLElement | null;
  if (more) {
    event.preventDefault();
    if (moreMenu) closeHeaderMore(true); else openHeaderMore(more);
    return;
  }
  if (moreMenu && !(target && moreMenu.contains(target))) closeHeaderMore(false);
  const el = target?.closest?.('[data-bridge-action]') as HTMLElement | null;
  if (!el) return;

  const action = el.getAttribute('data-bridge-action');
  if (!action || COMPONENT_BOUND.has(action)) return;
  if (!BridgeRegistry.has(action)) return;   // ölü satır üretme: sahibi yoksa dokunma

  event.preventDefault();
  const arg = el.getAttribute('data-bridge-arg');
  // Legacy sözleşme AYNEN korunur: ilk argüman ögenin kendisi, sonra varsa arg.
  BridgeRegistry.call(action, el, ...(arg ? [arg] : []));
}

let bound = false;

export function mountShellActions(): void {
  if (bound) return;
  document.addEventListener('click', onClick);
  bound = true;
  log.info('Kabuk eylem köprüsü bağlandı');
}

export function unmountShellActions(): void {
  if (!bound) return;
  document.removeEventListener('click', onClick);
  bound = false;
}

mountShellActions();
