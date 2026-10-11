// server/tests/security-corpus.test.ts
//
// GÜVENLİK GERİLEME KORPUSU — CİDDİ BRIDGE AÇIKLARININ KALICI BEKÇİSİ
//
// ════════════════════════════════════════════════════════════════════════════
// AMAÇ
// ════════════════════════════════════════════════════════════════════════════
// Bridge bu programlar boyunca gerçek, kanıtlanmış açıklar üretti: çapraz
// kiracı soket enjeksiyonu, ses eş listesi sızıntısı, SSRF, rol yükseltme,
// yasak tersine dönmesi, yükleme/reaper veri kaybı, proxy IP sahteciliği,
// kimlik taklidi ve daha fazlası.
//
// Bu dosya TESTLERİ ÇOĞALTMAZ. Tek bir KANONİK LİSTE tutar ve o listenin
// doğru kaldığını doğrular. Böylece:
//
//   npm run test:security
//
// tek komutla bu sınıfların HEPSİNİ koşturur ve gelecekteki bir sürüm eski
// bir P0/P1'i sessizce geri getiremez.
//
// ── NEDEN BİR KAYIT DOSYASI DEĞİL DE TEST ───────────────────────────────────
// Düz bir liste bayatlar: dosya yeniden adlandırılır, liste sessizce ölü
// referans taşır ve "güvenlik korpusu" yalan söyler. Aşağıdaki testler
// listedeki her dosyanın GERÇEKTEN var olduğunu doğrular — yani liste
// çürüyemez.

import fs from 'fs';
import path from 'path';

const TESTS_DIR = __dirname;

/**
 * KANONİK KORPUS.
 *
 * Her giriş: kanıtlanmış bir açık sınıfı → onu koruyan test dosyası.
 * Yeni bir ciddi açık kapatıldığında buraya EKLENMELİDİR.
 */
export const SECURITY_CORPUS: ReadonlyArray<{ sinif: string; dosya: string }> = [
  // Independent audit: current authorization, deletion and hidden presence.
  { sinif: 'semantic history, digest and cached explanation confidentiality (P1)', dosya: 'semantic-confidentiality-regression.test.ts' },
  { sinif: 'hidden public presence and activity confidentiality (P1)', dosya: 'presence-public-surfaces-security.test.ts' },
  { sinif: 'HTTP signature acceptance and rejection contracts', dosya: 'httpSignature.test.ts' },
  // ── Kiracı izolasyonu / soket güvenliği ────────────────────────────────
  { sinif: 'çapraz kiracı yayın enjeksiyonu (P0)',      dosya: 'broadcast-tenancy.test.ts' },
  { sinif: 'ses eş listesi çapraz kiracı sızıntısı (P1)', dosya: 'voice-leave-tenancy.test.ts' },
  { sinif: 'aktivite (tuval/satranç) kiracı sınırı (P1)', dosya: 'activity-tenancy.test.ts' },
  { sinif: 'kanal görünürlüğü / mesaj kapsamı',          dosya: 'messages-channel-visibility.test.ts' },

  // ── SSRF ────────────────────────────────────────────────────────────────
  { sinif: 'giden istek SSRF politikası',                dosya: 'fetch-ssrf.test.ts' },
  { sinif: 'web-push SSRF',                              dosya: 'webpush-ssrf.test.ts' },

  // ── Kimlik / oturum / kurtarma ──────────────────────────────────────────
  { sinif: '2FA yedek kodu JSONB kullanılamazlığı (P1)', dosya: 'twofactor-backup-codes.test.ts' },
  { sinif: '2FA devre dışı bırakma parola atlatma (P1)',  dosya: 'twofactor-disable-authz.test.ts' },
  { sinif: 'oturum iptali / şifre değiştirme',            dosya: 'auth-session-lifecycle.test.ts' },
  { sinif: 'avatar/banner MIME sahteciliği',              dosya: 'avatar-banner-upload-security.test.ts' },
  { sinif: 'medya jetonu kapsamı',                        dosya: 'media-token-scope.test.ts' },
  { sinif: 'CSRF jeton deposu',                           dosya: 'csrf-token-store.test.ts' },

  // ── Yetki / rol ─────────────────────────────────────────────────────────
  { sinif: 'yönetici ayrıcalık sınırı',                   dosya: 'admin-privilege-boundary.test.ts' },
  { sinif: 'kanal izinleri (gelişmiş)',                   dosya: 'channelPermsAdvanced.test.ts' },
  { sinif: 'biçimsel yetki değişmezleri',                 dosya: 'invariants-property.test.ts' },
  { sinif: 'plugin action tenant/role authority (P1)',       dosya: 'plugin-actions.test.ts' },

  // ── Ağ kenarı / proxy güveni ────────────────────────────────────────────
  { sinif: 'proxy IP sahteciliği / yasak atlatma (P1)',   dosya: 'client-ip-proxy-trust.test.ts' },
  { sinif: 'WS bağlantı limiti IP sahteciliği (P1)',      dosya: 'ws-connection-limit.test.ts' },
  { sinif: 'soket IP hız sınırı ve otomatik ban',          dosya: 'socket-rate-limit.test.ts' },
  { sinif: 'paylaşılan IP hız sınırı izolasyonu',         dosya: 'shared-ip-rate-limit.test.ts' },
  { sinif: 'federasyon hız sınırı / eş kimliği',          dosya: 'federation-rate-limit.test.ts' },

  // ── Depolama / veri kaybı ───────────────────────────────────────────────
  { sinif: 'reaper kapsam ve sağlayıcı kaosu (P0 sınıfı)', dosya: 'storage-chaos.test.ts' },
  { sinif: 'yükleme dizini güvenliği',                    dosya: 'upload-cleanup-directory-safety.test.ts' },
  { sinif: 'yükleme yetkilendirmesi',                     dosya: 'upload-authz.test.ts' },
  { sinif: 'çıkartma yükleme temizliği',                  dosya: 'sticker-upload-cleanup.test.ts' },
  { sinif: 'yükleme MIME/uzantı içerik sahteciliği (P1)', dosya: 'upload-file-safety.test.ts' },
  { sinif: 'chunk oturum izolasyonu / limit bypassı (P1)',    dosya: 'chunk-upload-safety.test.ts' },
  { sinif: 'chunk yükleme kaynak tüketme / kota kapalı-başarısız (P1)', dosya: 'chunk-upload-abuse-boundary.test.ts' },
  { sinif: 'mesaj eki görünürlük ve ATTACH_FILES sınırı (P1)', dosya: 'messages-send.test.ts' },
  { sinif: 'mesaj silme payload scrub / transport tutarlılığı (P1)', dosya: 'deleteMessageCascade.test.ts' },
  { sinif: 'private/public storage bucket ayrımı (P1)',     dosya: 'private-storage-boundary.test.ts' },

  // ── Girdi / ayrıştırma ──────────────────────────────────────────────────
  { sinif: 'null bayt ile kimliksiz 500 (P2)',            dosya: 'null-byte-rejection.test.ts' },
  { sinif: 'Unicode/Bidi kimlik taklidi (P2)',            dosya: 'display-name-spoofing.test.ts' },

  // ── Gözlemlenebilirlik / kaynak ─────────────────────────────────────────
  { sinif: 'Prometheus etiket kardinalitesi (P2)',        dosya: 'metrics-cardinality.test.ts' },
  { sinif: '/metrics üretimde kapalı devre',              dosya: 'metrics-endpoint-gating.test.ts' },
  { sinif: 'push geri basıncı / açlık (P2)',              dosya: 'push-backpressure.test.ts' },
  { sinif: 'veritabanı çalışma-zamanı ayrıcalığı',        dosya: 'db-privilege-check.test.ts' },

  // ── Veri bütünlüğü ──────────────────────────────────────────────────────
  { sinif: 'kullanıcı yabancı anahtar bütünlüğü',         dosya: 'user-fk-integrity.test.ts' },
  { sinif: 'hesap yaşam döngüsü / silme politikası',      dosya: 'account-lifecycle.test.ts' },
  { sinif: 'invite atomic maxUses claim (P1)', dosya: 'atomic-repository-contracts.test.ts' },
  { sinif: 'E2EE canonical channel authority (P1)', dosya: 'channel-e2ee-authority.test.ts' },
  { sinif: 'DM read receipt membership authority (P1)', dosya: 'dm-read-security.test.ts' },
  { sinif: 'stage stale authority (P1)', dosya: 'stage-security.test.ts' },
];

