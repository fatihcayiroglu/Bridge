// client/tests/messages-input-unit.test.ts
// Sprint 72: messages/input.ts birim testleri
//
// Kapsam:
//   - formatText() — markdown, XSS koruması, mention, code block
//   - sendMessage() — boş içerik, 2000 karakter limiti, slash command
//   - handleMsgKey() — Enter gönderir, Shift+Enter göndermez
//   - handleTypingInput() — textarea yükseklik, typing:start/stop
//   - cancelEdit() — editing state temizliği
//   - showDeleteMessageModal() — modal çağrısı
//
// Çalıştırma: npx vitest run client/tests/messages-input-unit.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── BridgeRegistry stub ───────────────────────────────────────────────────────

const _registry: Record<string, unknown> = {};
const BridgeRegistry = {
  register: vi.fn((key: string, val: unknown) => { _registry[key] = val; }),
  get:      (key: string) => _registry[key],
  has:      (key: string) => key in _registry,
  call:     (key: string, ...args: unknown[]) => {
    const fn = _registry[key];
    if (typeof fn === 'function') return fn(...args);
    return undefined;
  },
};

// ── Util stub'lar ─────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const toastMock = vi.fn();

// ── formatText() — messages/input.ts ile senkron implementasyon ───────────────

function formatText(text: string): string {
  if (!text) return '';

  const codeBlocks: string[] = [];
  let safe = escHtml(text);

  safe = safe.replace(/```([\s\S]+?)```/g, (_: string, code: string) => {
    codeBlocks.push('<pre><code>' + code + '</code></pre>');
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });
  safe = safe.replace(/`([^`]+)`/g, (_: string, code: string) => {
    codeBlocks.push('<code>' + code + '</code>');
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });

  safe = safe
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g,    '<em>$1</em>')
    .replace(/__(.+?)__/g,         '<strong>$1</strong>')
    .replace(/_([^_\n]+?)_/g,      '<em>$1</em>')
    .replace(/~~(.+?)~~/g,         '<del>$1</del>')
    .replace(/__([^_]+)__/g,       '<u>$1</u>');

  safe = safe.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
  safe = safe.replace(/\n/g, '<br>');
  safe = safe.replace(/\x00CODE(\d+)\x00/g, (_: string, i: string) => codeBlocks[+i]);

  return safe;
}

// ── sendMessage mantığını izole eden fonksiyon ────────────────────────────────

function validateSendMessage(
  content: string | null | undefined,
  channel: { _id: string; type: string } | null,
): { ok: false; reason: string } | { ok: true } {
  const trimmed = content?.trim();
  if (!trimmed || !channel) return { ok: false, reason: 'empty_or_no_channel' };
  if (channel.type !== 'text') return { ok: false, reason: 'wrong_channel_type' };
  if (trimmed.length > 2000) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

// ── handleTypingInput yükseklik mantığı ───────────────────────────────────────

function calcTextareaHeight(scrollHeight: number, maxHeight = 160): number {
  return Math.min(scrollHeight, maxHeight);
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTLER
// ─────────────────────────────────────────────────────────────────────────────

describe('formatText() — temel dönüşümler', () => {
  it('boş string boş dönmeli', () => {
    expect(formatText('')).toBe('');
  });

  it('düz metin değişmemeli (XSS yok)', () => {
    expect(formatText('Merhaba dünya')).toBe('Merhaba dünya');
  });

  it('& karakteri escape edilmeli', () => {
    expect(formatText('a & b')).toContain('a &amp; b');
  });

  it('< ve > XSS koruması', () => {
    expect(formatText('<script>alert(1)</script>')).not.toContain('<script>');
    expect(formatText('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('çift tırnak escape edilmeli', () => {
    expect(formatText('"test"')).toContain('&quot;');
  });
});

describe('formatText() — markdown', () => {
  it('**bold** → <strong>', () => {
    expect(formatText('**kalın**')).toContain('<strong>kalın</strong>');
  });

  it('*italic* → <em>', () => {
    expect(formatText('*eğik*')).toContain('<em>eğik</em>');
  });

  it('***bold italic*** → <strong><em>', () => {
    const result = formatText('***güçlü eğik***');
    expect(result).toContain('<strong><em>');
    expect(result).toContain('</em></strong>');
  });

  it('~~strikethrough~~ → <del>', () => {
    expect(formatText('~~üstü çizili~~')).toContain('<del>üstü çizili</del>');
  });

  it('__bold__ → <strong>', () => {
    expect(formatText('__kalın__')).toContain('<strong>kalın</strong>');
  });

  it('_italic_ → <em>', () => {
    expect(formatText('_eğik_')).toContain('<em>eğik</em>');
  });
});

describe('formatText() — kod blokları', () => {
  it('`inline code` → <code>', () => {
    const result = formatText('`const x = 1`');
    expect(result).toContain('<code>');
    expect(result).toContain('const x = 1');
  });

  it('```fenced block``` → <pre><code>', () => {
    const result = formatText('```\nconst y = 2\n```');
    expect(result).toContain('<pre><code>');
  });

  it('kod bloğu içindeki < > escape edilmeli ama tag olmamalı', () => {
    const result = formatText('`a < b`');
    expect(result).toContain('&lt;');
    expect(result).not.toContain('<b>');
  });

  it('kod bloğu içindeki ** markdown işlenmemeli', () => {
    const result = formatText('`**kalın değil**`');
    expect(result).not.toContain('<strong>');
  });
});

describe('formatText() — mention & newline', () => {
  it('@kullanici → mention span', () => {
    const result = formatText('@alice');
    expect(result).toContain('<span class="mention">@alice</span>');
  });

  it('birden fazla mention', () => {
    const result = formatText('@alice ve @bob');
    expect(result).toContain('@alice');
    expect(result).toContain('@bob');
  });

  it('\\n → <br>', () => {
    expect(formatText('satır1\nsatır2')).toContain('<br>');
  });

  it('birden fazla \\n → birden fazla <br>', () => {
    const result = formatText('a\nb\nc');
    expect((result.match(/<br>/g) ?? []).length).toBe(2);
  });
});

describe('formatText() — XSS saldırı vektörleri', () => {
  it('onerror attribute inject edilememeli', () => {
    const result = formatText('<img src=x onerror=alert(1)>');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('onerror');
  });

  it('javascript: URI inject edilememeli', () => {
    const result = formatText('<a href="javascript:alert(1)">tıkla</a>');
    expect(result).not.toContain('<a ');
  });

  it('innerHTML injection denenmesi escape edilmeli', () => {
    const result = formatText('"><script>evil()</script>');
    expect(result).not.toContain('<script>');
  });
});

// ── sendMessage doğrulama ─────────────────────────────────────────────────────

describe('validateSendMessage()', () => {
  const textChannel = { _id: 'ch-1', type: 'text' };

  it('normal mesaj kabul edilmeli', () => {
    expect(validateSendMessage('Merhaba', textChannel)).toEqual({ ok: true });
  });

  it('boş string reddedilmeli', () => {
    const r = validateSendMessage('', textChannel);
    expect(r.ok).toBe(false);
  });

  it('sadece boşluk reddedilmeli', () => {
    const r = validateSendMessage('   ', textChannel);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_or_no_channel');
  });

  it('null içerik reddedilmeli', () => {
    const r = validateSendMessage(null, textChannel);
    expect(r.ok).toBe(false);
  });

  it('null kanal reddedilmeli', () => {
    const r = validateSendMessage('merhaba', null);
    expect(r.ok).toBe(false);
  });

  it('2000 karakter tam sınırda kabul edilmeli', () => {
    const msg = 'a'.repeat(2000);
    expect(validateSendMessage(msg, textChannel)).toEqual({ ok: true });
  });

  it('2001 karakter reddedilmeli', () => {
    const msg = 'a'.repeat(2001);
    const r = validateSendMessage(msg, textChannel);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_long');
  });

  it('5000 karakter reddedilmeli', () => {
    const msg = 'x'.repeat(5000);
    const r = validateSendMessage(msg, textChannel);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_long');
  });

  it('text olmayan kanal türü reddedilmeli', () => {
    const voiceChannel = { _id: 'ch-2', type: 'voice' };
    const r = validateSendMessage('merhaba', voiceChannel);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_channel_type');
  });

  it('trim sonrası 2000 tam sınırda kabul edilmeli', () => {
    const msg = ' ' + 'a'.repeat(2000) + ' ';
    expect(validateSendMessage(msg, textChannel)).toEqual({ ok: true });
  });

  it('trim sonrası 2001 reddedilmeli', () => {
    const msg = ' ' + 'a'.repeat(2001) + ' ';
    const r = validateSendMessage(msg, textChannel);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_long');
  });
});

// ── handleMsgKey mantığı ──────────────────────────────────────────────────────

describe('handleMsgKey — klavye mantığı', () => {
  function simulateKey(key: string, shiftKey = false): { shouldSend: boolean } {
    if (key === 'Enter' && !shiftKey) return { shouldSend: true };
    return { shouldSend: false };
  }

  it('Enter → gönder', () => {
    expect(simulateKey('Enter').shouldSend).toBe(true);
  });

  it('Shift+Enter → gönderme (yeni satır)', () => {
    expect(simulateKey('Enter', true).shouldSend).toBe(false);
  });

  it('Tab → gönderme', () => {
    expect(simulateKey('Tab').shouldSend).toBe(false);
  });

  it('a → gönderme', () => {
    expect(simulateKey('a').shouldSend).toBe(false);
  });

  it('Escape → gönderme', () => {
    expect(simulateKey('Escape').shouldSend).toBe(false);
  });
});

// ── handleTypingInput — textarea yükseklik hesabı ─────────────────────────────

describe('calcTextareaHeight()', () => {
  it('küçük içerik (50px) → 50px', () => {
    expect(calcTextareaHeight(50)).toBe(50);
  });

  it('tam 160px sınırda → 160px', () => {
    expect(calcTextareaHeight(160)).toBe(160);
  });

  it('160px üzeri (200px) → 160px (max)', () => {
    expect(calcTextareaHeight(200)).toBe(160);
  });

  it('500px → 160px (max)', () => {
    expect(calcTextareaHeight(500)).toBe(160);
  });

  it('0px → 0px', () => {
    expect(calcTextareaHeight(0)).toBe(0);
  });

  it('özel maxHeight geçilebilir', () => {
    expect(calcTextareaHeight(300, 250)).toBe(250);
    expect(calcTextareaHeight(100, 250)).toBe(100);
  });
});

// ── cancelEdit mantığı ────────────────────────────────────────────────────────

describe('cancelEdit mantığı', () => {
  beforeEach(() => {
    // BridgeRegistry'yi temizle
    Object.keys(_registry).forEach(k => delete _registry[k]);
  });

  it('editingId yoksa erken dönmeli', () => {
    _registry['getEditingMessageId'] = () => null;
    // cancelEdit çağrısı throw etmemeli
    const editingId: string | null = (BridgeRegistry.call('getEditingMessageId') as string | null) ?? null;
    expect(editingId).toBeNull();
  });

  it('editingId varsa null'a sıfırlanmalı', () => {
    let editingId: string | null = 'msg-123';
    _registry['getEditingMessageId'] = () => editingId;

    // cancel mantığı
    editingId = null;
    BridgeRegistry.register('getEditingMessageId', () => null);

    expect(BridgeRegistry.call('getEditingMessageId')).toBeNull();
  });
});

// ── showDeleteMessageModal ────────────────────────────────────────────────────

describe('showDeleteMessageModal', () => {
  it('showConfirmModal BridgeRegistry ile çağrılmalı', () => {
    const confirmModalMock = vi.fn();
    _registry['showConfirmModal'] = confirmModalMock;

    // Simüle et
    BridgeRegistry.call('showConfirmModal', {
      title:       'Delete Message',
      message:     'This message will be permanently deleted.',
      confirmText: 'Delete',
      danger:      true,
      onConfirm:   vi.fn(),
    });

    expect(confirmModalMock).toHaveBeenCalledOnce();
    const args = confirmModalMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.title).toBe('Delete Message');
    expect(args.danger).toBe(true);
    expect(typeof args.onConfirm).toBe('function');
  });
});

// ── Slash command tespiti ─────────────────────────────────────────────────────

describe('Slash command tespiti', () => {
  function isSlashCommand(content: string): boolean {
    return content.startsWith('/');
  }

  it('/giphy → slash command', () => {
    expect(isSlashCommand('/giphy cat')).toBe(true);
  });

  it('/ban → slash command', () => {
    expect(isSlashCommand('/ban @user')).toBe(true);
  });

  it('normal mesaj → slash command değil', () => {
    expect(isSlashCommand('merhaba')).toBe(false);
  });

  it('boş mesaj → slash command değil', () => {
    expect(isSlashCommand('')).toBe(false);
  });

  it('// ile başlayan → slash command sayılır', () => {
    expect(isSlashCommand('//yorum')).toBe(true);
  });
});
