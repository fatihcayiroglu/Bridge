// server/routes/channels/index.ts
// Sprint 108: channels.ts (302 satır, 3 sorumluluk) → 3 alt dosyaya bölündü.
// Bu dosya yalnızca router'ları birleştirir ve dışa aktarır.
//
// setupRoutes.ts'de güncellendi:
//   import channelsRouter from '../routes/channels/index';
//
// Alt modüller:
//   CRUD is owned by routes/servers/channels.ts; crud.ts is compatibility-only.
//   voice.ts  → POST/GET /channels/:channelId/voice-state|voice-members

import { Router } from 'express';
import voiceRouter from './voice';

const router = Router({ mergeParams: true });

router.use('/', voiceRouter);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
