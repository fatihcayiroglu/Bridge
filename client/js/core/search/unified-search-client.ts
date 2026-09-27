// client/js/core/search/unified-search-client.ts
//
// FAZ K/1 — BIRLESIK ARAMANIN ISTEMCI KATMANI.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BIR MODUL
// ════════════════════════════════════════════════════════════════════════════
// `GET /api/search/unified` sunucuda hazirdi ama istemcide TEK BIR CAGIRAN
// yoktu; yani DM, grup DM ve thread yanitlari kullanici icin hala ARANAMAZ
// durumdaydi. Bu modul yalnizca veri katmanidir: getirme, normalize etme ve
// gruplama. DOM'a dokunmaz, bu yuzden davranisi bilesen kurmadan test edilir.
//
// SUNUCU SOZLESMESI UYDURULMAZ (server/routes/search.ts):
//   { results: Array<row & { source, channelName, highlight, score }>,
//     hasMore: boolean }
// Satirlar `_source` tasir: 'channel' | 'dm' | 'thread' | 'gdm'.
// Kanal/thread satirlari VIEW_CHANNELS ile SUNUCUDA elenmistir; DM ve grup DM
// uyeligi SQL'de zorunlu kilinmistir. Istemci HICBIR yetki karari vermez —
// yalnizca sunucunun dondurdugunu gosterir.

export type SearchSource = 'channel' | 'dm' | 'thread' | 'gdm';

/** Sonuc gruplarinin GORUNUM sirasi. Kullaniciya en tanidik olan once. */
export const SOURCE_ORDER: readonly SearchSource[] = ['channel', 'dm', 'gdm', 'thread'];

export const SOURCE_LABEL: Record<SearchSource, string> = {
  channel: 'Mesajlar',
  dm:      'Direkt mesajlar',
  gdm:     'Grup mesajlari',
  thread:  'Konu yanitlari',
};

/** Sunucudan gelen tek satir — alanlar sunucu sozlesmesiyle birebir. */
export interface SearchHit {
  id: string;
  source: SearchSource;
  content: string;
  /** 1 = raw text; otherwise legacy sanitized channel text (Final21 Phase 16). */
  contentFormat?: number;
  /** Sunucunun urettigi, kacilmis + <mark> ile isaretlenmis parcacik. */
  highlight: string;
  authorName: string;
  authorId: string;
  createdAt: number;
  score: number;
  channelId?: string;
  channelName?: string;
  serverId?: string;
  threadId?: string;
  /** DM icin konusma kimligi, grup DM icin grup kimligi. */
  conversationId?: string;
}

export interface UnifiedSearchResponse {
  hits: SearchHit[];
  hasMore: boolean;
}

export interface UnifiedSearchOptions {
  /** Bos birakilirsa sunucu dort kaynagi da arar. */
  sources?: readonly SearchSource[];
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
  /** `from:` / `in:` / `has:` — sunucuda UYGULANIR, istemcide degil. */
  filters?: SearchFilters;
}

// ── FILTRELER ──────────────────────────────────────────────────────────────
//
// Filtreler YALNIZCA DARALTIR ve sunucuda uygulanir. Istemcide suzmek iki
// sekilde yanlis olurdu: sayfalama sayilari yanlis cikardi ve gorunmeyen
// icerigin VARLIGI (kac sonuc elendigi) sizardi.

export interface SearchFilters {
  /** Kullanici adi / gorunen ad / kimlik. */
  from?: string;
  /** Kanal adi — kullanicinin `in:` filtresi icin. */
  in?: string;
  /**
   * Tam kanal kimligi — yalnizca urun ici yapisal kapsam icin.
   *
   * Kanal-basligi aramasi isimle kapsanamaz: ayni sunucuda veya farkli
   * sunucularda ayni ada sahip kanallar vardir. Bu alan kullanici sozdizimine
   * acilmaz; `openChannelSearch` mevcut kanal kimligini buraya koyar.
   */
  channelId?: string;
  /** `file` | `image` | `link`. */
  has?: string;
  /** ISO date/date-time lower bound, interpreted by the server. */
  after?: string;
  /** ISO date/date-time upper bound, interpreted by the server. */
  before?: string;
}

