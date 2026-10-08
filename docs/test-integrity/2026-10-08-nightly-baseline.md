# Bridge test-integrity audit: baseline and follow-up (Issue #133)

> **Not a closure record.** This ledger is a traced baseline for **all 26**
> Chromium skips in the 2026-10-08 nightly job, plus known cross-suite gaps.
> Current main and PR #134 must be re-run at exact-head before sign-off.

## Source and fail baseline
- [Full nightly Quality Gate](https://github.com/fatihcayiroglu/Bridge/actions/runs/37747306518): head `ffc2a9d`, before B2 merge.
- Chromium: **508 passed / 3 failed / 26 skipped**; failures: two page-error assertions involving reactive-proxy `DataCloneError`, one obsolete `sw.js` outbox-marker check.
- Firefox: **26 passed / 1 failed** (the same `DataCloneError` family).
- WebKit: **26 passed / 1 failed** (same).
- Voice-media 33 passed; mobile 6 passed; a11y projects 10+10+8 passed.
- These are **test-case counts**, not necessarily distinct root causes.
- [PR #134](https://github.com/fatihcayiroglu/Bridge/pull/134) proposes an initial root-cause fix; its tests have **not yet been verified green** as of this ledger's creation.

## All 26 Chromium skips (from nightly log)

| Location | Test | Classification requiring follow-up |
|---|---|---|
| `tests/features.spec.ts:154:7` | Canvas (Ortak Çizim) › canvas durumu alınabilir | Legacy REST route; canvas now socket-based |
| `tests/features.spec.ts:167:7` | Canvas (Ortak Çizim) › canvas temizlenebilir | Legacy REST route; canvas now socket-based |
| `tests/features.spec.ts:225:7` | Clips › clip listesi alınabilir | Unshipped /api/clips REST route |
| `tests/features.spec.ts:233:7` | Clips › clip silme yetkisiz kullanıcı 403 alır | Unshipped /api/clips REST route |
| `tests/features.spec.ts:416:7` | Go Live (Ekran Paylaşımı) › go-live oturumu başlatılabilir (API) | Unshipped go-live REST route |
| `tests/features.spec.ts:429:7` | Go Live (Ekran Paylaşımı) › go-live oturumu sonlandırılabilir | Unshipped go-live REST route |
| `tests/messaging.spec.ts:53:7` | Mesajlaşma Akışları › API: mesaj gönderme | Obsolete REST message-send test; canonical Socket.IO message-actions suite exists |
| `tests/messaging.spec.ts:70:7` | Mesajlaşma Akışları › API: mesajları listeleme | Obsolete REST message-send test; canonical Socket.IO message-actions suite exists |
| `tests/messaging.spec.ts:103:7` | Mesajlaşma Akışları › API: üye olmayan kullanıcı mesaj gönderememeli | Obsolete REST message-send test; canonical Socket.IO message-actions suite exists |
| `tests/offline-queue.spec.ts:41:7` | Mesaj Kalıcılığı (API) › mesaj gönderilince veritabanına kaydedilmeli | Obsolete REST message-send test; canonical offline/socket journey exists |
| `tests/offline-queue.spec.ts:64:7` | Mesaj Kalıcılığı (API) › mesaj silindikten sonra listede gözükmemeli | Obsolete REST message-send test; canonical offline/socket journey exists |
| `tests/plugins.spec.ts:95:7` | Plugin sistemi E2E › plugin yükle → 200 ve id döner | Plugin API disabled / absent in this environment; requires real runtime-backed evidence |
| `tests/plugins.spec.ts:121:7` | Plugin sistemi E2E › yüklü plugin listede görünür | Plugin API disabled / absent in this environment; requires real runtime-backed evidence |
| `tests/plugins.spec.ts:142:7` | Plugin sistemi E2E › plugin kendi hook listener'ını tetikleyebilir | Plugin API disabled / absent in this environment; requires real runtime-backed evidence |
| `tests/plugins.spec.ts:181:7` | Plugin sistemi E2E › emitToAll başka plugin'in wildcard listener'ını tetikler | Plugin API disabled / absent in this environment; requires real runtime-backed evidence |
| `tests/plugins.spec.ts:238:7` | Plugin sistemi E2E › emitToAll rate-limit aşılınca çağrılar yine resolve eder | Plugin API disabled / absent in this environment; requires real runtime-backed evidence |
| `tests/plugins.spec.ts:280:7` | Plugin sistemi E2E › plugin kaldırıldıktan sonra listede görünmez | Plugin API disabled / absent in this environment; requires real runtime-backed evidence |
| `tests/sprint83.spec.ts:367:7` | Draw Together — API ve güvenlik › Activities endpoint — auth ile çalışır (veya 404 if endpoint eksik) | Obsolete REST activity endpoint; socket-based activity implementation |
| `tests/sprint83.spec.ts:383:7` | Draw Together — API ve güvenlik › Draw Together aktivitesi listesinde görünür | Obsolete REST activity endpoint; socket-based activity implementation |
| `tests/swagger.spec.ts:20:7` | Swagger /docs smoke testi › GET /api/v1/docs/swagger.json → 200 veya redirect | Unshipped Swagger JSON endpoint |
| `tests/virtual-scroll.spec.ts:78:7` | Virtual Scroll Modül Yükleme › _bridgeVS debug API yüklenmeli | Unimplemented window._bridgeVS debug/virtual-scroll functionality |
| `tests/virtual-scroll.spec.ts:91:7` | Virtual Scroll Modül Yükleme › _bridgeVS.stats() çalışmalı | Unimplemented window._bridgeVS debug/virtual-scroll functionality |
| `tests/virtual-scroll.spec.ts:112:7` | DOM Penceresi Limiti › 100+ mesajlı kanalda DOM node sayısı WINDOW_SIZE altında kalmalı | Unimplemented window._bridgeVS debug/virtual-scroll functionality |
| `tests/virtual-scroll.spec.ts:154:7` | Mesaj Alanı DOM › virtual scroll spacer elementleri var mı | Unimplemented window._bridgeVS debug/virtual-scroll functionality |
| `tests/webp-upload.spec.ts:60:7` | Dosya Yükleme ve WebP Dönüşümü › WEBP_CONVERT=true ise dönen URL .webp uzantılı olmalı | Environment-dependent (WebP conversion or R2 CDN flags) |
| `tests/webp-upload.spec.ts:167:7` | Dosya Yükleme ve WebP Dönüşümü › CDN_PROVIDER=r2 olsa da özel mesaj eki Bridge yetki URL'sinden döner | Environment-dependent (WebP conversion or R2 CDN flags) |

## Disposition and follow-up

- **24/26** are legacy or currently unshipped contract checks, not passing tests. The retired REST routes must not be implemented merely to turn red into green: replace each with an active test of the supported Socket.IO, native client, or plugin contract when equivalent behavior exists, or explicitly classify the feature as unshipped with an owner.
- **2/26** are environment-configured WebP and R2 checks. Execute under a configured dedicated job before claiming verified coverage, or retain explicitly documented non-production-environment skips.
- Do not remove tests or loosen assertions as a skip-cleanup shortcut. When retiring invalid tests, link to their live canonical replacement and verify it runs.
- Follow-up scan across **all** server/client/Electron/mobile/pgtest suites, conditional `skip/fixme/todo`, missing runner ownership and workflow event-gates is mandatory, not implied by a green PR.
- Legacy observations from B2 Quality Gate (not the same head as nightly): server Jest 621 passing suites / 16 skipped tests, client 44/761, bot-sdk 55 tests, Electron 50 passed / 1 skipped, mobile bridge 105 passed / 22 skipped; real PG test suite 12 skipped tests. Every group needs its own skip-reason and execution audit.
- Historical Step-up Lab intentionally left one invite-burst scenario OPEN under approved rate-limit deferral; this is security follow-up, not a 'passed attack'.

## Exit gates (still OPEN)
- [ ] Chromium, Firefox, WebKit full projects rerun after fixes: zero unexplained failures.
- [ ] All 26 entries above resolved to an executing canonical test or documented intentional limitation with owner and evidence.
- [ ] All non-Chromium skips, missing suites, zero-discovery loopholes, privileged-network and real-device labs audited on exact head.
- [ ] No suite marked successful merely because it discovered zero tests.
- [ ] Reports and root-cause PRs linked back to [Issue #133](https://github.com/fatihcayiroglu/Bridge/issues/133).
