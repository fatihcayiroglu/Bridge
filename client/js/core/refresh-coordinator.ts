// client/js/core/refresh-coordinator.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SEKMELER ARASI TEK-UÇUŞ REFRESH KOORDİNASYONU
// ════════════════════════════════════════════════════════════════════════════
// ── ÖLÇÜLEN ARIZA ─────────────────────────────────────────────────────────
// Sunucu tarafı refresh rotasyonu, KULLANILMIŞ bir token'ın yeniden
// gönderilmesini REPLAY sayar ve tüm token AİLESİNİ iptal eder. Bu doğru ve
// kasıtlıdır: çalınmış bir refresh token'ı meşru istemciden ayırt edilemez,
// bu yüzden fail-closed davranılır (gerçek PostgreSQL ile kanıtlandı).
//
// Ancak `api-fetch.ts` içindeki tek-uçuş koruması YALNIZCA SEKME İÇİNDEYDİ
// (`_refreshPromise` modül düzeyinde bir değişken). İki sekme aynı anda 401
// alırsa İKİSİ de `POST /api/refresh` gönderir, ikisi de AYNI httpOnly
// `bridge_refresh` çerezini taşır:
//
//     sekme A → rotasyon KAZANIR, yeni token alır
//     sekme B → sunucu artık `used=true` görür → REPLAY → AİLE İPTAL
//     sonuç   → kullanıcı HER İKİ sekmede de oturumdan atılır
//
// Yani normal bir kullanım (iki sekme) kendini oturumdan atıyordu.
//
// ── ÇÖZÜM: KORUMAYI ZAYIFLATMADAN TEKİLLEŞTİRME ───────────────────────────
// Sunucu tarafı DEĞİŞTİRİLMEZ. Replay koruması aynen kalır. Yapılan tek şey,
// AYNI TARAYICIDAKİ sekmelerin sunucuya YALNIZCA BİR refresh göndermesini
// sağlamaktır:
//
//   · `localStorage` üzerinde sahipli, SÜRELİ bir kiralama (lease),
//   · kirayı kazanan sekme refresh'i yapar ve yeni token'ı `localStorage`a
//     yazar (mevcut depolama sözleşmesi — token zaten sekmeler arası paylaşılır),
//   · diğer sekmeler İSTEK GÖNDERMEZ; sonucu bekler ve token'ı yeniden okur.
//
// Bu, çalınmış token senaryosunu ETKİLEMEZ: saldırgan farklı bir tarayıcı/
// cihazdadır, bizim `localStorage`ımızı paylaşmaz, dolayısıyla sunucu onu
// yine replay olarak görür ve aileyi iptal eder.
//
// ── ÇÖKME / KAPANMA DAYANIKLILIĞI ─────────────────────────────────────────
// Kirayı alan sekme çökerse veya kapatılırsa kilit ASILI KALMAMALIDIR:
//   · kiralar SÜRELİDİR (`LOCK_TTL_MS`); süresi dolan kira çalınabilir,
//   · bekleyen sekmeler SINIRLI süre bekler (`WAIT_TIMEOUT_MS`); sonra
//     kirayı devralıp kendileri dener — yani en kötü durumda ESKİ davranışa
//     dönülür, kilitlenme olmaz.
//
// `BroadcastChannel` varsa uyanma anında olur; yoksa `storage` olayı ve kısa
// aralıklı yoklama yedeği kullanılır (Safari/eski tarayıcılar).

import { createLogger } from './logger.ts';

const log = createLogger('RefreshCoordinator');

const LOCK_KEY = 'bridge:refresh:lock';
const RESULT_KEY = 'bridge:refresh:result';
const CHANNEL_NAME = 'bridge:refresh';

/** Kirayı alan sekme bu süre içinde bitirmeli; sonra kira çalınabilir. */
const LOCK_TTL_MS = 10_000;
/** Bekleyen sekme en fazla bu kadar bekler, sonra kendi dener. */
const WAIT_TIMEOUT_MS = 12_000;
/** `storage` olayı gelmezse yedek yoklama aralığı. */
const POLL_MS = 50;

interface Lease { owner: string; expiresAt: number; }
interface RefreshResult { owner: string; ok: boolean; at: number; }

const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// ── Depolama sarmalayıcıları ───────────────────────────────────────────────
// `localStorage` gizli sekmede/kotada hata fırlatabilir. Erişilemezse
// koordinasyon DEVRE DIŞI kalır ve çağıran eski (sekme-içi) davranışa döner —
// yani en kötü durumda bugünkü durum, asla daha kötüsü değil.
function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch { return null; }
}

