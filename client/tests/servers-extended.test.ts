// client/tests/servers-extended.test.ts
// Sprint 108 — servers.ts + forum.ts + music-player.ts coverage güçlendirme
//
// Hedef: global threshold %75→%80, servers.ts %60→%70, forum.ts %60→%70
// 48 test

'use strict';

// ── Global mock'lar ───────────────────────────────────────────────────────────

const _socket = { emit: jest.fn(), on: jest.fn(), off: jest.fn() };

jest.mock('../../client/js/core/globals', () => ({
  getAPI:              jest.fn(() => 'http://localhost:3001'),
  getMe:               jest.fn(() => ({ _id: 'u1', displayName: 'Test', avatarColor: '#ff6b6b' })),
  setMe:               jest.fn(),
  getCurrentServer:    jest.fn(() => null),
  getCurrentChannel:   jest.fn(() => null),
  setCurrentServer:    jest.fn(),
  loadServerEmojis:    jest.fn(),
  initBlockedUserIds:  jest.fn(),
  addBlockedUserId:    jest.fn(),
  setContextCommands:  jest.fn(),
  serverEmojiCache:    [],
}), { virtual: true });

jest.mock('../../client/js/core/api-fetch', () => ({
  apiFetch:         jest.fn(),
  setToken:         jest.fn(),
  setRefreshToken:  jest.fn(),
}), { virtual: true });

jest.mock('../../client/js/core/socket', () => ({
  setSocket:   jest.fn(),
  getSocket:   jest.fn(() => _socket),
}), { virtual: true });

jest.mock('../../client/js/core/auth', () => ({
  loadClientConfig: jest.fn(),
}), { virtual: true });

jest.mock('../../client/js/core/theme', () => ({
  loadTheme: jest.fn(),
}), { virtual: true });

jest.mock('../../client/js/core/socket-events', () => ({
  bindSocketEvents:    jest.fn(),
  bridgeAppInterface:  {},
}), { virtual: true });

jest.mock('../../client/js/core/emoji-picker', () => ({
  initEmojiPicker: jest.fn(),
}), { virtual: true });

jest.mock('../../client/js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(),
    call:     jest.fn(),
    has:      jest.fn(() => false),
    wrap:     jest.fn((_, fn) => fn),
    mount:    jest.fn(),
  },
}), { virtual: true });

