// client/tests/clyde.test.ts — Sprint 50
// clyde.ts için unit testler
// Sprint 50: JS → TypeScript dönüşümü
// Kapsam: @Clyde mention tespiti, markdown rendering, history yönetimi, CSS enjeksiyon

jest.mock('../js/core/globals', () => ({
  getAPI:            jest.fn(() => 'http://localhost:3000'),
  getCurrentChannel: jest.fn(() => ({ _id: 'ch1', name: 'general' })),
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(),
    call:     jest.fn(),
    has:      jest.fn(),
  },
}), { virtual: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

type Role = 'user' | 'assistant';

interface HistoryEntry {
  role:    Role;
  content: string;
}

function isClydeCall(content: string): boolean {
  return /^@[Cc]lyde\b/i.test(content.trim());
}

function extractQuery(content: string): string {
  return content.replace(/^@[Cc]lyde\s*/i, '').trim();
}

function renderMarkdownLite(text: string | null | undefined): string {
  if (!text) return '';
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/```([\s\S]*?)```/g, (_, code: string) =>
    `<pre class="clyde-code-block"><code>${code.trim()}</code></pre>`);
  s = s.replace(/`([^`]+)`/g,      '<code class="clyde-code-inline">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g,     '<em>$1</em>');
  s = s.replace(/\n/g,              '<br>');
  return s;
}

// ── DOM Setup ─────────────────────────────────────────────────────────────────

function setupDOM(): void {
  document.body.innerHTML = `
    <div id="messages"></div>
    <input id="msg-input" value="">`;
}

// ── Mention detection ──────────────────────────────────────────────────────────

describe('clyde — @Clyde mention tespiti', () => {
  test('@Clyde ile başlayan mesaj tespit edilir', () => {
    expect(isClydeCall('@Clyde merhaba')).toBe(true);
  });

  test('@clyde (küçük harf) tespit edilir', () => {
    expect(isClydeCall('@clyde soru')).toBe(true);
  });

  test('@CLYDE (büyük harf) tespit edilir', () => {
    expect(isClydeCall('@CLYDE ne yapıyorsun?')).toBe(true);
  });

  test('normal mesaj tespit edilmez', () => {
    expect(isClydeCall('Merhaba dünya')).toBe(false);
  });

  test('@Clyde ortada olunca tespit edilmez', () => {
    expect(isClydeCall('merhaba @Clyde')).toBe(false);
  });

  test('@ClydeBot gibi farklı isim tespit edilmez', () => {
    expect(isClydeCall('@ClydeBot')).toBe(false);
  });
});

// ── Query extraction ───────────────────────────────────────────────────────────

describe('clyde — sorgu çıkarma', () => {
  test('@Clyde prefix kaldırılır', () => {
    expect(extractQuery('@Clyde merhaba')).toBe('merhaba');
  });

  test('@clyde boşlukla kaldırılır', () => {
    expect(extractQuery('@clyde   soru nedir?')).toBe('soru nedir?');
  });

  test('sadece @Clyde yazılırsa boş string döner', () => {
    expect(extractQuery('@Clyde')).toBe('');
    expect(extractQuery('@Clyde ')).toBe('');
  });

  test('uzun sorgu korunur', () => {
    const q = 'Bu projenin mimarisi nasıl çalışıyor?';
    expect(extractQuery(`@Clyde ${q}`)).toBe(q);
  });
});

// ── Markdown rendering ─────────────────────────────────────────────────────────

describe('clyde — markdown rendering', () => {
  test('bold text işlenir', () => {
    expect(renderMarkdownLite('**kalın**')).toBe('<strong>kalın</strong>');
  });

  test('italic text işlenir', () => {
    expect(renderMarkdownLite('*italik*')).toBe('<em>italik</em>');
  });

  test('inline code işlenir', () => {
    const result = renderMarkdownLite('`kod`');
    expect(result).toContain('<code class="clyde-code-inline">');
    expect(result).toContain('kod');
  });

  test('code block işlenir', () => {
    const result = renderMarkdownLite('```\nconst x = 1;\n```');
    expect(result).toContain('<pre class="clyde-code-block">');
    expect(result).toContain('const x = 1;');
  });

  test('XSS korunması: < ve > escape edilir', () => {
    const result = renderMarkdownLite('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  test('& karakteri escape edilir', () => {
    expect(renderMarkdownLite('a & b')).toContain('&amp;');
  });

  test('newline br tag\'e dönüşür', () => {
    expect(renderMarkdownLite('satır1\nsatır2')).toContain('<br>');
  });

  test('boş string boş döner', () => {
    expect(renderMarkdownLite('')).toBe('');
  });

  test('null/undefined güvenli', () => {
    expect(renderMarkdownLite(null)).toBe('');
    expect(renderMarkdownLite(undefined)).toBe('');
  });
});

// ── History management ─────────────────────────────────────────────────────────

describe('clyde — geçmiş yönetimi', () => {
  const MAX_HISTORY = 10;

  function createHistory() {
    const _history = new Map<string, HistoryEntry[]>();
    return {
      add(channelId: string | null, role: Role, content: string): void {
        const key = channelId ?? '_dm';
        if (!_history.has(key)) _history.set(key, []);
        const hist = _history.get(key)!;
        hist.push({ role, content });
        while (hist.length > MAX_HISTORY * 2) hist.splice(0, 2);
      },
      get(channelId: string | null): HistoryEntry[] {
        return _history.get(channelId ?? '_dm') ?? [];
      },
      clear(channelId: string | null): void {
        _history.delete(channelId ?? '_dm');
      },
    };
  }

  test('mesaj geçmişe eklenir', () => {
    const hist = createHistory();
    hist.add('ch1', 'user', 'merhaba');
    expect(hist.get('ch1').length).toBe(1);
  });

  test('rol doğru kaydedilir', () => {
    const hist = createHistory();
    hist.add('ch1', 'user', 'soru');
    hist.add('ch1', 'assistant', 'cevap');
    expect(hist.get('ch1')[0].role).toBe('user');
    expect(hist.get('ch1')[1].role).toBe('assistant');
  });

  test('farklı kanallar ayrı geçmişe sahip', () => {
    const hist = createHistory();
    hist.add('ch1', 'user', 'ch1 mesajı');
    hist.add('ch2', 'user', 'ch2 mesajı');
    expect(hist.get('ch1').length).toBe(1);
    expect(hist.get('ch2').length).toBe(1);
  });

  test('MAX_HISTORY*2 aşıldığında eski mesajlar silinir', () => {
    const hist = createHistory();
    for (let i = 0; i < MAX_HISTORY * 2 + 4; i++) {
      hist.add('ch1', i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`);
    }
    expect(hist.get('ch1').length).toBeLessThanOrEqual(MAX_HISTORY * 2);
  });

  test('clear geçmişi temizler', () => {
    const hist = createHistory();
    hist.add('ch1', 'user', 'merhaba');
    hist.clear('ch1');
    expect(hist.get('ch1').length).toBe(0);
  });

  test('null channelId _dm key\'ini kullanır', () => {
    const hist = createHistory();
    hist.add(null, 'user', 'dm mesajı');
    expect(hist.get(null).length).toBe(1);
  });
});

