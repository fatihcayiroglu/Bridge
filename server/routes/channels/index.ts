// server/routes/channels/index.ts
// Sprint 108: channels.ts (302 satır, 3 sorumluluk) → 3 alt dosyaya bölündü.
// Bu dosya yalnızca router'ları birleştirir ve dışa aktarır.
//
// setupRoutes.ts'de güncellendi:
//   import channelsRouter from '../routes/channels/index';
//
// Alt modüller:
//   crud.ts   → POST/PATCH/GET/DELETE /servers/:sid/channels[/:cid]
//   voice.ts  → POST/GET /channels/:channelId/voice-state|voice-members

import { Router } from 'express';
import crudRouter  from './crud';
import voiceRouter from './voice';

const router = Router({ mergeParams: true });

router.use('/', crudRouter);
router.use('/', voiceRouter);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
