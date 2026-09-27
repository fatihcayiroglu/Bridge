// e2e/helpers/media-fixtures.ts
//
// DETERMİNİSTİK MEDYA FİKSTÜRLERİ
//
// ════════════════════════════════════════════════════════════════════════════
// NE OLDUKLARI — VE NE OLMADIKLARI
// ════════════════════════════════════════════════════════════════════════════
// Chromium'un `--auto-select-desktop-capture-source` bayrağı bir ekran videosu
// verir ama SES track'i VERMEZ ve görüntüsü değişmeyebilir. Bu iki eksik,
// otomasyonun iki önemli soruyu yanıtlamasını engeller:
//
//   1. Paylaşım sesi GERÇEKTEN iletiliyor mu? (ses track'i olmadan sınanamaz)
//   2. Uzak görüntü DONMUŞ mu? (değişmeyen kaynak donmuş kareden ayırt edilemez)
//
// Bu yüzden `getDisplayMedia` test bağlamında SENTETİK bir akışla değiştirilir:
//   · video → sürekli DEĞİŞEN bir canvas (donmuş kare yanlışlıkla geçemez)
//   · ses   → bilinen frekansta bir osilatör (varlığı ölçülebilir)
//
// ── BUNUN KANITLADIĞI ─────────────────────────────────────────────────────
// Bridge'in bir görüntü/ses track'ini DOĞRU TAŞIDIĞI: gönderici oluşturma,
// pazarlık, uzak alım, kimlik ayrımı, temizlik.
//
// ── BUNUN KANITLAMADIĞI ───────────────────────────────────────────────────
// Gerçek bir işletim sistemi ekran/sekme yakalamasının bu tarayıcıda ses
// verdiğini KANITLAMAZ. Bu platforma bağlıdır ve insan testinde kalır.
// Ayrıca hiçbir şeyin İNSANCA duyulduğunu/görüldüğünü kanıtlamaz.
//
// ÜRÜN KODU DEĞİŞTİRİLMEZ — yalnızca test bağlamındaki tarayıcı API'si.

/**
 * `getDisplayMedia` yerine sentetik akış koyar.
 *
 * @param withAudio false ise SIFIR ses track'i döner — platformun ses
 *   vermediği durumun dürüst ele alınışını sınamak için gereklidir.
 */
export function displayFixture(withAudio: boolean): string {
  // Akis TEMBEL kurulur: init script sayfa belgesi hazir olmadan calisir ve
  // o anda `document.documentElement` YOKTUR — erken DOM erisimi scripti
  // dusuruyordu (olculdu: fikstur hic kurulmadi). Uretim kodu
  // `getDisplayMedia`yi ancak kullanici paylasima bastiginda cagirir; o anda
  // DOM hazirdir.
  return `(() => {
    const WANT_AUDIO = ${withAudio ? 'true' : 'false'};
    let built = null;

    function build() {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      // Canvas DOM'A EKLENIR: bagli olmayan bir canvas kompozite edilmeyebilir
      // ve captureStream KARE URETMEZ (olculdu: alicida video track vardi ama
      // bytesReceived 0 kaldi).
      canvas.style.cssText = 'position:fixed;left:0;bottom:0;width:32px;height:18px;opacity:0.01;pointer-events:none';
      (document.body || document.documentElement).appendChild(canvas);
      const ctx = canvas.getContext('2d');
      let frame = 0;
      // SUREKLI DEGISEN icerik: donmus bir kare testi gecemez.
      setInterval(function () {
        frame += 1;
        ctx.fillStyle = 'hsl(' + (frame * 7 % 360) + ',90%,50%)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.font = '28px monospace';
        ctx.fillText(String(frame), 12, 100);
      }, 40);

      const stream = canvas.captureStream(25);

      if (WANT_AUDIO) {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ac = new AC();
        const osc = ac.createOscillator();
        osc.frequency.value = 660;          // mikrofonun 440 Hz tonundan AYRI
        const dest = ac.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        const at = dest.stream.getAudioTracks();
        for (let i = 0; i < at.length; i++) stream.addTrack(at[i]);
        window.__fixtureAudioContext = ac;
      }

      window.__displayFixtureStream = stream;
      return stream;
    }

    navigator.mediaDevices.getDisplayMedia = async function () {
      if (!built) built = build();
      return built;
    };
  })();`;
}

/**
 * Uzak ses elemanlarının KİMLİK haritası.
 *
 * `VoicePanel` her uzak ses akışını `data-socket` ile etiketler. Mikrofon
 * `<socketId>`, paylaşım sesi `<socketId>::screen-audio` anahtarını taşır —
 * yani ikisinin BİRBİRİNİ EZMEDİĞİ doğrudan DOM'dan doğrulanabilir.
 */
export const REMOTE_AUDIO_MAP = `(() => {
  return [...document.querySelectorAll('audio.remote-audio')].map(el => ({
    socket: el.getAttribute('data-socket') || '',
    muted: el.muted,
    paused: el.paused,
    hasStream: Boolean(el.srcObject),
    tracks: el.srcObject ? el.srcObject.getAudioTracks().length : 0,
  }));
})()`;

/** Paylaşım sesi anahtar eki — ürün sözleşmesiyle aynı olmalıdır. */
export const SCREEN_AUDIO_SUFFIX = '::screen-audio';