export const HAS_OPTIONS = [
  { id: 'file',  labelKey: 'search_has_file' },
  { id: 'image', labelKey: 'search_has_image' },
  { id: 'link',  labelKey: 'search_has_link' },
] as const;

/** Sohbet sozdizimini (`from:ayse`) ayiklar; kalan metin arama terimidir. */
export function parseFilterSyntax(raw: string): { text: string; filters: SearchFilters } {
  const filters: SearchFilters = {};
  const words: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const match = token.match(/^(from|in|has|after|before):(.+)$/i);
    if (!match) { words.push(token); continue; }
    const key = match[1]!.toLowerCase() as keyof SearchFilters;
    filters[key] = match[2]!;
  }
  return { text: words.join(' '), filters };
}

/** Etkin filtre var mi? (bos degerler sayilmaz) */
export function hasActiveFilters(filters: SearchFilters | undefined): boolean {
  return Boolean(filters && Object.values(filters).some(v => typeof v === 'string' && v.trim()));
}

const VALID_SOURCES = new Set<string>(SOURCE_ORDER);

/** Arama icin en kisa anlamli sorgu. Sunucu da 2 karakter altini reddeder. */
export const MIN_QUERY_LENGTH = 2;

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Ham sunucu satirini normalize eder.
 *
 * Taninmayan `source` degeri olan satir ATILIR: bilinmeyen bir tur icin
 * gezinme hedefi de yoktur, yani kullaniciya tiklandiginda hicbir sey
 * yapmayan olu bir satir gosterilirdi.
 */
export function normalizeHit(raw: unknown): SearchHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const source = str(row.source || row._source);
  if (!VALID_SOURCES.has(source)) return null;

  const id = str(row._id || row.id);
  if (!id) return null;

  const hit: SearchHit = {
    id,
    source: source as SearchSource,
    content:    str(row.content),
    // Final21 Phase 16: 1 = raw text, otherwise legacy sanitized text (decode once).
    contentFormat: num(row.contentFormat),
    highlight:  str(row.highlight),
    authorName: str(row.displayName || row.username),
    authorId:   str(row.userId),
    createdAt:  num(row.createdAt),
    score:      num(row.score ?? row._score),
  };

  const channelId = str(row.channelId);
  if (channelId) hit.channelId = channelId;
  const channelName = str(row.channelName);
  if (channelName) hit.channelName = channelName;
  const serverId = str(row.serverId);
  if (serverId) hit.serverId = serverId;
  const threadId = str(row.threadId);
  if (threadId) hit.threadId = threadId;
  // Sunucu UNION tip uyumu icin grup kimligini de `dmId` sutununda dondurur;
  // hangisi oldugunu `source` belirler.
  const conversationId = str(row.dmId);
  if (conversationId) hit.conversationId = conversationId;

  return hit;
}

/** `apiFetch` kayitli sahibi — istemcide tek HTTP girisi budur. */
export type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Birlesik aramayi calistirir.
 *
 * HATA SESSIZCE YUTULMAZ: cagiran, "sonuc yok" ile "arama calismadi"yi
 * ayirt edebilmelidir; ikisi ayni gorunurse kullanici bozuk aramayi bos
 * sonuc sanar. Bu yuzden hata firlatilir, bos dizi DONDURULMEZ.
 */
