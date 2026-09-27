// server/jobs/chunkSessionSweeper.ts — Terk edilmiş parçalı yükleme oturumlarını
// (`_chunks/<sha256>`) diskten siler.
//
// `jobs/cleanupUploads.ts` BİLEREK yalnızca yükleme kökünü temizler; `_chunks/`
// onun kapsamı dışındadır (`isReapable`). Bu iş olmadan son parçası hiç
// gönderilmeyen her oturum disk dolana kadar kalıyordu.
//
// Eşik, kota modülünün oturum TTL'idir (CHUNK_UPLOAD_SESSION_TTL_MIN): kota bir
// oturumu unuttuğu anda disk tarafı da aynı eşikle geri alınır. Etkin bir
// finalizasyon kilidi taşıyan ya da yakın zamanda dokunulmuş oturumlara
// dokunulmaz; paylaşılan birimde birden çok düğümün eşzamanlı çalışması
// güvenlidir (silme idempotenttir).

import logger from '../lib/logger';
import { uploadDir } from '../lib/runtimePaths';
import { sweepStaleChunkSessions } from '../lib/chunkUploadSafety';
import { chunkQuotaConfig } from '../lib/chunkUploadQuota';

const SWEEP_INTERVAL_MS = 10 * 60_000;
const FIRST_SWEEP_DELAY_MS = 60_000;

export function runChunkSessionSweep(nowMs = Date.now()): { removed: number; kept: number } {
  const result = sweepStaleChunkSessions(uploadDir('_chunks'), nowMs, chunkQuotaConfig().sessionTtlMs);
  if (result.removed > 0) {
    logger.info({ event: 'upload.chunk_sessions_swept', ...result }, '[chunk-sweep] Abandoned chunk sessions removed.');
  }
  return result;
}

let _sweepTimer: ReturnType<typeof setInterval> | null = null;
let _firstSweepTimer: ReturnType<typeof setTimeout> | null = null;

function sweepSafely(): void {
  try {
    runChunkSessionSweep();
  } catch (err) {
    logger.error({ err, event: 'upload.chunk_sweep_failed' }, '[chunk-sweep] Sweep failed.');
  }
}

export function startChunkSessionSweeper(): void {
  if (_sweepTimer !== null || _firstSweepTimer !== null) return;
  _firstSweepTimer = setTimeout(() => {
    _firstSweepTimer = null;
    sweepSafely();
  }, FIRST_SWEEP_DELAY_MS);
  _firstSweepTimer.unref?.();
  _sweepTimer = setInterval(sweepSafely, SWEEP_INTERVAL_MS);
  _sweepTimer.unref?.();
}

export function stopChunkSessionSweeper(): void {
  if (_firstSweepTimer !== null) {
    clearTimeout(_firstSweepTimer);
    _firstSweepTimer = null;
  }
  if (_sweepTimer !== null) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}
