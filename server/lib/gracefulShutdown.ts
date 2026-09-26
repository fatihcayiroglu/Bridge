// server/lib/gracefulShutdown.ts
//
// SIGTERM/SIGINT İLE DÜZENLİ KAPANIŞ (Final21 Faz 19)
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN KUSUR (üretim imajında ölçüldü: tools/p19-prod-sim-p4b.sh)
// ════════════════════════════════════════════════════════════════════════════
// Kapanış yalnızca `server.close()` çağırıyordu. HTTP sunucusu AÇIK bağlantılar bitene kadar
// kapanmaz ve Socket.IO istemcileri kalıcı bağlantıdır: tek bir bağlı istemciyle bile kapanış
// 10 sn'lik zorlamaya kadar asılı kaldı ve süreç KOD 1 ile çıktı ("Graceful shutdown zaman aşımı").
// İstemci düzenli bir sunucu kopuşu yerine süreç ölünce "transport close" gördü. Kubernetes'te
// her dağıtım bir çökme gibi kaydedilir ve istemciler 10 sn ölü bir sokette kalırdı.
//
// SIRA: işler durdurulur → Socket.IO kapatılır (her soket kapatılır, bağdaştırıcı ve motor
// kapanır, ardından HTTP sunucusu yeni bağlantı almayı bırakır; Node boşta bekleyen keep-alive
// bağlantılarını da kapatır) → çıkış 0. Zaman aşımı yedeği korunur (kod 1).

export interface ShutdownTarget {
  /** Socket.IO `Server.close`: soketleri, bağdaştırıcıyı, motoru ve bağlı HTTP sunucusunu kapatır. */
  close(fn?: (err?: Error) => void): unknown;
}

export interface ShutdownDeps {
  io: ShutdownTarget;
  stopJobs: () => void;
  exit: (code: number) => void;
  log: {
    info: (obj: Record<string, unknown> | string, msg?: string) => void;
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
  timeoutMs?: number;
}

export function createGracefulShutdown(deps: ShutdownDeps): (signal: string) => void {
  let started = false;
  return (signal: string) => {
    // İkinci sinyal (ör. SIGTERM ardından SIGINT) kapanışı yeniden başlatmaz.
    if (started) return;
    started = true;
    deps.log.info({ signal }, 'Shutdown sinyali alındı, kapatılıyor...');
    deps.stopJobs();
    const timer = setTimeout(() => {
      deps.log.warn('Graceful shutdown zaman aşımı — zorla çıkılıyor');
      deps.exit(1);
    }, deps.timeoutMs ?? 10_000);
    timer.unref?.();
    deps.io.close((err?: Error) => {
      clearTimeout(timer);
      if (err) deps.log.warn({ err: err.message }, 'HTTP sunucusu zaten kapalıydı.');
      deps.log.info('Soketler ve HTTP sunucusu kapatıldı. Çıkılıyor.');
      deps.exit(0);
    });
  };
}
