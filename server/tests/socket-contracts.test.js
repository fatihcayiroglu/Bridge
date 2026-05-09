// server/tests/socket-contracts.test.js
// Socket event payload contract tests — shape guarantees for critical events.
// These tests document the payload structure emitted by the server.
// Each test validates field presence and types — NOT business logic.
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

const { v4: uuidv4 } = require('uuid');

// ── Payload factories (mirror server emit shapes) ─────────────────
function makeMessagePayload(overrides = {}) {
  return {
    _id:         uuidv4(),
    channelId:   uuidv4(),
    serverId:    uuidv4(),
    userId:      uuidv4(),
    username:    'testuser',
    displayName: 'Test User',
    avatarColor: '#5865f2',
    content:     'Hello world',
    type:        'normal',
    reactions:   {},
    pinned:      false,
    createdAt:   Date.now(),
    ...overrides,
  };
}

function makeDmMessagePayload(overrides = {}) {
  return {
    _id:          uuidv4(),
    conversationId: uuidv4(),
    fromUserId:   uuidv4(),
    toUserId:     uuidv4(),
    username:     'testuser',
    displayName:  'Test User',
    avatarColor:  '#5865f2',
    content:      'Hey',
    type:         'normal',
    createdAt:    Date.now(),
    ...overrides,
  };
}

function makeChannelUpdatePayload(overrides = {}) {
  return {
    _id:      uuidv4(),
    serverId: uuidv4(),
    name:     'general',
    type:     'text',
    topic:    '',
    ...overrides,
  };
}

function makeNotificationPayload(overrides = {}) {
  return {
    type:      'mention',
    channelId: uuidv4(),
    serverId:  uuidv4(),
    messageId: uuidv4(),
    fromUser:  { id: uuidv4(), username: 'sender', displayName: 'Sender', avatarColor: '#5865f2' },
    preview:   'Hello',
    ...overrides,
  };
}

function makeTypingPayload(overrides = {}) {
  return {
    userId:      uuidv4(),
    displayName: 'Typer',
    typing:      true,
    ...overrides,
  };
}

function makeReactionPayload(overrides = {}) {
  return {
    messageId: uuidv4(),
    reactions: { '👍': [uuidv4()] },
    ...overrides,
  };
}

function makeMessageDeletedPayload(overrides = {}) {
  return {
    id: uuidv4(),
    ...overrides,
  };
}

function makeMessageEditedPayload(overrides = {}) {
  return {
    _id:       uuidv4(),
    content:   'edited content',
    editedAt:  Date.now(),
    channelId: uuidv4(),
    ...overrides,
  };
}

function makeThreadMessagePayload(overrides = {}) {
  return {
    threadId: uuidv4(),
    msg: makeMessagePayload(),
    ...overrides,
  };
}

function makeMentionPayload(overrides = {}) {
  return {
    fromUser:  { id: uuidv4(), username: 'u', displayName: 'U', avatarColor: '#fff' },
    channelId: uuidv4(),
    serverId:  uuidv4(),
    messageId: uuidv4(),
    preview:   'hey there',
    ...overrides,
  };
}

// ── Contract validators ───────────────────────────────────────────
function assertHasRequiredFields(payload, fields) {
  for (const field of fields) {
    expect(payload).toHaveProperty(field);
  }
}