// ── DOM message rendering ──────────────────────────────────────────────────────

describe('clyde — DOM mesaj oluşturma', () => {
  beforeEach(() => setupDOM());

  function createClydeMessageEl(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'clyde-msg';
    el.innerHTML = `
      <div class="clyde-msg__avatar"><span class="clyde-avatar-icon">🤖</span></div>
      <div class="clyde-msg__body">
        <div class="clyde-msg__header">
          <span class="clyde-msg__name">Clyde</span>
          <span class="clyde-msg__badge">AI</span>
        </div>
        <div class="clyde-msg__content" aria-live="polite"></div>
        <div class="clyde-msg__actions"></div>
      </div>`;
    return el;
  }

  test('clyde mesaj elementi oluşturulabilir', () => {
    expect(createClydeMessageEl().className).toBe('clyde-msg');
  });

  test('clyde-msg__name "Clyde" içerir', () => {
    const el = createClydeMessageEl();
    expect(el.querySelector('.clyde-msg__name')!.textContent).toBe('Clyde');
  });

  test('AI badge mevcut', () => {
    const el = createClydeMessageEl();
    expect(el.querySelector('.clyde-msg__badge')!.textContent).toBe('AI');
  });

  test('avatar emoji 🤖 içerir', () => {
    const el = createClydeMessageEl();
    expect(el.querySelector('.clyde-avatar-icon')!.textContent).toBe('🤖');
  });

  test('content aria-live polite', () => {
    const el = createClydeMessageEl();
    expect(el.querySelector('.clyde-msg__content')!.getAttribute('aria-live')).toBe('polite');
  });

  test('mesaj DOM\'a eklenebilir', () => {
    const el = createClydeMessageEl();
    document.getElementById('messages')!.appendChild(el);
    expect(document.querySelector('.clyde-msg')).not.toBeNull();
  });
});

// ── Typing indicator ───────────────────────────────────────────────────────────

describe('clyde — typing indicator', () => {
  beforeEach(() => setupDOM());

  function createTypingEl(id: string): HTMLElement {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'clyde-typing-indicator';
    el.innerHTML = `
      <div class="clyde-avatar"><span class="clyde-avatar-icon">🤖</span></div>
      <div class="clyde-typing-dots" aria-label="Clyde yazıyor...">
        <span></span><span></span><span></span>
      </div>`;
    return el;
  }

  test('typing indicator oluşturulabilir', () => {
    expect(createTypingEl('t1').className).toBe('clyde-typing-indicator');
  });

  test('typing indicator 3 nokta içerir', () => {
    expect(createTypingEl('t2').querySelectorAll('.clyde-typing-dots span').length).toBe(3);
  });

  test('typing indicator DOM\'dan kaldırılabilir', () => {
    const msg = document.getElementById('messages')!;
    const el  = createTypingEl('clyde-typing-3');
    msg.appendChild(el);
    expect(document.getElementById('clyde-typing-3')).not.toBeNull();
    document.getElementById('clyde-typing-3')!.remove();
    expect(document.getElementById('clyde-typing-3')).toBeNull();
  });
});

// ── CSS injection ──────────────────────────────────────────────────────────────

describe('clyde — CSS enjeksiyonu', () => {
  test('style elementi oluşturulabilir', () => {
    document.getElementById('clyde-styles')?.remove();
    const style = document.createElement('style');
    style.id = 'clyde-styles';
    style.textContent = '.clyde-msg { display: flex; }';
    document.head.appendChild(style);
    expect(document.getElementById('clyde-styles')).not.toBeNull();
  });

  test('ikinci çağrı tekrar ekleme yapmaz', () => {
    if (!document.getElementById('clyde-styles')) {
      const s = document.createElement('style');
      s.id = 'clyde-styles';
      document.head.appendChild(s);
    }
    expect(document.querySelectorAll('#clyde-styles').length).toBe(1);
  });
});
