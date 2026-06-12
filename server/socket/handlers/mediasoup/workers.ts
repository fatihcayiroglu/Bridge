// server/socket/handlers/mediasoup/workers.ts
// Worker havuzu — başlatma, round-robin seçim, crash recovery, dinamik ölçekleme
//
// Sprint 89: _restartWorker race condition düzeltmesi
//   Problem: Worker crash sonrası yeni worker oluşturulana kadar geçen sürede
//            (ortalama ~100ms) getNextWorkerWithIndex() veya rooms.ts eski
//            dead worker referansına erişebiliyordu. sfuWorkers[index] = newWorker
//            ataması oluşturma tamamlanmadan görünürdü (Promise suspend nedeniyle
//            JS event loop'a yeniden girildiğinde slot hâlâ undefined/old).
//   Çözüm:  _restartingSlots Set — restart süresince o index "kilitli" sayılır.
//            getNextWorkerWithIndex() kilitli slot'u atlayarak sağlıklı worker seçer.
//            Yeni worker hazır olunca lock kaldırılır, sfuWorkers[index] atomik
//            olarak güncellenir.

import logger from '../../../lib/logger';
import { config } from './config';
import type { MediasoupModule, MediasoupWorker, WorkerOptions } from './types';

let mediasoup: MediasoupModule | null = null;

(async () => {
  try {
    mediasoup = await import('mediasoup') as unknown as MediasoupModule;
  } catch {
    logger.warn('[SFU] mediasoup paketi yüklü değil — ses kanalları P2P modda çalışır.');
    logger.warn('[SFU] Etkinleştirmek için: cd server && npm install mediasoup');
  }
})();

export const sfuWorkers: MediasoupWorker[] = [];
let workerIndex = 0;

// ── Worker load tracking ───────────────────────────────────────────────────
const _workerRouterCount = new Map<number, number>();

// Sprint 89: Restart sırasında o index "kilitli" — yeni iş yönlendirilmez.
const _restartingSlots = new Set<number>();

export function incrementWorkerLoad(idx: number): void {
  _workerRouterCount.set(idx, (_workerRouterCount.get(idx) ?? 0) + 1);
}

export function decrementWorkerLoad(idx: number): void {
  const cur = _workerRouterCount.get(idx) ?? 0;
  _workerRouterCount.set(idx, Math.max(0, cur - 1));
}

export function getWorkerLoad(idx: number): number {
  return _workerRouterCount.get(idx) ?? 0;
}

export function getMediasoup(): MediasoupModule | null {
  return mediasoup;
}

// ── Worker oluştur ────────────────────────────────────────────────────────
async function _createWorker(index: number, isDev = false): Promise<MediasoupWorker> {
  if (!mediasoup) throw new Error('[SFU] mediasoup yüklü değil');
  const workerOpts: WorkerOptions = {
    logLevel:   isDev ? 'warn' : 'error',
    logTags:    ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    rtcMinPort: config.rtcMinPort,
    rtcMaxPort: config.rtcMaxPort,
  };
  const worker: MediasoupWorker = await mediasoup.createWorker(workerOpts);
  _workerRouterCount.set(index, 0);
  worker.on('died', (error) => {
    logger.error({ err: error, index, event: 'sfu.worker.died' }, `[SFU] Worker ${index} öldü, 2 sn sonra yeniden başlatılıyor`);
    setTimeout(() => _restartWorker(index), 2000);
  });
  return worker;
}

export async function initMediasoup(moduleOverride?: MediasoupModule, _configOverride?: { codecs?: unknown[] }, workerCountOverride?: number): Promise<boolean> {
  if (moduleOverride) mediasoup = moduleOverride;
  if (!mediasoup) return false;
  try {
    const isDev = process.env.NODE_ENV === 'development';
    const workerCount = workerCountOverride ?? config.numWorkers;
    for (let i = 0; i < workerCount; i++) {
      const worker = await _createWorker(i, isDev);
      sfuWorkers.push(worker);
    }
    logger.info(`[SFU] Mediasoup başlatıldı — ${config.numWorkers} worker, portlar: ${config.rtcMinPort}-${config.rtcMaxPort}`);
    _startScalingMonitor();
    return true;
  } catch (e: unknown) {
    logger.error('[SFU] Mediasoup başlatılamadı:', (e as Error).message);
    return false;
  }
}

async function _restartWorker(index: number): Promise<void> {
  if (!mediasoup) return;

  // Sprint 89: Slot'u kilitle — bu sürede getNextWorkerWithIndex() bu index'i atlar.
  _restartingSlots.add(index);
  logger.info(`[SFU] Worker ${index} yeniden başlatılıyor — slot kilitlendi.`);

  try {
    const worker = await _createWorker(index);
    // Atomik güncelleme: Promise tamamlandıktan sonra slot yazılır.
    sfuWorkers[index] = worker;
    logger.info(`[SFU] Worker ${index} yeniden başlatıldı — slot kilidi kaldırıldı.`);
  } catch (e: unknown) {
    logger.error('[SFU] Worker yeniden başlatılamadı:', (e as Error).message);
  } finally {
    // Hata veya başarı — her durumda lock kaldır.
    _restartingSlots.delete(index);
  }
}

// ── Round-robin (en az yüklü, sağlıklı worker'a yönlendir) ───────────────
export function getNextWorker(): MediasoupWorker {
  const { worker } = getNextWorkerWithIndex();
  return worker;
}