function writeJson(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function removeKey(key: string): void {
  try { localStorage.removeItem(key); } catch { /* erişilemez */ }
}

export function storageAvailable(): boolean {
  try {
    const probe = '__bridge_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch { return false; }
}

// ── Kiralama ───────────────────────────────────────────────────────────────
/**
 * Kirayı almaya çalışır.
 *
 * `localStorage` atomik bir compare-and-swap sunmaz. Bunu telafi etmek için
 * yazdıktan SONRA geri okuyup sahipliği doğrularız: iki sekme aynı anda
 * yazarsa son yazan kazanır ve diğeri kendini sahip GÖRMEZ. Bu, dağıtık bir
 * kilit değildir — aynı tarayıcıdaki sekmeleri tekilleştirmek için yeterlidir
 * ve yanlış tarafa düşen sekme yalnızca BEKLER (istek göndermez).
 */
export function tryAcquireLease(now = Date.now()): boolean {
  const existing = readJson<Lease>(LOCK_KEY);
  if (existing && existing.expiresAt > now && existing.owner !== TAB_ID) return false;

  if (!writeJson(LOCK_KEY, { owner: TAB_ID, expiresAt: now + LOCK_TTL_MS })) return false;

  const confirmed = readJson<Lease>(LOCK_KEY);
  return confirmed?.owner === TAB_ID;
}

export function releaseLease(): void {
  const existing = readJson<Lease>(LOCK_KEY);
  if (!existing || existing.owner === TAB_ID) removeKey(LOCK_KEY);
}

export function publishResult(ok: boolean): void {
  const result: RefreshResult = { owner: TAB_ID, ok, at: Date.now() };
  writeJson(RESULT_KEY, result);
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(CHANNEL_NAME);
      ch.postMessage(result);
      ch.close();
    }
  } catch { /* kanal yoksa storage olayı yeterli */ }
}

/**
 * Başka bir sekmenin yenilemesini bekler.
 *
 * @returns `true`  — başka sekme BAŞARIYLA yeniledi; çağıran token'ı yeniden okumalı
 *          `false` — başka sekme başarısız oldu VEYA bekleme zaman aşımına uğradı;
 *                    çağıran kendi denemesini yapmalıdır (kilitlenme yok)
 */
export function waitForOtherTab(startedAt: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let channel: BroadcastChannel | null = null;

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try { window.removeEventListener('storage', onStorage); } catch { /* yok */ }
      try { channel?.close(); } catch { /* yok */ }
      resolve(value);
    };

    // Sonuç BİZDEN SONRA yayınlanmış olmalı; eski bir sonuç kabul edilmemeli.
    const check = (): void => {
      const result = readJson<RefreshResult>(RESULT_KEY);
      if (result && result.at >= startedAt) { finish(result.ok); return; }
      // Sahip çökmüş olabilir: kira süresi dolduysa beklemeyi bırak.
      const lease = readJson<Lease>(LOCK_KEY);
      if (!lease || lease.expiresAt <= Date.now()) finish(false);
    };

    const onStorage = (e: StorageEvent): void => {
      if (e.key === RESULT_KEY || e.key === LOCK_KEY) check();
    };

    try { window.addEventListener('storage', onStorage); } catch { /* yok */ }
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = (e: MessageEvent): void => {
          const r = e.data as RefreshResult | undefined;
          if (r && r.at >= startedAt) finish(r.ok);
        };
      }
    } catch { channel = null; }

    // Yedek yoklama: `storage` olayı bazı tarayıcılarda güvenilmez.
    const poll = setInterval(check, POLL_MS);
    const timer = setTimeout(() => {
      log.warn('Diğer sekmenin yenilemesi zaman aşımına uğradı; kendi denemem yapılacak.');
      finish(false);
    }, WAIT_TIMEOUT_MS);

    check();   // hemen bir kez dene (sonuç zaten hazır olabilir)
  });
}

/** @internal — testler için durum sıfırlama. */
export function _resetCoordinatorForTest(): void {
  removeKey(LOCK_KEY);
  removeKey(RESULT_KEY);
}

/** @internal — testlerin sahiplik yarışını kurabilmesi için. */
export const _TAB_ID = TAB_ID;
export const _KEYS = { LOCK_KEY, RESULT_KEY, CHANNEL_NAME, LOCK_TTL_MS, WAIT_TIMEOUT_MS };
