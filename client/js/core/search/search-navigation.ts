// client/js/core/search/search-navigation.ts
//
// FAZ K/1 — ARAMA SONUCUNDAN HEDEFE GITME.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BURADA, NEDEN BOYLE
// ════════════════════════════════════════════════════════════════════════════
// Dort kaynagin dordunun de FARKLI bir kanonik acilis sahibi vardir:
//
//   channel → navigateToChannel(channelId, messageId, targetServer)
//             (ChannelListManager — kanal seciminin TEK sahibi)
//   thread  → once ust mesajin kanalina git, sonra openThread(parentMessageId)
//   dm      → openDm(otherUserId, ad, renk, messageId)   (DmPanel)
//   gdm     → groupDmPanel:openGroupDm(group, messageId) (GroupDmPanel)
//
// Bu modul yeni bir gezinme sahibi KURMAZ — mevcut sahiplere yonlendirir.
// Ikinci bir "arama gezinmesi" yolu acmak, kanal secimi ile arama secimi
// arasinda zamanla ayrisacak iki gercek uretirdi.
//
// ── SESSIZ BASARISIZLIK YASAK ────────────────────────────────────────────
// `BridgeRegistry.call()` kayitsiz anahtarda sessizce `undefined` doner. Bu
// tam olarak eski SearchPanel'i olu baglantiya cevirmisti: sonuca tiklamak
// paneli kapatiyor, HICBIR YERE gitmiyordu. Burada her yol once `has()` ile
// dogrulanir ve sonuc ACIKCA raporlanir; cagiran kullaniciya durum gosterir.
//
// ── YETKI ────────────────────────────────────────────────────────────────
// Bu modul YETKI KARARI VERMEZ. Sonuclar sunucuda zaten kapsanmistir
// (kanal/thread icin VIEW_CHANNELS, DM/grup DM icin uyelik). Hedef acilirken
// de kanonik sahipler kendi dogrulamalarini yapar; thread cozumlemesi
// `GET /api/threads/:id` uzerinden gider ve o uc sunucu uyeligi ister.

import type { SearchHit } from './unified-search-client.ts';

export type NavigationFailure =
  /** Gerekli kanonik sahip kayitli degil (panel mount edilmemis). */
  | 'unavailable'
  /** Hedef artik yok ya da erisim kaldirilmis. */
  | 'not-found'
  /** Sahip cagrildi ama basarisiz dondu. */
  | 'failed';

/**
 * Ayrimci alan `status` bir DIZGI birlesimidir, bool degil.
 * `{ ok: true } | { ok: false, reason }` bicimini Svelte'in derledigi
 * cikti uzerinde daraltmak guvenilir degildi (svelte-check `reason`i
 * goremiyordu); dizgi karsilastirmasi her iki derleyicide de daraltir.
 */
export type NavigationResult =
  | { status: 'ok' }
  | { status: 'error'; reason: NavigationFailure };

const FAIL = (reason: NavigationFailure): NavigationResult => ({ status: 'error', reason });
const OK: NavigationResult = { status: 'ok' };

/** Registry'nin bu modulun ihtiyac duydugu yuzeyi — test edilebilirlik icin daraltilmis. */
export interface RegistryLike {
  has(key: string): boolean;
  // The canonical BridgeRegistry returns `T | undefined` for an unregistered
  // key. Declaring `T` here made the adapter in GlobalSearchPanel unassignable
  // and, worse, told every call site that a missing owner cannot happen.
  call<T = unknown>(key: string, ...args: unknown[]): T | undefined;
}

