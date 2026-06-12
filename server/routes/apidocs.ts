// server/routes/apidocs.ts
// Sprint 115 — Swagger UI + OpenAPI spec endpoint'leri
// GET /api/docs         → Swagger UI (HTML)
// GET /api/docs/spec    → OpenAPI 3.1 YAML

import express from 'express';
import path from 'path';
import fs from 'fs';

const router = express.Router();

const SPEC_PATH = path.join(__dirname, '../../docs/api/openapi.yaml');

// Raw OpenAPI spec
router.get('/spec', (_req, res) => {
  if (!fs.existsSync(SPEC_PATH)) {
    return res.status(404).json({ error: 'OpenAPI spec not found' });
  }
  res.setHeader('Content-Type', 'application/yaml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(SPEC_PATH);
});

// Swagger UI — CDN tabanlı, sıfır ek bağımlılık
router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bridge API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/api/docs/spec',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        deepLinking: true,
        displayOperationId: false,
        defaultModelsExpandDepth: 2,
        docExpansion: 'list',
        filter: true,
        requestSnippetsEnabled: true,
      });
    };
  </script>
</body>
</html>`);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