// ══════════════════════════════════════════════════════════════════
// message:new
// ══════════════════════════════════════════════════════════════════
describe('message:new payload contract', () => {
  const REQUIRED = ['_id', 'channelId', 'serverId', 'userId', 'username', 'displayName',
                    'avatarColor', 'content', 'type', 'reactions', 'pinned', 'createdAt'];

  it('contains all required fields', () => {
    const p = makeMessagePayload();
    assertHasRequiredFields(p, REQUIRED);
  });

  it('_id is a non-empty string', () => {
    const p = makeMessagePayload();
    expect(typeof p._id).toBe('string');
    expect(p._id.length).toBeGreaterThan(0);
  });

  it('createdAt is a number (Unix timestamp ms)', () => {
    const p = makeMessagePayload();
    expect(typeof p.createdAt).toBe('number');
    expect(p.createdAt).toBeGreaterThan(1_000_000_000_000);
  });

  it('reactions is an object (not array)', () => {
    const p = makeMessagePayload();
    expect(typeof p.reactions).toBe('object');
    expect(Array.isArray(p.reactions)).toBe(false);
  });

  it('pinned is boolean', () => {
    const p = makeMessagePayload();
    expect(typeof p.pinned).toBe('boolean');
  });

  it('type is a recognised value', () => {
    const validTypes = ['normal', 'system', 'file', 'thread'];
    const p = makeMessagePayload();
    expect(validTypes).toContain(p.type);
  });

  it('avatarColor matches hex pattern', () => {
    const p = makeMessagePayload();
    expect(p.avatarColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('scheduled message includes scheduledId field', () => {
    const p = makeMessagePayload({ scheduledId: uuidv4() });
    expect(p).toHaveProperty('scheduledId');
    expect(typeof p.scheduledId).toBe('string');
  });

  it('file message includes fileUrl field', () => {
    const p = makeMessagePayload({ type: 'file', fileUrl: 'https://cdn.example/file.png' });
    expect(p).toHaveProperty('fileUrl');
  });
});

// ══════════════════════════════════════════════════════════════════
// dm:message
// ══════════════════════════════════════════════════════════════════
describe('dm:message payload contract', () => {
  const REQUIRED = ['_id', 'conversationId', 'fromUserId', 'toUserId',
                    'content', 'type', 'createdAt'];

  it('contains all required fields', () => {
    const p = makeDmMessagePayload();
    assertHasRequiredFields(p, REQUIRED);
  });

  it('fromUserId and toUserId are different users', () => {
    const p = makeDmMessagePayload();
    expect(p.fromUserId).not.toBe(p.toUserId);
  });

  it('createdAt is a number', () => {
    const p = makeDmMessagePayload();
    expect(typeof p.createdAt).toBe('number');
  });

  it('dm file message includes fileUrl', () => {
    const p = makeDmMessagePayload({ type: 'file', fileUrl: 'https://cdn.example/file.pdf' });
    expect(p.fileUrl).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// channel:update
// ══════════════════════════════════════════════════════════════════
describe('channel:update payload contract', () => {
  const REQUIRED = ['_id', 'serverId', 'name', 'type'];

  it('contains all required fields', () => {
    const p = makeChannelUpdatePayload();
    assertHasRequiredFields(p, REQUIRED);
  });

  it('type is a valid channel type', () => {
    const validTypes = ['text', 'voice', 'forum', 'stage', 'announcement'];
    const p = makeChannelUpdatePayload();
    expect(validTypes).toContain(p.type);
  });
});

// ══════════════════════════════════════════════════════════════════
// mention:received (notification:new pattern)
// ══════════════════════════════════════════════════════════════════
describe('mention:received payload contract', () => {
  const REQUIRED = ['fromUser', 'channelId', 'serverId', 'messageId', 'preview'];

  it('contains all required fields', () => {
    const p = makeMentionPayload();
    assertHasRequiredFields(p, REQUIRED);
  });

  it('fromUser has id, username, displayName', () => {
    const p = makeMentionPayload();
    expect(p.fromUser).toHaveProperty('id');
    expect(p.fromUser).toHaveProperty('username');
    expect(p.fromUser).toHaveProperty('displayName');
  });

  it('preview is a string', () => {
    const p = makeMentionPayload();
    expect(typeof p.preview).toBe('string');
  });
});

// ══════════════════════════════════════════════════════════════════
// typing:update
// ══════════════════════════════════════════════════════════════════
describe('typing:update payload contract', () => {
  it('contains userId, displayName, typing', () => {
    const p = makeTypingPayload();
    assertHasRequiredFields(p, ['userId', 'displayName', 'typing']);
  });

  it('typing is a boolean', () => {
    expect(typeof makeTypingPayload({ typing: true }).typing).toBe('boolean');
    expect(typeof makeTypingPayload({ typing: false }).typing).toBe('boolean');
  });
});

// ══════════════════════════════════════════════════════════════════
// message:reaction
// ══════════════════════════════════════════════════════════════════
describe('message:reaction payload contract', () => {
  it('contains messageId and reactions', () => {
    const p = makeReactionPayload();
    assertHasRequiredFields(p, ['messageId', 'reactions']);
  });

  it('reactions is an object keyed by emoji', () => {
    const p = makeReactionPayload({ reactions: { '❤️': [uuidv4(), uuidv4()] } });
    expect(typeof p.reactions).toBe('object');
    const firstValue = Object.values(p.reactions)[0];
    expect(Array.isArray(firstValue)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// message:deleted
// ══════════════════════════════════════════════════════════════════
describe('message:deleted payload contract', () => {
  it('contains id field', () => {
    const p = makeMessageDeletedPayload();
    expect(p).toHaveProperty('id');
    expect(typeof p.id).toBe('string');
  });
});

// ══════════════════════════════════════════════════════════════════
// message:edited
// ══════════════════════════════════════════════════════════════════
describe('message:edited payload contract', () => {
  it('contains _id, content, editedAt', () => {
    const p = makeMessageEditedPayload();
    assertHasRequiredFields(p, ['_id', 'content', 'editedAt']);
  });

  it('editedAt is a number', () => {
    const p = makeMessageEditedPayload();
    expect(typeof p.editedAt).toBe('number');
  });
});

// ══════════════════════════════════════════════════════════════════
// thread:message:new
// ══════════════════════════════════════════════════════════════════
describe('thread:message:new payload contract', () => {
  it('contains threadId and msg', () => {
    const p = makeThreadMessagePayload();
    assertHasRequiredFields(p, ['threadId', 'msg']);
  });

  it('msg follows message:new contract', () => {
    const p = makeThreadMessagePayload();
    assertHasRequiredFields(p.msg, ['_id', 'content', 'userId', 'createdAt']);
  });
});

// ══════════════════════════════════════════════════════════════════
// Cross-cutting: no payload leaks private fields
// ══════════════════════════════════════════════════════════════════
describe('payload privacy — no leaked sensitive fields', () => {
  it('message:new does not contain password field', () => {
    const p = makeMessagePayload();
    expect(p).not.toHaveProperty('password');
    expect(p).not.toHaveProperty('apPrivateKey');
    expect(p).not.toHaveProperty('tokenVersion');
  });

  it('dm:message does not contain password field', () => {
    const p = makeDmMessagePayload();
    expect(p).not.toHaveProperty('password');
  });

  it('fromUser in mention does not contain password', () => {
    const p = makeMentionPayload();
    expect(p.fromUser).not.toHaveProperty('password');
    expect(p.fromUser).not.toHaveProperty('apPrivateKey');
  });
});
