// client/js/core/composer/emoji-data.ts
//
// FAZ K/4 — COMPOSER EMOJI VERISI.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN GOMULU (CDN / kutuphane DEGIL)
// ════════════════════════════════════════════════════════════════════════════
// Tam bir Unicode emoji kutuphanesi (emoji-mart vb.) sikistirilmis halde bile
// birkac yuz KB'dir ve genelde uzak bir veri dosyasi ceker. Bu urunun
// sabit bir paket butcesi var (scripts/check-bundle-budget.js) ve disari
// istek atmak gizlilik yuzeyini genisletir.
//
// Bu yuzden KURATE edilmis bir kume gomulur: gunluk sohbette gercekten
// kullanilan emojiler, aranabilir anahtar kelimelerle. Eksigi olabilir —
// ama VAR OLANI dogru, hizli ve cevrimdisi calisir. Kullanici listede
// olmayan bir emoji isterse isletim sisteminin kendi secicisini kullanabilir;
// composer duz metin kabul eder.
//
// ARAMA hem Turkce hem Ingilizce anahtar kelimeyle calisir: urunun arayuzu
// Turkce, emoji adlari ise evrensel olarak Ingilizce bilinir.

export interface EmojiEntry {
  /** Emojinin kendisi. */
  char: string;
  /** Gorunur ad (Turkce). */
  name: string;
  /** Arama anahtarlari — Turkce + Ingilizce. */
  keywords: readonly string[];
}

export interface EmojiCategory {
  id: string;
  labelKey: string;
  /** Sekme dugmesinde gosterilen temsili emoji. */
  icon: string;
  emojis: readonly EmojiEntry[];
}

/** `[char, ad, ...anahtarlar]` — dosyayi okunur ve kucuk tutan kisa bicim. */
type Row = readonly [string, string, ...string[]];

const row = (r: Row): EmojiEntry => ({
  char: r[0], name: r[1], keywords: [r[1].toLowerCase(), ...r.slice(2).map(k => k.toLowerCase())],
});

const SMILEYS: Row[] = [
  ['😀', 'sirit', 'grin', 'gulumseme', 'mutlu', 'happy'],
  ['😃', 'mutlu', 'smile', 'happy', 'sevincli'],
  ['😄', 'gulen', 'laugh', 'gulus', 'happy'],
  ['😁', 'sirit disli', 'beam', 'grin'],
  ['😆', 'kahkaha', 'laughing', 'gulme'],
  ['😅', 'gergin gulus', 'sweat', 'ter'],
  ['🤣', 'yerlere yatma', 'rofl', 'kahkaha'],
  ['😂', 'gozyasi gulus', 'joy', 'komik', 'funny'],
  ['🙂', 'hafif gulumseme', 'slight smile'],
  ['🙃', 'ters yuz', 'upside down'],
  ['😉', 'goz kirp', 'wink'],
  ['😊', 'utangac gulus', 'blush', 'kizarma'],
  ['😍', 'kalp gozler', 'heart eyes', 'ask', 'love'],
  ['🥰', 'sevgi dolu', 'smiling hearts', 'ask'],
  ['😘', 'opucuk', 'kiss', 'op'],
  ['😎', 'gunes gozlugu', 'cool', 'havali'],
  ['🤩', 'yildiz gozler', 'star struck', 'harika'],
  ['🤔', 'dusunen', 'thinking', 'hmm'],
  ['🤨', 'kasik kaldirma', 'raised eyebrow', 'suphe'],
  ['😐', 'ifadesiz', 'neutral'],
  ['😴', 'uyuyan', 'sleeping', 'uyku'],
  ['😔', 'uzgun', 'pensive', 'sad'],
  ['😢', 'aglayan', 'cry', 'uzgun'],
  ['😭', 'huzun', 'sob', 'aglama'],
  ['😤', 'ofke', 'triumph', 'sinir'],
  ['😠', 'kizgin', 'angry', 'sinirli'],
  ['🤯', 'sasirma', 'mind blown', 'patlama'],
  ['😱', 'korku', 'scream', 'sok'],
  ['🥳', 'kutlama', 'partying', 'parti'],
  ['😇', 'melek', 'innocent', 'masum'],
  ['🤗', 'sarilma', 'hug'],
  ['🤝', 'el sikisma', 'handshake', 'anlasma'],
  ['🙏', 'tesekkur', 'pray', 'rica', 'lutfen'],
  ['💪', 'guclu', 'muscle', 'kas'],
];

