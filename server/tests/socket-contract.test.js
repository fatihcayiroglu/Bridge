'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../music', () => ({
  getQueue: jest.fn(() => ({ current: null, queue: [] })),
  getVideoInfo: jest.fn(),
  getStreamUrl: jest.fn(),
  skipCurrent: jest.fn(() => null),
  clearQueue: jest.fn(),
}));

const { registerVoiceHandlers } = require('../socket/handlers/voice');
const { registerStageHandlers } = require('../socket/handlers/stage');
const { registerMusicHandlers } = require('../socket/handlers/music');

function makeSocket(id = 'sock-contract') {
  const handlers = {};
  return {
    id,
    on(event, fn) { handlers[event] = fn; },
    emit() {},
    join() {},
    leave() {},
    to() { return { emit() {} }; },
    _trigger(event, payload) { if (handlers[event]) handlers[event](payload); },
  };
}

function makeIo() {
  const emitted = [];
  return {
    _emitted: emitted,
    to(target) {
      return {
        emit(ev, data) {
          emitted.push({ ev, data, target });
        },
      };
    },
  };
}

describe('socket event contracts', () => {
  it('voice:room-update payload shape is stable', () => {
    const io = makeIo();
    const user = { _id: 'u1', displayName: 'A', avatarColor: '#aaa' };
    const socket = makeSocket('s1');
    registerVoiceHandlers(socket, io, user);

    socket._trigger('voice:join', { channelId: 'c1', serverId: 'sv1' });

    const evt = io._emitted.find((e) => e.ev === 'voice:room-update');
    expect(evt).toBeDefined();
    expect(evt.data).toEqual(expect.objectContaining({
      channelId: expect.any(String),
      peers: expect.any(Array),
    }));
  });

  it('stage:state payload includes required keys', () => {
    const io = makeIo();
    const user = { _id: 'u2', displayName: 'B', avatarColor: '#bbb' };
    const socket = makeSocket('s2');
    registerStageHandlers(socket, io, user);

    socket._trigger('stage:join', { channelId: 'st-1' });
    socket._trigger('stage:setRole', { channelId: 'st-1', role: 'speaker' });

    const evt = io._emitted.find((e) => e.ev === 'stage:state');
    expect(evt).toBeDefined();
    expect(evt.data).toEqual(expect.objectContaining({
      channelId: 'st-1',
      speakers: expect.any(Array),
      listeners: expect.any(Array),
    }));
  });

  it('music:play payload includes channel and track', () => {
    const io = makeIo();
    const socket = makeSocket('s3');
    const user = { _id: 'u3', displayName: 'C' };
    registerMusicHandlers(socket, io, user);

    const { getQueue } = require('../music');
    const queues = { 'm-1': { queue: [{ title: 'Track 2' }], current: { title: 'Track 1' } } };
    getQueue.mockImplementation((channelId) => queues[channelId] || { queue: [], current: null });
    const queue = getQueue('m-1');
    queue.queue = [{ title: 'Track 2' }];
    queue.current = { title: 'Track 1' };

    socket._trigger('music:ended', { channelId: 'm-1' });

    const evt = io._emitted.find((e) => e.ev === 'music:play');
    expect(evt).toBeDefined();
    expect(evt.data).toEqual(expect.objectContaining({
      channelId: 'm-1',
      track: expect.objectContaining({ title: expect.any(String) }),
    }));
  });
});
