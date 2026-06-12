/**
 * server/tests/helpers/mocks.ts
 * Common test mocks and utilities — TypeScript version (Sprint 50)
 */

import type { Request, Response, NextFunction } from 'express';

// ── Mock interfaces ───────────────────────────────────────────

export interface MockCache {
  get:   jest.Mock;
  set:   jest.Mock;
  del:   jest.Mock;
  clear: jest.Mock;
}

export interface MockRedis {
  connect:    jest.Mock;
  disconnect: jest.Mock;
  get:        jest.Mock;
  set:        jest.Mock;
  del:        jest.Mock;
}

export interface MockDatabase {
  query:       jest.Mock;
  transaction: jest.Mock;
  release:     jest.Mock;
}

export interface MockIO {
  emit: jest.Mock;
  on:   jest.Mock;
  to:   jest.Mock;
  in:   jest.Mock;
}

// ── Mock instances ────────────────────────────────────────────

export const mockCache: MockCache = {
  get:   jest.fn(),
  set:   jest.fn(),
  del:   jest.fn(),
  clear: jest.fn(),
};

export const mockRedis: MockRedis = {
  connect:    jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  get:        jest.fn(),
  set:        jest.fn(),
  del:        jest.fn(),
};

export const mockDatabase: MockDatabase = {
  query:       jest.fn(),
  transaction: jest.fn(),
  release:     jest.fn(),
};

export const mockIO: MockIO = {
  emit: jest.fn(),
  on:   jest.fn(),
  to:   jest.fn().mockReturnThis(),
  in:   jest.fn().mockReturnThis(),
};

// ── Request / Response factories ─────────────────────────────

export interface MockRequestOverrides {
  user?:    { id: string; username: string; [key: string]: unknown };
  headers?: Record<string, string>;
  body?:    Record<string, unknown>;
  params?:  Record<string, string>;
  query?:   Record<string, string>;
  [key: string]: unknown;
}

export function createMockRequest(overrides: MockRequestOverrides = {}): Partial<Request> {
  return {
    user: { id: 'test-user-id', username: 'testuser' } as never,
    headers: {},
    body: {},
    params: {},
    query: {},
    app: {
      get: jest.fn((key: string) => {
        const services: Record<string, unknown> = { io: mockIO };
        return services[key];
      }),
    } as never,
    ...overrides,
  };
}

export function createMockResponse(): Partial<Response> {
  const res: Partial<Response> = {
    status:       jest.fn().mockReturnThis() as never,
    json:         jest.fn().mockReturnThis() as never,
    send:         jest.fn().mockReturnThis() as never,
    redirect:     jest.fn().mockReturnThis() as never,
    set:          jest.fn().mockReturnThis() as never,
    cookie:       jest.fn().mockReturnThis() as never,
    clearCookie:  jest.fn().mockReturnThis() as never,
  };
  return res;
}

export function createMockNext(): NextFunction {
  return jest.fn() as NextFunction;
}

export function resetAllMocks(): void {
  jest.clearAllMocks();
  (Object.values(mockCache) as jest.Mock[]).forEach(fn => fn.mockClear?.());
  (Object.values(mockRedis) as jest.Mock[]).forEach(fn => fn.mockClear?.());
  (Object.values(mockDatabase) as jest.Mock[]).forEach(fn => fn.mockClear?.());
  (Object.values(mockIO) as jest.Mock[]).forEach(fn => fn.mockClear?.());
}
