process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';

describe('app/setupSocket runtime owner', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.resetModules(); delete process.env.REDIS_URL; });

  test('createSocketServer passes the bounded CORS/transport/buffer contract to Socket.IO', () => {
    const ctor = jest.fn().mockImplementation((_server, opts) => ({ opts }));
    jest.doMock('socket.io', () => ({ Server: ctor }));
    jest.resetModules();
    const { createSocketServer } = require('../app/setupSocket') as typeof import('../app/setupSocket');
    const http = {} as any;
    const io = createSocketServer(http, ['https://app.example']);
    expect(ctor).toHaveBeenCalledWith(http, {
      cors: { origin: ['https://app.example'], methods: ['GET', 'POST'] },
      transports: ['websocket', 'polling'],
      maxHttpBufferSize: 1e6,
    });
    expect(io).toEqual(expect.objectContaining({ opts: expect.any(Object) }));
  });

  test('setupSocketInfra applies adapter before SFU/handlers and reports active SFU', async () => {
    const order: string[] = [];
    const applyAdapter = jest.fn(async () => { order.push('adapter'); return true; });
    const initMediasoup = jest.fn(async () => { order.push('sfu'); return true; });
    const setupSocket = jest.fn(() => { order.push('handlers'); });
    const info = jest.fn();
    jest.doMock('../lib/redisAdapter', () => ({ applyAdapter }));
    jest.doMock('../socket/handlers/mediasoup/index', () => ({ initMediasoup }));
    jest.doMock('../socket/index', () => ({ setupSocket }));
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: { info } }));
    jest.resetModules();
    const { setupSocketInfra } = require('../app/setupSocket') as typeof import('../app/setupSocket');
    const io = {} as any;
    await setupSocketInfra(io);
    expect(order).toEqual(['adapter', 'sfu', 'handlers']);
    expect(info).toHaveBeenCalledWith({ event: 'mediasoup.start' }, expect.stringContaining('aktif'));
  });

  test('configured Redis without a Socket.IO adapter fails closed before SFU/handlers', async () => {
    process.env.REDIS_URL = 'redis://cluster.example:6379';
    const applyAdapter = jest.fn(async () => false);
    const initMediasoup = jest.fn(async () => true);
    const setupSocket = jest.fn();
    jest.doMock('../lib/redisAdapter', () => ({ applyAdapter }));
    jest.doMock('../socket/handlers/mediasoup/index', () => ({ initMediasoup }));
    jest.doMock('../socket/index', () => ({ setupSocket }));
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: { info: jest.fn() } }));
    jest.resetModules();
    const { setupSocketInfra } = require('../app/setupSocket') as typeof import('../app/setupSocket');
    await expect(setupSocketInfra({} as any)).rejects.toThrow('Redis Socket.IO adapter is required');
    expect(initMediasoup).not.toHaveBeenCalled();
    expect(setupSocket).not.toHaveBeenCalled();
  });

  test('disabled SFU keeps the P2P fallback path and still registers handlers', async () => {
    const info = jest.fn();
    const setupSocket = jest.fn();
    jest.doMock('../lib/redisAdapter', () => ({ applyAdapter: jest.fn(async () => false) }));
    jest.doMock('../socket/handlers/mediasoup/index', () => ({ initMediasoup: jest.fn(async () => false) }));
    jest.doMock('../socket/index', () => ({ setupSocket }));
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: { info } }));
    jest.resetModules();
    const { setupSocketInfra } = require('../app/setupSocket') as typeof import('../app/setupSocket');
    await setupSocketInfra({} as any);
    expect(info).toHaveBeenCalledWith({ event: 'mediasoup.skip' }, expect.stringContaining('P2P'));
    expect(setupSocket).toHaveBeenCalled();
  });
});

describe('db/seed canonical Bridge Global bootstrap', () => {
  const servers = { findOne: jest.fn(), insert: jest.fn() };
  const channels = { insert: jest.fn(), findOne: jest.fn() };
  const messages = { insert: jest.fn() };
  const info = jest.fn();
  let seq = 0;

  function loadSeed() {
    jest.doMock('uuid', () => ({ v4: () => `uuid-${++seq}` }));
    jest.doMock('../db/loader', () => ({ __esModule: true, default: { servers, channels, messages } }));
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: { info } }));
    jest.resetModules();
    return (require('../db/seed') as typeof import('../db/seed')).default;
  }

  beforeEach(() => { jest.clearAllMocks(); seq = 0; });
  afterEach(() => jest.resetModules());

  test('existing Bridge Global makes seed idempotent', async () => {
    servers.findOne.mockResolvedValue({ _id: 'existing' });
    await loadSeed()();
    expect(servers.insert).not.toHaveBeenCalled();
    expect(channels.insert).not.toHaveBeenCalled();
    expect(messages.insert).not.toHaveBeenCalled();
  });

  test('fresh seed creates one server, eleven canonical channels and welcome message', async () => {
    servers.findOne.mockResolvedValue(null);
    channels.findOne.mockImplementation(async (q: any) => q.name === 'general' ? { _id: 'general-id' } : null);
    await loadSeed()();
    expect(servers.insert).toHaveBeenCalledWith(expect.objectContaining({ _id: 'uuid-1', name: 'Bridge Global', ownerId: 'system' }));
    expect(channels.insert).toHaveBeenCalledTimes(11);
    const inserted = channels.insert.mock.calls.map(([v]) => v);
    expect(inserted.map(v => v.order)).toEqual([...Array(11).keys()]);
    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'general', type: 'text', category: 'GENERAL' }),
      expect.objectContaining({ name: 'General Voice', type: 'voice', category: 'VOICE & VIDEO' }),
      expect.objectContaining({ name: 'ai-ml', category: 'TECH' }),
    ]));
    expect(messages.insert).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'general-id', userId: 'system', type: 'system' }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'db.seed.completed' }), expect.stringContaining('seeded'));
  });

  test('missing general channel does not create an orphan welcome message', async () => {
    servers.findOne.mockResolvedValue(null);
    channels.findOne.mockResolvedValue(null);
    await loadSeed()();
    expect(servers.insert).toHaveBeenCalledTimes(1);
    expect(channels.insert).toHaveBeenCalledTimes(11);
    expect(messages.insert).not.toHaveBeenCalled();
  });
});