export async function fetchUnifiedSearch(
  apiFetch: ApiFetch,
  query: string,
  options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResponse> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return { hits: [], hasMore: false };

  const params = new URLSearchParams({ q });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset && options.offset > 0) params.set('offset', String(options.offset));
  if (options.sources?.length) params.set('sources', options.sources.join(','));
  // Filtreler URL parametresi olarak gider; sunucu bunlari sohbet
  // sozdiziminden gelenlerle AYNI kodla uygular.
  for (const [key, value] of Object.entries(options.filters ?? {})) {
    if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
  }

  const res = await apiFetch(
    `/api/search/unified?${params.toString()}`,
    options.signal ? { signal: options.signal } : undefined,
  );

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  const data = await res.json() as { results?: unknown; hasMore?: unknown };
  const rows = Array.isArray(data.results) ? data.results : [];

  return {
    hits: rows.map(normalizeHit).filter((h): h is SearchHit => h !== null),
    hasMore: Boolean(data.hasMore),
  };
}

// ── BAGLAM ONIZLEMESI ─────────────────────────────────────────────────────
//
// Tek satirlik bir isabet cogu zaman yetmez: "tamam" yazan bir mesaj neyin
// tamam oldugunu soylemez. Kullanici isabete GITMEDEN once hangi konusma
// oldugunu gormek ister.
//
// GUVENLIK: sunucu DUZ METIN dondurur, isaretleme URETMEZ. Vurgulama
// istemcide `highlightSegments` ile yapilir ve Svelte metni kacisla basar —
// bu yolda hicbir yerde `innerHTML` yoktur.

export interface ContextMessage {
  _id:         string;
  userId:      string;
  displayName: string | null;
  content:     string;
  /** 1 = raw text; otherwise legacy sanitized channel text (Final21 Phase 16). */
  contentFormat?: number;
  createdAt:   number;
  /** Aranan isabetin kendisi — istemci onu vurgular. */
  isAnchor:    boolean;
}

export interface ContextResponse {
  source:    SearchSource;
  channelId: string | null;
  messages:  ContextMessage[];
}

/** Sunucudaki ust sinirla AYNI — istemci daha fazlasini istemez. */
export const MAX_CONTEXT_RADIUS = 5;

function normalizeContextMessage(raw: unknown): ContextMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r._id === 'string' ? r._id : '';
  if (!id) return null;
  return {
    _id:         id,
    userId:      typeof r.userId === 'string' ? r.userId : '',
    displayName: typeof r.displayName === 'string' ? r.displayName : null,
    content:     typeof r.content === 'string' ? r.content : '',
    contentFormat: Number(r.contentFormat) || 0,
    createdAt:   Number(r.createdAt) || 0,
    isAnchor:    r.isAnchor === true,
  };
}

/**
 * Bir isabetin cevresindeki konusmayi getirir.
 *
 * `fetchUnifiedSearch` ile AYNI hata disiplini: yetkisiz/bulunamayan icin
 * `null` doner (bu BEKLENEN bir sonuctur — sunucu varlik sizdirmamak icin
 * ikisini ayirmaz), ama gercek hatalar FIRLATILIR. Ikisini birlestirmek
 * bozuk bir uc noktayi "baglam yok" gibi gosterirdi.
 */
export async function fetchSearchContext(
  apiFetch: ApiFetch,
  messageId: string,
  source: SearchSource,
  options: { radius?: number; signal?: AbortSignal } = {},
): Promise<ContextResponse | null> {
  if (!messageId) return null;

  const params = new URLSearchParams({ id: messageId, source });
  if (options.radius) {
    params.set('radius', String(Math.min(MAX_CONTEXT_RADIUS, Math.max(1, options.radius))));
  }

  const res = await apiFetch(
    `/api/search/context?${params.toString()}`,
    options.signal ? { signal: options.signal } : undefined,
  );

  // 404 = yok VEYA yetkisiz. Sunucu bilerek ayirmaz; istemci de ayirmaz.
  if (res.status === 404) return null;

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  const data = await res.json() as { source?: unknown; channelId?: unknown; messages?: unknown };
  const rows = Array.isArray(data.messages) ? data.messages : [];
  const messages = rows.map(normalizeContextMessage).filter((m): m is ContextMessage => m !== null);

  if (!messages.length) return null;

  return {
    source:    source,
    channelId: typeof data.channelId === 'string' ? data.channelId : null,
    messages,
  };
}

