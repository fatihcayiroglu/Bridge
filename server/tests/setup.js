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

// Ensure critical test secrets are set
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-do-not-use-in-production';
process.env.REFRESH_SECRET = process.env.REFRESH_SECRET || 'test-refresh-secret-key-do-not-use-in-production';

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

// Clean up after all tests
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
});