export interface NavigationDeps {
  registry: RegistryLike;
  apiFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface ServerSummary { _id?: string; name?: string; [key: string]: unknown }
interface PersonSummary { _id?: string; displayName?: string; username?: string; avatarColor?: string }
interface DmConversation { _id?: string; other?: PersonSummary }
interface GroupSummary { _id?: string; name?: string; [key: string]: unknown }

function readList<T>(registry: RegistryLike, key: string): T[] {
  if (!registry.has(key)) return [];
  const value = registry.call<unknown>(key);
  return Array.isArray(value) ? value as T[] : [];
}

/** Kanal satirlari baska bir sunucuda olabilir; sunucular arasi gecis icin ozet gerekir. */
function findServer(registry: RegistryLike, serverId?: string): ServerSummary | undefined {
  if (!serverId) return undefined;
  return readList<ServerSummary>(registry, 'getAvailableServers')
    .find(s => String(s?._id ?? '') === serverId);
}

// ── channel ────────────────────────────────────────────────────────────────

async function goToChannelMessage(
  registry: RegistryLike,
  channelId: string,
  messageId: string | undefined,
  serverId: string | undefined,
): Promise<NavigationResult> {
  if (!channelId) return FAIL('not-found');
  if (!registry.has('navigateToChannel')) return FAIL('unavailable');

  // `navigateToChannel` sunucular arasi gecisi kendi yonetir; hedef sunucu
  // ozeti verilmezse yalnizca ACIK sunucudaki kanallara gidebilir.
  const ok = await Promise.resolve(
    registry.call<boolean | Promise<boolean>>(
      'navigateToChannel', channelId, messageId, findServer(registry, serverId),
    ),
  );
  return ok === false ? FAIL('not-found') : OK;
}

// ── thread ─────────────────────────────────────────────────────────────────

interface ThreadRecord {
  _id?: string; parentMessageId?: string; channelId?: string;
  serverId?: string; name?: string;
}

/**
 * Thread yaniti, ust mesajin kanalinda yasar.
 *
 * Arama satiri `threadId` tasir ama UST MESAJ kimligini tasimaz — o bilgi
 * `threads` tablosundadir. Thread panelini acan kanonik sahip
 * (`openThread`) ust mesaj kimligiyle calisir, bu yuzden once thread kaydi
 * cozulur. Bu uc sunucu uyeligi dogrular; yetki atlanmaz.
 */
async function goToThreadReply(deps: NavigationDeps, hit: SearchHit): Promise<NavigationResult> {
  const { registry, apiFetch } = deps;
  if (!hit.threadId) return FAIL('not-found');
  if (!apiFetch) return FAIL('unavailable');

  let thread: ThreadRecord;
  try {
    const res = await apiFetch(`/api/threads/${encodeURIComponent(hit.threadId)}`);
    if (!res.ok) return FAIL(res.status === 404 ? 'not-found' : 'failed');
    thread = await res.json() as ThreadRecord;
  } catch {
    return FAIL('failed');
  }

  const parentId = String(thread.parentMessageId ?? '');
  const channelId = String(thread.channelId ?? hit.channelId ?? '');
  if (!parentId || !channelId) return FAIL('not-found');

  // Once kanala git: thread paneli ust mesajin yaninda acilir, kanal
  // degismezse kullanici yanlis baglamda bir panel gorurdu.
  const reached = await goToChannelMessage(
    registry, channelId, parentId, String(thread.serverId ?? hit.serverId ?? ''),
  );
  if (reached.status === 'error') return reached;

  if (!registry.has('openThread')) {
    // Kanala VARDIK — bu kullanici icin gercek bir ilerlemedir. Thread paneli
    // acilamadi diye basarisiz demek yaniltici olurdu.
    return OK;
  }
  await Promise.resolve(registry.call('openThread', parentId, thread.name ?? ''));
  return OK;
}

// ── dm ─────────────────────────────────────────────────────────────────────

/**
 * DM konusmasinin KARSI tarafini cozer.
 *
 * `openDm` karsi kullanicinin kimligiyle calisir; arama satirindaki `userId`
 * ise GONDERENDIR. Kendi mesajini bulan kullanici icin bu ikisi ayni DEGIL:
 * kendi kimligimizle DM acmak yanlis (ya da bos) bir konusma acardi.
 * Once kanonik konusma listesinden cozulur; yalnizca o basarisiz olursa
 * gonderen kimligi kullanilir ve o da KENDIMIZ degilse.
 */
export function resolveDmPartner(
  registry: RegistryLike, hit: SearchHit,
): { id: string; name?: string; color?: string } | null {
  const conversations = readList<DmConversation>(registry, 'getDmConversations');
  const match = conversations.find(c => String(c?._id ?? '') === (hit.conversationId ?? ''));
  const other = match?.other;
  if (other?._id) {
    return {
      id: String(other._id),
      name: other.displayName ?? other.username,
      color: other.avatarColor,
    };
  }

  const me = registry.has('getMe') ? registry.call<{ _id?: string; id?: string } | null>('getMe') : null;
  const myId = String(me?._id ?? me?.id ?? '');
  if (hit.authorId && hit.authorId !== myId) {
    return { id: hit.authorId, name: hit.authorName || undefined };
  }
  return null;
}

async function goToDm(registry: RegistryLike, hit: SearchHit): Promise<NavigationResult> {
  if (!registry.has('openDm')) return FAIL('unavailable');
  const partner = resolveDmPartner(registry, hit);
  if (!partner) return FAIL('not-found');

  await Promise.resolve(registry.call('openDm', partner.id, partner.name, partner.color, hit.id));
  return OK;
}

// ── gdm ────────────────────────────────────────────────────────────────────

async function goToGroupDm(registry: RegistryLike, hit: SearchHit): Promise<NavigationResult> {
  if (!registry.has('groupDmPanel:openGroupDm')) return FAIL('unavailable');
  const groupId = hit.conversationId;
  if (!groupId) return FAIL('not-found');

  let group = readList<GroupSummary>(registry, 'groupDmPanel:getGroups')
    .find(g => String(g?._id ?? '') === groupId);

  // Grup listesi henuz yuklenmemis olabilir (panel hic acilmadiysa).
  // Uydurma bir grup nesnesi gondermek yerine kanonik listeyi yukletiriz.
  if (!group && registry.has('groupDmPanel:loadList')) {
    await Promise.resolve(registry.call('groupDmPanel:loadList'));
    group = readList<GroupSummary>(registry, 'groupDmPanel:getGroups')
      .find(g => String(g?._id ?? '') === groupId);
  }
  if (!group) return FAIL('not-found');

  const ok = await Promise.resolve(
    registry.call<boolean | Promise<boolean>>('groupDmPanel:openGroupDm', group, hit.id),
  );
  return ok === false ? FAIL('not-found') : OK;
}

// ── giris ──────────────────────────────────────────────────────────────────

/** Kullaniciya gosterilecek hata metni — sessiz basarisizlik yerine. */
export const FAILURE_MESSAGE: Record<NavigationFailure, string> = {
  unavailable: 'Bu sonuca su anda gidilemiyor.',
  'not-found': 'Bu konusma artik kullanilamiyor.',
  failed:      'Sonuca giderken bir hata olustu.',
};

export async function navigateToHit(hit: SearchHit, deps: NavigationDeps): Promise<NavigationResult> {
  switch (hit.source) {
    case 'channel':
      return goToChannelMessage(deps.registry, hit.channelId ?? '', hit.id, hit.serverId);
    case 'thread':
      return goToThreadReply(deps, hit);
    case 'dm':
      return goToDm(deps.registry, hit);
    case 'gdm':
      return goToGroupDm(deps.registry, hit);
    default:
      return FAIL('unavailable');
  }
}