export interface HitGroup {
  source: SearchSource;
  label: string;
  hits: SearchHit[];
}

/**
 * Sonuclari kaynaga gore gruplar; SIRALAMA icindeki relevans korunur.
 *
 * Sunucu tum kaynaklari tek skorla siralar. Gruplama yalnizca SUNUM'dur:
 * grup ici sira sunucudan geldigi gibi kalir, bos gruplar hic cizilmez
 * (bos bir "Direkt mesajlar" basligi kullaniciya bilgi vermez, yer kaplar).
 */
export function groupHits(hits: readonly SearchHit[]): HitGroup[] {
  const buckets = new Map<SearchSource, SearchHit[]>();
  for (const hit of hits) {
    let bucket = buckets.get(hit.source);
    if (!bucket) buckets.set(hit.source, bucket = []);
    bucket.push(hit);
  }

  const groups: HitGroup[] = [];
  for (const source of SOURCE_ORDER) {
    const bucket = buckets.get(source);
    if (bucket?.length) groups.push({ source, label: SOURCE_LABEL[source], hits: bucket });
  }
  return groups;
}

/**
 * Gruplu listeyi klavye gezinmesi icin duz siraya cevirir.
 *
 * Ok tuslari grup sinirlarini gormemelidir: kullanici listeyi tek bir dikey
 * akis olarak algilar. Duz sira SUNUM sirasiyla ayni olmali, yoksa secim
 * gorsel olarak ziplar.
 */
export function flattenGroups(groups: readonly HitGroup[]): SearchHit[] {
  return groups.flatMap(group => group.hits);
}

// ── Vurgulama ──────────────────────────────────────────────────────────────

export interface HighlightSegment { text: string; match: boolean }

/**
 * Metni, eslesen ve esles(me)yen parcalara boler.
 *
 * SUNUCUNUN `highlight` HTML'i KULLANILMAZ. O alan kacilmis metne `<mark>`
 * ekler ve gostermek icin `{@html}` gerektirir — mesaj icerigi kullanici
 * girdisidir ve bir XSS yuzeyini yalnizca "sunucu zaten kacirmisti" diye
 * acmak, tek bir kacirma hatasinin dogrudan kod calistirmasi anlamina gelir.
 * Parcalara bolup metin olarak cizmek ayni gorsel sonucu uretir ve HTML
 * enjeksiyonunu YAPISAL OLARAK imkansiz kilar.
 *
 * Ayrica cakisan/ic ice eslesmeler burada dogru cozulur: sunucunun ardisik
 * `replace` dongusu, ikinci kelime ilk turun ekledigi `<mark>` metnine
 * denk gelirse bozuk isaretleme uretebiliyordu.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const words = query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return [{ text, match: false }];

  const lower = text.toLowerCase();

  // Once TUM eslesme araliklari toplanir, sonra birlestirilir; boylece ic ice
  // ve cakisan eslesmeler tek bir araliga iner.
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(word, from);
      if (idx === -1) break;
      ranges.push([idx, idx + word.length]);
      from = idx + word.length;
    }
  }
  if (!ranges.length) return [{ text, match: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [ranges[0]!];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/**
 * Uzun mesajlarda ilk eslesmenin CEVRESINI gosterir.
 *
 * Eslesme 400 karakter ilerideyse, metnin basini gostermek kullaniciya
 * neden eslestigini anlatmaz — parcacik eslesmeyi icermelidir.
 */
export function snippetAround(text: string, query: string, radius = 90): string {
  if (text.length <= radius * 2) return text;
  const words = query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const lower = text.toLowerCase();

  let hit = -1;
  for (const word of words) {
    const idx = lower.indexOf(word);
    if (idx !== -1 && (hit === -1 || idx < hit)) hit = idx;
  }
  if (hit === -1) return `${text.slice(0, radius * 2)}…`;

  const start = Math.max(0, hit - radius);
  const end = Math.min(text.length, hit + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
