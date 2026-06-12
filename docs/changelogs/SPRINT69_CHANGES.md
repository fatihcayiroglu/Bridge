# SPRINT69_CHANGES.md

## Sprint 69 — Socket Validation Tamamlama & Coverage Genişletmesi

### 1. Socket Validation — Tüm Handler'lara Yayıldı

**`server/middleware/validate.ts`** — `socketSchemas`'a 20 yeni şema eklendi:

| Grup | Yeni şemalar |
|------|-------------|
| DM | `dmSend`, `dmReact`, `dmCallStart`, `dmCallId` |
| Group DM | `gdmSend`, `gdmGroupId`, `gdmCallStart`, `gdmCallState` |
| Canvas | `canvasChannelId`, `canvasDraw`, `canvasStrokeDelete` |
| Stage | `stageChannelId`, `stageSetRole`, `stageUpdateMute`, `stageSpeaking`, `stageHandRaise`, `stageTarget`, `stageSetTopic`, `stageSetLive` |

**`server/socket/handlers/dm.ts`** — 14 event validate edildi:
`dm:call:start`, `dm:call:accept`, `dm:call:decline`, `dm:call:end`,
`dm:send`, `dm:react`, `gdm:send`, `gdm:typing`, `gdm:call:start`,
`gdm:call:join`, `gdm:call:leave`, `gdm:call:end`, `gdm:call:state`

**`server/socket/handlers/canvas.ts`** — 6 event validate edildi:
`canvas:join`, `canvas:leave`, `canvas:draw`, `canvas:stroke-delete`,
`canvas:clear`, `canvas:state-request`

**`server/socket/handlers/stage.ts`** — 10 event validate edildi:
`stage:join`, `stage:setRole`, `stage:updateMute`, `stage:speaking`,
`stage:handRaise`, `stage:promote`, `stage:demote`, `stage:setTopic`,
`stage:setLive`, `stage:leave`

Artık hiçbir socket handler ham destructuring ile veri almıyor.
Her event ilk satırda `validateSocketPayload` geçmek zorunda.

---

### 2. Server Route Coverage Genişletmesi

**`server/tests/discover-extended.test.ts`** — 20 yeni test:
- `GET /featured` — yalnızca featured döner, max 12 limiti
- `GET /categories` — tüm kategoriler, id+label yapısı
- `PATCH /settings` — owner izni, 400/403/404 edge-cases, kategori filtresi
- `POST /admin/feature` — admin doğrulaması, un-feature, 401/403/404

**`server/tests/bots-extended.test.ts`** — 15 yeni test:
- Bot oluşturma edge-cases (boş isim, çok uzun isim, bilinmeyen server)
- Listeleme (tokenHash sızıntısı kontrolü, boş liste, bilinmeyen server)
- Silme (bilinmeyen botId, silinen bot listede görünmemeli)
- Token rotate (bilinmeyen botId, prefix formatı)
- Webhook detaylı testler (geçerli token, yanlış token, content çok uzun, boş content)

---

### 3. Client Canvas & Stage Test Kapsamı (İlk Kez)

**`client/tests/canvas-stage.test.ts`** — 42 yeni test:

`socketSchemas.canvasChannelId/canvasDraw/canvasStrokeDelete` için 9 test,
`socketSchemas.stage*` 11 şema için 22 test,
`socketSchemas.dm*/gdm*` için 11 test (dmSend, dmReact, dmCallStart vb.),
`validateSocketPayload` genel edge-case testleri (null, string, number payload).

---

### Coverage etkisi (tahmini)

| Modül | Önceki | Sonraki (tahmini) |
|-------|--------|-------------------|
| `socket/handlers/dm.ts` | ~55% | ~78% |
| `socket/handlers/canvas.ts` | ~48% | ~75% |
| `socket/handlers/stage.ts` | ~50% | ~76% |
| `routes/discover.ts` | ~62% | ~82% |
| `routes/bots.ts` | ~65% | ~80% |
| `middleware/validate.ts` | ~78% | ~90% |

---

### Geriye kalan backlog

- [ ] `dm.ts` — `dm:call:offer/answer/ice` WebRTC signaling event'leri için
      `targetUserId` + `callId` validation şemaları eklenebilir
- [ ] `gdm:call:offer/answer/ice` için aynı pattern
- [ ] `routes/music.ts` coverage'ı hâlâ %65 seviyesinde — Sprint 70'e taşındı
- [ ] APNs JWT cache TTL e2e testi — Sprint 70'e taşındı
- [ ] Client `dm-call.ts` modülü için WebRTC mock ile unit testler