const GESTURES: Row[] = [
  ['👍', 'begendim', 'thumbs up', 'evet', 'onay'],
  ['👎', 'begenmedim', 'thumbs down', 'hayir'],
  ['👏', 'alkis', 'clap', 'bravo'],
  ['🙌', 'kutlama elleri', 'raised hands'],
  ['👋', 'selam', 'wave', 'merhaba', 'hi'],
  ['✌️', 'zafer', 'victory', 'peace'],
  ['🤞', 'sans', 'fingers crossed'],
  ['👌', 'tamam', 'ok', 'okay'],
  ['🤙', 'ara beni', 'call me'],
  ['✋', 'dur', 'stop', 'el'],
  ['👀', 'gozler', 'eyes', 'bakiyorum', 'looking'],
  ['🫡', 'selam dur', 'salute'],
];

const HEARTS: Row[] = [
  ['❤️', 'kirmizi kalp', 'red heart', 'ask', 'love'],
  ['🧡', 'turuncu kalp', 'orange heart'],
  ['💛', 'sari kalp', 'yellow heart'],
  ['💚', 'yesil kalp', 'green heart'],
  ['💙', 'mavi kalp', 'blue heart'],
  ['💜', 'mor kalp', 'purple heart'],
  ['🖤', 'siyah kalp', 'black heart'],
  ['💔', 'kirik kalp', 'broken heart'],
  ['💯', 'yuz puan', 'hundred', 'tam', 'perfect'],
  ['✨', 'parilti', 'sparkles', 'yeni'],
  ['🔥', 'ates', 'fire', 'harika', 'lit'],
  ['⭐', 'yildiz', 'star'],
];

const OBJECTS: Row[] = [
  ['🎉', 'konfeti', 'tada', 'kutlama', 'party'],
  ['🎊', 'parti topu', 'confetti ball'],
  ['🎁', 'hediye', 'gift', 'present'],
  ['🏆', 'kupa', 'trophy', 'kazandi'],
  ['🥇', 'birinci', 'gold medal'],
  ['💡', 'fikir', 'bulb', 'idea'],
  ['📌', 'raptiye', 'pin', 'sabitle'],
  ['📎', 'atac', 'paperclip', 'ek'],
  ['🔗', 'baglanti', 'link'],
  ['📝', 'not', 'memo', 'yaz'],
  ['📅', 'takvim', 'calendar', 'tarih'],
  ['⏰', 'alarm', 'clock', 'saat'],
  ['🔔', 'bildirim', 'bell', 'zil'],
  ['🔒', 'kilit', 'lock', 'guvenli'],
  ['🔑', 'anahtar', 'key'],
  ['💰', 'para', 'money'],
  ['📦', 'paket', 'package', 'kutu'],
  ['🛠️', 'aletler', 'tools', 'tamir'],
];

const TECH: Row[] = [
  ['💻', 'bilgisayar', 'laptop', 'kod'],
  ['🖥️', 'masaustu', 'desktop'],
  ['📱', 'telefon', 'phone', 'mobil'],
  ['⌨️', 'klavye', 'keyboard'],
  ['🖱️', 'fare', 'mouse'],
  ['🐛', 'bocek', 'bug', 'hata'],
  ['🚀', 'roket', 'rocket', 'yayin', 'deploy'],
  ['⚙️', 'disli', 'gear', 'ayar', 'settings'],
  ['🧪', 'deney', 'test', 'tup'],
  ['📊', 'grafik', 'chart', 'analiz'],
  ['🗄️', 'dolap', 'database', 'veritabani'],
  ['🌐', 'ag', 'globe', 'internet', 'web'],
  ['⚡', 'yildirim', 'zap', 'hizli', 'fast'],
  ['🔍', 'buyutec', 'search', 'ara'],
  ['✅', 'tamam', 'check', 'onay', 'bitti', 'done'],
  ['❌', 'hata', 'cross', 'iptal', 'x'],
  ['⚠️', 'uyari', 'warning', 'dikkat'],
  ['🚧', 'yapim asamasi', 'construction', 'wip'],
];