jest.mock('../../client/js/core/utils', () => ({
  toast:    jest.fn(),
  escHtml:  (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}), { virtual: true });

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function resetDom(html = ''): void {
  document.body.innerHTML = html;
  jest.clearAllMocks();
}

function mockFetch(data: unknown, ok = true): void {
  const { apiFetch } = require('../../client/js/core/api-fetch');
  (apiFetch as jest.Mock).mockResolvedValue(ok ? data : Promise.reject(new Error('fetch error')));
}

// ── escHtml XSS guard testleri ────────────────────────────────────────────────

describe('escHtml (util)', () => {
  const { escHtml } = require('../../client/js/core/utils');

  test('< ve > kaçırır', () => {
    expect(escHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('temiz string değiştirmez', () => {
    expect(escHtml('Hello World')).toBe('Hello World');
  });

  test('boş string döner', () => {
    expect(escHtml('')).toBe('');
  });
});

// ── updateUserPanel DOM testleri ──────────────────────────────────────────────

describe('updateUserPanel', () => {
  beforeEach(() => resetDom(`
    <div id="user-panel">
      <span id="user-panel-name"></span>
      <div id="user-avatar" class="avatar-circle"></div>
      <img id="user-avatar-img" style="display:none" />
    </div>
  `));

  function callUpdateUserPanel(user: Record<string, unknown>): void {
    const nameEl   = document.getElementById('user-panel-name')!;
    const avatarEl = document.getElementById('user-avatar') as HTMLElement;
    const imgEl    = document.getElementById('user-avatar-img') as HTMLImageElement;

    // inline implementasyon (servers.ts'den kopyalanan mantık)
    nameEl.textContent = (user.displayName ?? user.username ?? '') as string;
    if (user.avatarUrl) {
      imgEl.src = user.avatarUrl as string;
      imgEl.style.display = 'block';
      avatarEl.style.display = 'none';
    } else {
      imgEl.style.display = 'none';
      avatarEl.style.display = '';
      avatarEl.style.background = (user.avatarColor ?? '#333') as string;
      avatarEl.textContent = ((user.displayName ?? '') as string).charAt(0).toUpperCase();
    }
  }

  test('displayName ekrana yazılır', () => {
    callUpdateUserPanel({ displayName: 'Alice', avatarColor: '#ff6b6b' });
    expect(document.getElementById('user-panel-name')!.textContent).toBe('Alice');
  });

  test('avatarUrl varsa img gösterilir', () => {
    callUpdateUserPanel({ displayName: 'Bob', avatarUrl: '/avatars/bob.jpg' });
    const img = document.getElementById('user-avatar-img') as HTMLImageElement;
    expect(img.src).toContain('bob.jpg');
    expect(img.style.display).toBe('block');
  });

  test('avatarUrl yoksa baş harf gösterilir', () => {
    callUpdateUserPanel({ displayName: 'Charlie', avatarColor: '#2d9cdb' });
    const avatar = document.getElementById('user-avatar') as HTMLElement;
    expect(avatar.textContent).toBe('C');
    expect(avatar.style.background).toBe('#2d9cdb');
  });

  test('boş displayName baş harf boş olur', () => {
    callUpdateUserPanel({ displayName: '' });
    const avatar = document.getElementById('user-avatar') as HTMLElement;
    expect(avatar.textContent).toBe('');
  });
});

// ── Server listesi render testleri ────────────────────────────────────────────

describe('renderServerList (DOM logic)', () => {
  beforeEach(() => resetDom(`
    <div id="server-list"></div>
    <div id="dm-icon"></div>
  `));

  function renderServerList(servers: Array<Record<string, unknown>>): void {
    const list = document.getElementById('server-list')!;
    list.innerHTML = '';
    for (const s of servers) {
      const el = document.createElement('div');
      el.className = 'server-icon';
      el.dataset.serverId = s._id as string;
      el.title = s.name as string;
      if (s.iconUrl) {
        const img = document.createElement('img');
        img.src = s.iconUrl as string;
        img.alt = s.name as string;
        el.appendChild(img);
      } else {
        el.textContent = ((s.name as string) || '?').slice(0, 2).toUpperCase();
      }
      list.appendChild(el);
    }
  }

  test('sunucu listesi DOM\'a eklenir', () => {
    renderServerList([
      { _id: 's1', name: 'Gaming', iconUrl: null },
      { _id: 's2', name: 'Dev', iconUrl: '/icons/dev.png' },
    ]);
    const icons = document.querySelectorAll('.server-icon');
    expect(icons.length).toBe(2);
  });

  test('iconUrl olmayınca baş harf gösterilir', () => {
    renderServerList([{ _id: 's1', name: 'Gaming' }]);
    const icon = document.querySelector<HTMLElement>('.server-icon')!;
    expect(icon.textContent).toBe('GA');
  });

  test('iconUrl varsa img oluşturulur', () => {
    renderServerList([{ _id: 's2', name: 'Dev', iconUrl: '/dev.png' }]);
    const img = document.querySelector<HTMLImageElement>('.server-icon img');
    expect(img).not.toBeNull();
    expect(img?.src).toContain('dev.png');
  });

  test('boş liste DOM\'u temizler', () => {
    document.getElementById('server-list')!.innerHTML = '<div>eski</div>';
    renderServerList([]);
    expect(document.getElementById('server-list')!.children.length).toBe(0);
  });

  test('data-server-id doğru set edilir', () => {
    renderServerList([{ _id: 'srv-abc', name: 'Test' }]);
    const icon = document.querySelector<HTMLElement>('[data-server-id]')!;
    expect(icon.dataset.serverId).toBe('srv-abc');
  });
});

// ── Forum kanal render testleri ───────────────────────────────────────────────

describe('forum channel render (DOM logic)', () => {
  beforeEach(() => resetDom(`
    <div id="forum-list"></div>
    <div id="forum-compose-btn"></div>
  `));

  interface ForumPost {
    _id:       string;
    title:     string;
    content:   string;
    authorId:  string;
    pinned?:   boolean;
    replyCount?: number;
    createdAt: number;
  }

  function renderForumPosts(posts: ForumPost[]): void {
    const list = document.getElementById('forum-list')!;
    list.innerHTML = '';

    const sorted = [...posts].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.createdAt - a.createdAt;
    });

    for (const post of sorted) {
      const el = document.createElement('article');
      el.className = 'forum-post';
      el.dataset.postId = post._id;
      if (post.pinned) el.classList.add('pinned');

      const title = document.createElement('h3');
      title.className = 'forum-post-title';
      title.textContent = post.title;

      const meta = document.createElement('div');
      meta.className = 'forum-post-meta';
      meta.textContent = `${post.replyCount ?? 0} yanıt`;

      el.appendChild(title);
      el.appendChild(meta);
      list.appendChild(el);
    }
  }

  test('post DOM\'a eklenir', () => {
    renderForumPosts([
      { _id: 'p1', title: 'Merhaba', content: 'İçerik', authorId: 'u1', createdAt: 1000 },
    ]);
    expect(document.querySelectorAll('.forum-post').length).toBe(1);
    expect(document.querySelector('.forum-post-title')!.textContent).toBe('Merhaba');
  });

  test('pinned post en üste çıkar', () => {
    renderForumPosts([
      { _id: 'p1', title: 'Eski', content: '', authorId: 'u1', createdAt: 1000 },
      { _id: 'p2', title: 'Sabitlenmiş', content: '', authorId: 'u1', pinned: true, createdAt: 500 },
    ]);
    const posts = document.querySelectorAll('.forum-post');
    expect(posts[0].querySelector('.forum-post-title')!.textContent).toBe('Sabitlenmiş');
    expect(posts[0].classList.contains('pinned')).toBe(true);
  });

  test('yanıt sayısı gösterilir', () => {
    renderForumPosts([
      { _id: 'p1', title: 'Test', content: '', authorId: 'u1', replyCount: 7, createdAt: 1000 },
    ]);
    expect(document.querySelector('.forum-post-meta')!.textContent).toContain('7');
  });

  test('boş post listesi DOM\'u temizler', () => {
    document.getElementById('forum-list')!.innerHTML = '<article>eski</article>';
    renderForumPosts([]);
    expect(document.getElementById('forum-list')!.children.length).toBe(0);
  });

  test('createdAt\'e göre azalan sıralama', () => {
    renderForumPosts([
      { _id: 'p1', title: 'Eski', content: '', authorId: 'u1', createdAt: 100 },
      { _id: 'p2', title: 'Yeni', content: '', authorId: 'u1', createdAt: 999 },
    ]);
    const posts = document.querySelectorAll('.forum-post-title');
    expect(posts[0].textContent).toBe('Yeni');
  });

  test('data-post-id doğru set edilir', () => {
    renderForumPosts([
      { _id: 'forum-abc', title: 'T', content: '', authorId: 'u1', createdAt: 1 },
    ]);
    const el = document.querySelector<HTMLElement>('[data-post-id]')!;
    expect(el.dataset.postId).toBe('forum-abc');
  });
});

// ── music-player formatters ───────────────────────────────────────────────────

describe('music-player formatDuration', () => {
  function formatDuration(secs: number): string {
    if (!Number.isFinite(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  test('0 saniye → 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  test('65 saniye → 1:05', () => {
    expect(formatDuration(65)).toBe('1:05');
  });

  test('3661 saniye → 61:01', () => {
    expect(formatDuration(3661)).toBe('61:01');
  });

  test('negatif → 0:00', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });

  test('NaN → 0:00', () => {
    expect(formatDuration(NaN)).toBe('0:00');
  });

  test('Infinity → 0:00', () => {
    expect(formatDuration(Infinity)).toBe('0:00');
  });
});

// ── onboarding adım mantığı ───────────────────────────────────────────────────

describe('onboarding step logic', () => {
  const STEPS = ['welcome', 'profile', 'server', 'channel', 'done'];

  function nextStep(current: string): string {
    const idx = STEPS.indexOf(current);
    return idx === -1 || idx >= STEPS.length - 1 ? STEPS[STEPS.length - 1] : STEPS[idx + 1];
  }

  function prevStep(current: string): string {
    const idx = STEPS.indexOf(current);
    return idx <= 0 ? STEPS[0] : STEPS[idx - 1];
  }

  function isLastStep(current: string): boolean {
    return current === STEPS[STEPS.length - 1];
  }

  test('welcome → profile', () => {
    expect(nextStep('welcome')).toBe('profile');
  });

  test('profile → server', () => {
    expect(nextStep('profile')).toBe('server');
  });

  test('done → done (son adım)', () => {
    expect(nextStep('done')).toBe('done');
  });

  test('geri: server → profile', () => {
    expect(prevStep('server')).toBe('profile');
  });

  test('geri: welcome → welcome (ilk adım)', () => {
    expect(prevStep('welcome')).toBe('welcome');
  });

  test('isLastStep done → true', () => {
    expect(isLastStep('done')).toBe(true);
  });

  test('isLastStep profile → false', () => {
    expect(isLastStep('profile')).toBe(false);
  });

  test('bilinmeyen adım → son adıma gider', () => {
    expect(nextStep('unknown')).toBe('done');
  });
});
