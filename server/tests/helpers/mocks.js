/**
 * server/tests/helpers/mocks.js
 * Common test mocks and utilities
 */

const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  clear: jest.fn(),
};

const mockRedis = {
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

const mockDatabase = {
  query: jest.fn(),
  transaction: jest.fn(),
  release: jest.fn(),
};

const mockIO = {
  emit: jest.fn(),
  on: jest.fn(),
  to: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
};

/**
 * Create a mock Express Request object
 */
function createMockRequest(overrides = {}) {
  return {
    user: { id: 'test-user-id', username: 'testuser' },
    headers: {},
    body: {},
    params: {},
    query: {},
    app: {
      get: jest.fn((key) => {
        const services = { io: mockIO };
        return services[key];
      }),
    },
    ...overrides,
  };
}

/**
 * Create a mock Express Response object
 */
function createMockResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    cookie: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
  };
  return res;
}

/**
 * Create a mock Next function
 */
function createMockNext() {
  return jest.fn();
}

/**
 * Reset all mocks to clean state
 */
function resetAllMocks() {
  jest.clearAllMocks();
  Object.values(mockCache).forEach(fn => fn.mockClear?.());
  Object.values(mockRedis).forEach(fn => fn.mockClear?.());
  Object.values(mockDatabase).forEach(fn => fn.mockClear?.());
  Object.values(mockIO).forEach(fn => fn.mockClear?.());
}

module.exports = {
  mockCache,
  mockRedis,
  mockDatabase,
  mockIO,
  createMockRequest,
  createMockResponse,
  createMockNext,
  resetAllMocks,
};