export function getNextWorkerWithIndex(): { worker: MediasoupWorker; index: number } {
  if (sfuWorkers.length === 0) {
    throw new Error('[mediasoup] SFU henüz hazır değil — initMediasoup() tamamlanmadı.');
  }

  // Sprint 89: Restart süresindeki (kilitli) slot'ları atla.
  // Eşit yüklü worker'lar arasında round-robin yaparak yükü adil dağıt.
  let selectedIdx = -1;
  let selectedLoad = Infinity;
  for (let offset = 0; offset < sfuWorkers.length; offset++) {
    const idx = (workerIndex + offset) % sfuWorkers.length;
    if (_restartingSlots.has(idx)) continue;
    const load = getWorkerLoad(idx);
    if (load < selectedLoad) { selectedLoad = load; selectedIdx = idx; }
  }

  if (selectedIdx === -1) {
    throw new Error('[mediasoup] Tüm worker\'lar yeniden başlatılıyor, geçici olarak kullanılamıyor.');
  }

  workerIndex = (selectedIdx + 1) % sfuWorkers.length;
  return { worker: sfuWorkers[selectedIdx], index: selectedIdx };
}

export const isSFUReady = (): boolean =>
  sfuWorkers.length > 0 && sfuWorkers.length > _restartingSlots.size;

// ── Dinamik ölçekleme ─────────────────────────────────────────────────────
const getScaleUpThreshold = (): number => parseInt(process.env.SFU_SCALE_UP_ROUTERS   || '20', 10);
const getScaleDownThreshold = (): number => parseInt(process.env.SFU_SCALE_DOWN_ROUTERS || '5', 10);
const getMinWorkers = (): number => parseInt(process.env.SFU_MIN_WORKERS || '1', 10);
const getMaxWorkers = (): number => parseInt(process.env.SFU_MAX_WORKERS || '8', 10);
const getScaleCheckMs = (): number => parseInt(process.env.SFU_SCALE_CHECK_MS || '30000', 10);

let _scalingTimer: ReturnType<typeof setInterval> | null = null;

function _startScalingMonitor(): void {
  if (_scalingTimer) return;
  const scaleCheckMs = getScaleCheckMs();
  _scalingTimer = setInterval(_checkScaling, scaleCheckMs);
  _scalingTimer.unref?.();
  logger.info(`[SFU] Dinamik ölçekleme aktif — kontrol aralığı: ${scaleCheckMs / 1000}s, min: ${getMinWorkers()}, max: ${getMaxWorkers()} worker`);
}

async function _checkScaling(): Promise<void> {
  if (!mediasoup || sfuWorkers.length === 0) return;

  const currentCount = sfuWorkers.length;
  const totalRouters = [..._workerRouterCount.values()].reduce((a, b) => a + b, 0);
  const avgLoad      = totalRouters / currentCount;

  if (avgLoad >= getScaleUpThreshold() && currentCount < getMaxWorkers()) {
    const newIndex = sfuWorkers.length;
    try {
      const worker = await _createWorker(newIndex);
      sfuWorkers.push(worker);
      logger.info(`[SFU] Scale UP — yeni worker eklendi (toplam: ${sfuWorkers.length}, ortalama yük: ${avgLoad.toFixed(1)} router/worker)`);
    } catch (err) {
      logger.error('[SFU] Scale UP hatası:', (err as Error).message);
    }
    return;
  }

  if (avgLoad <= getScaleDownThreshold() && currentCount > getMinWorkers()) {
    let idleIdx = -1;
    let minLoad = Infinity;
    for (let i = 0; i < sfuWorkers.length; i++) {
      if (_restartingSlots.has(i)) continue; // Sprint 89: restart süresindeki slot'u atla
      const load = getWorkerLoad(i);
      if (load < minLoad) { minLoad = load; idleIdx = i; }
    }

    if (idleIdx >= 0 && minLoad === 0) {
      try {
        sfuWorkers[idleIdx].close();
        sfuWorkers.splice(idleIdx, 1);
        const newMap = new Map<number, number>();
        for (let i = 0; i < sfuWorkers.length; i++) {
          const oldIdx = i < idleIdx ? i : i + 1;
          newMap.set(i, _workerRouterCount.get(oldIdx) ?? 0);
        }
        _workerRouterCount.clear();
        newMap.forEach((v, k) => _workerRouterCount.set(k, v));
        logger.info(`[SFU] Scale DOWN — boş worker kapatıldı (toplam: ${sfuWorkers.length})`);
      } catch (err) {
        logger.error('[SFU] Scale DOWN hatası:', (err as Error).message);
      }
    }
  }
}

export function stopScalingMonitor(): void {
  if (_scalingTimer) {
    clearInterval(_scalingTimer);
    _scalingTimer = null;
    logger.info('[SFU] Dinamik ölçekleme durduruldu.');
  }
}

/** @internal Test only */
export function _resetWorkersForTest(): void {
  if (process.env.NODE_ENV !== 'test') return;
  sfuWorkers.length = 0;
  workerIndex = 0;
  _workerRouterCount.clear();
  _restartingSlots.clear();
  if (_scalingTimer) { clearInterval(_scalingTimer); _scalingTimer = null; }
}

/** @internal Test only */
export function _setMediasoupForTest(mod: MediasoupModule): void {
  if (process.env.NODE_ENV !== 'test') return;
  mediasoup = mod;
}

/** @internal Test only — restart slot durumunu sorgula */
export function _isSlotRestarting(idx: number): boolean {
  if (process.env.NODE_ENV !== 'test') return false;
  return _restartingSlots.has(idx);
}