const FOOD: Row[] = [
  ['☕', 'kahve', 'coffee'],
  ['🍵', 'cay', 'tea'],
  ['🍕', 'pizza'],
  ['🍔', 'burger', 'hamburger'],
  ['🍟', 'patates', 'fries'],
  ['🍰', 'pasta', 'cake'],
  ['🍪', 'kurabiye', 'cookie'],
  ['🍺', 'bira', 'beer'],
  ['🥤', 'icecek', 'drink', 'soda'],
  ['🍎', 'elma', 'apple'],
  ['🥗', 'salata', 'salad'],
  ['🍜', 'eriste', 'noodles', 'ramen'],
];

const NATURE: Row[] = [
  ['🐶', 'kopek', 'dog'],
  ['🐱', 'kedi', 'cat'],
  ['🦊', 'tilki', 'fox'],
  ['🐻', 'ayi', 'bear'],
  ['🐼', 'panda'],
  ['🦄', 'tek boynuzlu', 'unicorn'],
  ['🌱', 'filiz', 'seedling', 'buyume'],
  ['🌳', 'agac', 'tree'],
  ['🌸', 'cicek', 'blossom', 'bahar'],
  ['🌞', 'gunes', 'sun'],
  ['🌙', 'ay', 'moon', 'gece'],
  ['🌈', 'gokkusagi', 'rainbow'],
  ['❄️', 'kar', 'snow', 'soguk'],
  ['🌊', 'dalga', 'wave', 'deniz'],
];

const ACTIVITY: Row[] = [
  ['⚽', 'futbol', 'soccer', 'top'],
  ['🏀', 'basketbol', 'basketball'],
  ['🎮', 'oyun', 'game', 'gaming'],
  ['🎧', 'kulaklik', 'headphones', 'muzik'],
  ['🎵', 'nota', 'music', 'muzik'],
  ['🎤', 'mikrofon', 'microphone', 'ses'],
  ['🎬', 'film', 'movie', 'klaket'],
  ['📷', 'fotograf', 'camera'],
  ['🎨', 'sanat', 'art', 'palet'],
  ['🧩', 'yapboz', 'puzzle'],
  ['✈️', 'ucak', 'plane', 'seyahat'],
  ['🏠', 'ev', 'house', 'home'],
];

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  { id: 'smileys',  labelKey: 'emoji_cat_smileys',      icon: '😀', emojis: SMILEYS.map(row) },
  { id: 'gestures', labelKey: 'emoji_cat_gestures', icon: '👍', emojis: GESTURES.map(row) },
  { id: 'hearts',   labelKey: 'emoji_cat_hearts',     icon: '❤️', emojis: HEARTS.map(row) },
  { id: 'tech',     labelKey: 'emoji_cat_tech',   icon: '💻', emojis: TECH.map(row) },
  { id: 'objects',  labelKey: 'emoji_cat_objects',    icon: '🎉', emojis: OBJECTS.map(row) },
  { id: 'food',     labelKey: 'emoji_cat_food',     icon: '🍕', emojis: FOOD.map(row) },
  { id: 'nature',   labelKey: 'emoji_cat_nature',        icon: '🌳', emojis: NATURE.map(row) },
  { id: 'activity', labelKey: 'emoji_cat_activity',    icon: '🎮', emojis: ACTIVITY.map(row) },
];

export const ALL_EMOJIS: readonly EmojiEntry[] =
  EMOJI_CATEGORIES.flatMap(category => category.emojis);

/**
 * Ada ve anahtar kelimelere gore arar.
 *
 * SIRALAMA kasitlidir: ONEK eslesmeleri once gelir. "ka" yazan kullanici
 * "kahve"yi "yildirim"dan (anahtar: `hizli`… hayir) once gormeli; icerik
 * eslesmesi onek eslesmesinden zayiftir ve altta kalir.
 */
export function searchEmojis(query: string, limit = 60): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const prefix: EmojiEntry[] = [];
  const contains: EmojiEntry[] = [];

  for (const entry of ALL_EMOJIS) {
    // Emojinin kendisi yazildiysa dogrudan eslesir.
    if (entry.char === q) { prefix.unshift(entry); continue; }

    let matched: 'prefix' | 'contains' | null = null;
    for (const keyword of entry.keywords) {
      if (keyword.startsWith(q)) { matched = 'prefix'; break; }
      if (keyword.includes(q)) matched = 'contains';
    }
    if (matched === 'prefix') prefix.push(entry);
    else if (matched === 'contains') contains.push(entry);
  }

  return [...prefix, ...contains].slice(0, limit);
}