describe('güvenlik gerileme korpusu', () => {
  it('korpustaki HER dosya GERÇEKTEN var', () => {
    // Liste curuyemez: yeniden adlandirilan bir dosya burada YAKALANIR.
    // Bu olmadan korpus sessizce olu referanslara doner ve yalan soyler.
    const eksik = SECURITY_CORPUS
      .filter(x => !fs.existsSync(path.join(TESTS_DIR, x.dosya)))
      .map(x => `${x.sinif} -> ${x.dosya}`);
    expect({ eksik }).toEqual({ eksik: [] });
  });

  it('korpusta YİNELENEN dosya yok', () => {
    const dosyalar = SECURITY_CORPUS.map(x => x.dosya);
    const yinelenen = dosyalar.filter((d, i) => dosyalar.indexOf(d) !== i);
    expect({ yinelenen }).toEqual({ yinelenen: [] });
  });

  it('korpus anlamlı büyüklükte', () => {
    // Kucuk bir korpus "kapsiyoruz" yanilsamasi yaratir.
    expect(SECURITY_CORPUS.length).toBeGreaterThanOrEqual(28);
  });

  it('her giriş bir AÇIK SINIFI adlandırır — yalnızca dosya adı değil', () => {
    // "auth.test.ts" gibi bir giris neyi korudugunu soylemez; gelecekteki
    // okuyucu neyin gerilemesini engelledigini bilmeli.
    const kotu = SECURITY_CORPUS.filter(x => !x.sinif || x.sinif.length < 10);
    expect({ kotu }).toEqual({ kotu: [] });
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('POZİTİF KONTROL: var olmayan dosya YAKALANIR', () => {
    // Yukaridaki varlik testi, fs.existsSync her zaman true dondurse de
    // yesil kalirdi. Bu, dedektorun gercekten calistigini kanitlar.
    expect(fs.existsSync(path.join(TESTS_DIR, 'kesinlikle-olmayan-dosya.test.ts'))).toBe(false);
  });
});
