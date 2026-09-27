/**
 * server/tests/setup.js
 * Jest global setup for all tests
 * Configures mocks, environment variables, and shared test utilities
 */

const path = require('path');
const fs = require('fs');

// Load .env.test file
const envTestPath = path.join(__dirname, '../../.env.test');
if (fs.existsSync(envTestPath)) {
  require('dotenv').config({ path: envTestPath });
}

// Set test environment
process.env.NODE_ENV = 'test';

// Use hermetic in-memory services for unit tests unless a test explicitly overrides them.
delete process.env.DATABASE_URL;
process.env.CDN_PROVIDER = process.env.CDN_PROVIDER || 'local';

// Ensure critical test secrets are set
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-do-not-use-in-production';
process.env.REFRESH_SECRET = process.env.REFRESH_SECRET || 'test-refresh-secret-key-do-not-use-in-production-32chars';

// ════════════════════════════════════════════════════════════════════════════
// YUKLEMELER TEK KULLANIMLIK BIR DIZINE YONLENDIRILIR
// ════════════════════════════════════════════════════════════════════════════
// Testler daha once GERCEK `server/uploads/` (ve derlenmis kosuda
// `server/dist/uploads/`) icine yaziyordu. Bu incelemede `server/dist/uploads/`
// altinda 83 MB birikmis calisma zamani verisi olculdu -- 154 adet `e2e-*`
// parca dizini dahil. Test verisi kaynak agacinda da derleme ciktisinda da
// birikmemelidir.
//
// Kok her `uploadRoot()` cagrisinda okunur, bu yuzden burada ayarlanmasi
// yeterlidir; ayri ayri testlerin bir sey yapmasi gerekmez.
const osMod = require('os');
if (!process.env.BRIDGE_UPLOAD_ROOT) {
  process.env.BRIDGE_UPLOAD_ROOT =
    fs.mkdtempSync(path.join(osMod.tmpdir(), 'bridge-test-uploads-'));
}

// Global test timeout
jest.setTimeout(10000);

// Suppress console output in tests (optional - comment out to see logs)
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

// Not: setupFiles Jest globals içermez — afterAll için setupFilesAfterEnv kullanın.
