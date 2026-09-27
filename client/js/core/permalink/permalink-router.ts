// client/js/core/permalink/permalink-router.ts
//
// FAZ K+/4 — KALICI BAĞLANTIYI AÇMA.
//
// Bağlantıyı ÜRETMEK yarısıdır; diğer yarısı onu açabilmektir. Bu modül
// hash rotasını dinler ve KANONİK gezinme sahibine devreder
// (`navigateToChannel` — ChannelListManager). İkinci bir gezinme yolu
// kurulmaz; arama sonuçları da aynı sahibe gider.
//
// ── ZAMANLAMA ─────────────────────────────────────────────────────────────
// Sayfa bir kalıcı bağlantıyla AÇILDIĞINDA kanal listesi ve sunucu listesi
// henüz yüklenmemiş olabilir. Hemen denemek "kanal bulunamadı" ile biterdi.
// Bu yüzden ilk çözüm, kanonik sahip hazır olana kadar sınırlı süre bekler.

import { BridgeRegistry } from '../bridge-registry.js';
import { createLogger } from '../logger.js';
import { t } from '../i18n/index.ts';
import { parsePermalink, type MessageLocation } from './message-permalink.ts';

const log = createLogger('Permalink');

/** Sahiplerin mount olması için üst sınır; sonsuza kadar beklenmez. */
const READY_TIMEOUT_MS = 12_000;
const POLL_MS = 150;

interface ServerSummary { _id?: string; [key: string]: unknown }

function readServers(): ServerSummary[] {
  if (!BridgeRegistry.has('getAvailableServers')) return [];
  const list = BridgeRegistry.call<unknown>('getAvailableServers');
  return Array.isArray(list) ? list as ServerSummary[] : [];
}

async function waitForNavigator(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (BridgeRegistry.has('navigateToChannel')) return true;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  return false;
}

/**
 * Hedefe gider. Başarısızlık SESSİZ KALMAZ: kullanıcı bir bağlantıya
 * tıkladığında hiçbir şey olmaması, ürünün bozuk olduğu anlamına gelir.
 */
export async function openLocation(loc: MessageLocation): Promise<boolean> {
  if (!await waitForNavigator()) {
    log.warn('Gezinme sahibi hazır değil; kalıcı bağlantı açılamadı');
    BridgeRegistry.call('toast', t('permalink_not_ready'), 'warning');
    return false;
  }

  const target = readServers().find(s => String(s?._id ?? '') === loc.serverId);
  const ok = await Promise.resolve(
    BridgeRegistry.call<boolean | Promise<boolean>>(
      'navigateToChannel', loc.channelId, loc.messageId, target,
    ),
  );

  if (ok === false) {
    // Erişim kaldırılmış, kanal silinmiş ya da hiç üye olunmamış olabilir.
    // Hangisi olduğunu İSTEMCİ bilemez ve TAHMİN ETMEZ.
    BridgeRegistry.call('toast', t('permalink_message_unavailable'), 'warning');
    return false;
  }
  return true;
}

/** İşlendikten sonra adres çubuğunu temizler — geri tuşu döngüye girmesin. */
function clearHash(): void {
  try {
    const url = window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  } catch { /* tarayıcı reddedebilir; kritik değil */ }
}

async function handleHash(hash: string): Promise<void> {
  const loc = parsePermalink(hash);
  if (!loc) return;                       // bize ait olmayan hash'e dokunulmaz
  clearHash();
  await openLocation(loc);
}

let bound = false;

export function initPermalinkRouter(): void {
  if (bound) return;
  bound = true;

  BridgeRegistry.register('openPermalink', (value: unknown) => {
    const loc = typeof value === 'string' ? parsePermalink(value) : null;
    return loc ? openLocation(loc) : Promise.resolve(false);
  });

  window.addEventListener('hashchange', () => { void handleHash(window.location.hash); });

  // Açılışta gelen bağlantı.
  if (window.location.hash) void handleHash(window.location.hash);
}
