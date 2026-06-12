// server/tests/helpers/setup.ts
// Shared integration helpers for route-level Jest/SuperTest suites.

import express, { Application } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupRoutes } from '../../app/setupRoutes';
import db from '../../db/loader';
import { Users, Servers } from '../../db/repositories';

export interface TestUserHandle {
  userId: string;
  username: string;
  email: string;
  password: string;
  token?: string;
}

export interface TestServerOptions {
  name?: string;
  icon?: string;
  discoverable?: boolean;
  category?: string;
  featured?: boolean;
  [key: string]: unknown;
}

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function withBrowserLikeHeaders<T extends request.Test>(test: T): T {
  return test
    .set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36')
    .set('Accept', 'application/json')
    .set('Accept-Language', 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7')
    .set('Accept-Encoding', 'gzip, deflate, br')
    .set('Sec-Fetch-Site', 'same-origin') as T;
}

export async function createTestApp(): Promise<Application> {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-do-not-use-in-production';
  process.env.REFRESH_SECRET = process.env.REFRESH_SECRET || 'test-refresh-secret-key-do-not-use-in-production-32chars';
  process.env.RL_REGISTER_MAX = process.env.RL_REGISTER_MAX || '1000';
  process.env.RL_LOGIN_MAX = process.env.RL_LOGIN_MAX || '1000';
  process.env.RL_SERVERS_MAX = process.env.RL_SERVERS_MAX || '1000';
  process.env.RL_WRITE_MAX = process.env.RL_WRITE_MAX || '1000';

  const resettableDb = db as typeof db & { _reset?: () => void };
  resettableDb._reset?.();

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  setupRoutes(app);
  return app;
}

export async function createTestUser(app: Application, overrides: Partial<TestUserHandle> = {}): Promise<TestUserHandle> {
  const suffix = uniqueSuffix();
  const username = overrides.username || `user_${suffix}`;
  const password = overrides.password || 'Password123!';

  const res = await withBrowserLikeHeaders(request(app)
    .post('/api/register'))
    .send({ username, password, displayName: username })
    .expect(200);

  const userId = res.body.user?._id || res.body.user?.id;
  if (!userId) throw new Error('createTestUser: register response did not include a user id');

  return {
    userId,
    username,
    // Older suites use the property name "email" as the login identifier.
    email: overrides.email || username,
    password,
    token: res.body.token,
  };
}

export async function createAdminUser(app: Application, overrides: Partial<TestUserHandle> = {}): Promise<TestUserHandle> {
  const user = await createTestUser(app, { username: overrides.username || `admin_${uniqueSuffix()}`, ...overrides });
  await Users.update(user.userId, { role: 'admin', flags: ['admin'], isAdmin: true });
  user.token = await loginUser(app, user.email, user.password);
  return user;
}

export async function loginUser(app: Application, usernameOrEmail: string, password: string): Promise<string> {
  const res = await withBrowserLikeHeaders(request(app)
    .post('/api/login'))
    .send({ username: usernameOrEmail, password })
    .expect(200);
  if (!res.body.token) throw new Error('loginUser: login response did not include a token');
  return res.body.token;
}

export async function createTestServer(
  app: Application,
  token: string,
  options: TestServerOptions = {},
): Promise<Record<string, unknown>> {
  const res = await withBrowserLikeHeaders(request(app)
    .post('/api/servers'))
    .set('Authorization', `Bearer ${token}`)
    .send({ name: options.name || `Server ${uniqueSuffix()}`, icon: options.icon })
    .expect(200);

  const server = res.body as Record<string, unknown>;
  const serverId = String(server._id || server.id || '');
  if (!serverId) throw new Error('createTestServer: create response did not include a server id');

  const patch: Record<string, unknown> = {};
  for (const key of ['discoverable', 'category', 'featured']) {
    if (options[key] !== undefined) patch[key] = options[key];
  }
  if (Object.keys(patch).length) {
    if (patch.discoverable !== undefined) patch.discoverable = patch.discoverable ? 1 : 0;
    if (patch.featured !== undefined) {
      patch.featured = patch.featured ? 1 : 0;
      patch.featuredAt = patch.featured ? Date.now() : null;
    }
    await Servers.update(serverId, patch);
    return { ...server, ...patch } as Record<string, unknown>;
  }

  return server;
}
