// server/tests/automod-policy-contract-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AUTOMOD POLİTİKA SÖZLEŞMESİ — NORMALLEŞTİRME VE UYGULAMA DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// Bu modül İKİ sahibin ortak sözleşmesidir: HTTP CRUD doğrulaması ve gerçek
// zamanlı mesaj uygulaması. İkisi ayrışırsa, kaydedilebilen ama uygulanamayan
// (ya da tersi) bir kural doğar. Ölçülmemiş dallar tam da ayrışmanın olacağı
// yerlerdi:
//
//   · SESSİZ POLİTİKA DEĞİŞİMİ — bozuk kalıcı JSON, uygulama tarafında BOŞ
//     yapılandırmaya indirgenirse `link_filter` gibi varsayılanı geçerli olan
//     bir kural, yöneticinin kurmadığı bir politikaya dönüşür. Uygulama yolu
//     bu yüzden `{}`'a düşmez, HATA fırlatır (fail-closed).
//   · ZORLAMA YOK — hiçbir alan tür zorlamasıyla kabul edilmez: `"5"` sayı
//     değildir, `1` boolean değildir. Zorlama, moderasyon eşiklerini
//     istemcinin belirlemesine kapı açar.
//   · MUAFİYET — `__everyone__` muaf rol olarak kabul edilirse kural HERKESİ
//     muaf tutar; yani kural sessizce kapanır.
//   · DÜZENLEME ≠ GÖNDERME — düzenleme, mesaj sıklığı sayacını tüketmemelidir.

import {
  AUTOMOD_RULE_TYPES,
  evaluateAutomodRules,
  isAutomodRuleType,
  normalizeAutomodConfig,
  parseStoredAutomodConfig,
  type AutomodRuleLike,
} from '../lib/automodPolicy';

const ok = (result: ReturnType<typeof normalizeAutomodConfig>) => {
  if (!result.ok) throw new Error(`beklenmedik reddetme: ${result.error}`);
  return result.config;
};
const err = (result: ReturnType<typeof normalizeAutomodConfig>) => {
  if (result.ok) throw new Error('beklenen reddetme gerçekleşmedi');
  return result.error;
};

// ════════════════════════════════════════════════════════════════════════════
describe('isAutomodRuleType', () => {
  it('yalnız bilinen tür adlarını kabul eder', () => {
    for (const type of AUTOMOD_RULE_TYPES) expect(isAutomodRuleType(type)).toBe(true);
    for (const value of [undefined, null, 42, {}, [], 'BLOCKED_WORDS', 'unknown']) {
      expect(isAutomodRuleType(value)).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('parseStoredAutomodConfig — görüntüleme/göç yolu', () => {
  it('nesneyi KOPYALAYARAK döner (kalıcı satır mutasyondan korunur)', () => {
    const stored = { action: 'delete' };
    const parsed = parseStoredAutomodConfig(stored);

    parsed.action = 'timeout';

    expect(stored.action).toBe('delete');
  });

  it('JSON metnini çözer', () => {
    expect(parseStoredAutomodConfig('{"action":"timeout"}')).toEqual({ action: 'timeout' });
  });

  it.each([
    ['bozuk JSON', '{bozuk'],
    ['JSON dizi', '[1,2]'],
    ['JSON sayı', '42'],
    ['JSON null', 'null'],
    ['sayı', 7],
    ['null', null],
    ['dizi', [1]],
  ])('%s BOŞ nesneye indirgenir', (_label, value) => {
    expect(parseStoredAutomodConfig(value)).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('normalizeAutomodConfig — genel alanlar', () => {
  it('nesne olmayan yapılandırma reddedilir', () => {
    for (const value of [null, undefined, 'x', 42, [1]]) {
      expect(err(normalizeAutomodConfig('link_filter', value))).toBe('config nesne olmalı');
    }
  });

  it('türün DESTEKLEMEDİĞİ anahtar reddedilir', () => {
    expect(err(normalizeAutomodConfig('link_filter', { words: ['x'] }))).toBe('config.words desteklenmiyor');
    expect(err(normalizeAutomodConfig('caps_lock', { maxMentions: 3 }))).toBe('config.maxMentions desteklenmiyor');
    expect(err(normalizeAutomodConfig('blocked_words', { minRepeat: 5 }))).toBe('config.minRepeat desteklenmiyor');
  });

  it('varsayılanlar açık ve güvenlidir', () => {
    expect(ok(normalizeAutomodConfig('link_filter', {}))).toEqual({
      action: 'delete', timeoutMs: 60_000, logChannelId: null, exemptRoles: [],
    });
  });

  it.each(['delete', 'timeout', 'delete_and_timeout'] as const)('%s eylemi kabul edilir', (action) => {
    expect(ok(normalizeAutomodConfig('link_filter', { action })).action).toBe(action);
  });

  it.each([['ban'], [null], [1], [['delete']]])('geçersiz eylem reddedilir: %j', (action) => {
    expect(err(normalizeAutomodConfig('link_filter', { action }))).toBe('config.action geçersiz');
  });

  it.each([
    ['metin', '60000'],
    ['kesirli', 60_000.5],
    ['alt sınır altında', 59_999],
    ['üst sınır üstünde', 7 * 24 * 60 * 60 * 1000 + 1],
    ['güvenli olmayan tam sayı', Number.MAX_SAFE_INTEGER + 2],
    ['null', null],
  ])('timeoutMs %s reddedilir', (_label, timeoutMs) => {
    expect(err(normalizeAutomodConfig('link_filter', { timeoutMs })))
      .toBe('config.timeoutMs 60000 ile 604800000 arasında güvenli bir tam sayı olmalı');
  });

  it('sınır değerlerdeki timeoutMs kabul edilir', () => {
    expect(ok(normalizeAutomodConfig('link_filter', { timeoutMs: 60_000 })).timeoutMs).toBe(60_000);
    expect(ok(normalizeAutomodConfig('link_filter', { timeoutMs: 604_800_000 })).timeoutMs).toBe(604_800_000);
  });

  it('logChannelId null ile temizlenebilir, kimlik KIRPILIR', () => {
    expect(ok(normalizeAutomodConfig('link_filter', { logChannelId: null })).logChannelId).toBeNull();
    expect(ok(normalizeAutomodConfig('link_filter', { logChannelId: '  ch-1  ' })).logChannelId).toBe('ch-1');
  });

  it.each([
    ['sayı', 42],
    ['boş', '   '],
    ['çok uzun', 'c'.repeat(129)],
    ['nesne', {}],
  ])('logChannelId %s reddedilir', (_label, logChannelId) => {
    expect(err(normalizeAutomodConfig('link_filter', { logChannelId })))
      .toBe('config.logChannelId null veya geçerli bir kimlik olmalı');
  });

  it.each([
    ['dizi değil', 'r1'],
    ['10 rolden fazla', Array.from({ length: 11 }, (_, i) => `r${i}`)],
  ])('exemptRoles %s reddedilir', (_label, exemptRoles) => {
    expect(err(normalizeAutomodConfig('link_filter', { exemptRoles })))
      .toBe('config.exemptRoles en fazla 10 rol kimliği içeren bir dizi olmalı');
  });

  it.each([
    ['boş kimlik', ['  ']],
    ['sayı', [1]],
    ['null', [null]],
    ['HERKES', ['__everyone__']],
  ])('exemptRoles %s reddedilir — kural sessizce kapanamaz', (_label, exemptRoles) => {
    expect(err(normalizeAutomodConfig('link_filter', { exemptRoles })))
      .toBe('config.exemptRoles geçersiz rol kimliği içeriyor');
  });

  it('exemptRoles TEKİLLEŞTİRİLİR', () => {
    expect(ok(normalizeAutomodConfig('link_filter', { exemptRoles: ['r1', ' r1 ', 'r2'] })).exemptRoles)
      .toEqual(['r1', 'r2']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('normalizeAutomodConfig — türe özgü alanlar', () => {
  it.each([
    ['dizi değil', 'kelime'],
    ['boş dizi', []],
    ['100 kelimeden fazla', Array.from({ length: 101 }, (_, i) => `k${i}`)],
  ])('blocked_words %s reddedilir', (_label, words) => {
    expect(err(normalizeAutomodConfig('blocked_words', { words })))
      .toBe('blocked_words için config.words 1-100 kelime içermeli');
  });

  it('blocked_words yalnız metin kabul eder', () => {
    expect(err(normalizeAutomodConfig('blocked_words', { words: [42] })))
      .toBe('config.words yalnızca string değerler içermeli');
  });

  it.each([
    ['boş kelime', ['  ']],
    ['50 karakterden uzun', ['k'.repeat(51)]],
  ])('blocked_words %s reddedilir', (_label, words) => {
    expect(err(normalizeAutomodConfig('blocked_words', { words })))
      .toBe('config.words içindeki her kelime 1-50 karakter olmalı');
  });

  it('blocked_words küçük harfe çevirir ve tekilleştirir', () => {
    expect(ok(normalizeAutomodConfig('blocked_words', { words: [' Küfür ', 'küfür', 'SPAM'] })).words)
      .toEqual(['küfür', 'spam']);
  });

  it.each([
    ['maxMessages metin', { maxMessages: '5' }, 'config.maxMessages 2-20 arasında tam sayı olmalı'],
    ['maxMessages sınır altı', { maxMessages: 1 }, 'config.maxMessages 2-20 arasında tam sayı olmalı'],
    ['maxMessages sınır üstü', { maxMessages: 21 }, 'config.maxMessages 2-20 arasında tam sayı olmalı'],
    ['windowSecs sınır altı', { windowSecs: 0 }, 'config.windowSecs 1-60 arasında tam sayı olmalı'],
    ['windowSecs sınır üstü', { windowSecs: 61 }, 'config.windowSecs 1-60 arasında tam sayı olmalı'],
  ])('spam_messages %s reddedilir', (_label, input, error) => {
    expect(err(normalizeAutomodConfig('spam_messages', input))).toBe(error);
  });

  it('spam_messages varsayılanları belirlidir', () => {
    expect(ok(normalizeAutomodConfig('spam_messages', {}))).toMatchObject({ maxMessages: 5, windowSecs: 5 });
  });

  it.each([
    ['caps_lock', 'minLength', 3, 'config.minLength 4-50 arasında tam sayı olmalı', 8],
    ['caps_lock', 'minLength', 51, 'config.minLength 4-50 arasında tam sayı olmalı', 8],
    ['mention_spam', 'maxMentions', 1, 'config.maxMentions 2-20 arasında tam sayı olmalı', 5],
    ['mention_spam', 'maxMentions', 21, 'config.maxMentions 2-20 arasında tam sayı olmalı', 5],
    ['repeated_chars', 'minRepeat', 4, 'config.minRepeat 5-30 arasında tam sayı olmalı', 10],
    ['repeated_chars', 'minRepeat', 31, 'config.minRepeat 5-30 arasında tam sayı olmalı', 10],
  ])('%s.%s sınır dışı değeri reddeder ve varsayılanı korur', (type, key, bad, error, fallback) => {
    const ruleType = type as 'caps_lock' | 'mention_spam' | 'repeated_chars';
    expect(err(normalizeAutomodConfig(ruleType, { [key]: bad }))).toBe(error);
    expect(ok(normalizeAutomodConfig(ruleType, {}))).toMatchObject({ [key]: fallback });
  });

  it('invite_filter yalnız genel alanları kabul eder', () => {
    expect(ok(normalizeAutomodConfig('invite_filter', { action: 'timeout' }))).toEqual({
      action: 'timeout', timeoutMs: 60_000, logChannelId: null, exemptRoles: [],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('evaluateAutomodRules — uygulama', () => {
  const increment = jest.fn<Promise<number>, [string, number]>();
  const context = (over: Partial<Parameters<typeof evaluateAutomodRules>[1]> = {}) => ({
    serverId: 'srv-1', userId: 'user-1', content: 'merhaba', memberRoleIds: [], ...over,
  });
  const rule = (over: Partial<AutomodRuleLike> = {}): AutomodRuleLike => ({
    _id: 'rule-1', serverId: 'srv-1', type: 'link_filter', enabled: true, config: {}, ...over,
  });

  beforeEach(() => {
    increment.mockReset();
    increment.mockResolvedValue(1);
  });

  it('kural yoksa hiçbir şey eşleşmez', async () => {
    const decision = await evaluateAutomodRules([], context(), increment);

    expect(decision).toEqual({
      matched: false, matchedRuleIds: [], reasons: [],
      deleteMessage: false, timeoutMs: null, logChannelIds: [],
    });
  });

  it('dizi olmayan kural kümesi çökme değil BOŞ karar üretir', async () => {
    const decision = await evaluateAutomodRules(
      null as unknown as AutomodRuleLike[], context(), increment,
    );
    expect(decision.matched).toBe(false);
  });

  it.each([[false], [0]])('kapalı kural (%j) atlanır', async (enabled) => {
    const decision = await evaluateAutomodRules(
      [rule({ enabled })], context({ content: 'https://x.test' }), increment,
    );
    expect(decision.matched).toBe(false);
  });

  it.each([[true], [1]])('açık kural (%j) uygulanır', async (enabled) => {
    const decision = await evaluateAutomodRules(
      [rule({ enabled })], context({ content: 'https://x.test' }), increment,
    );
    expect(decision.matched).toBe(true);
  });

  it.each([
    ['belirsiz enabled', { enabled: 'true' }, 'Invalid persisted AutoMod enabled state for rule rule-1'],
    ['bilinmeyen tür', { type: 'unknown' }, 'Invalid persisted AutoMod rule type for rule rule-1'],
    ['bozuk JSON config', { config: '{bozuk' }, 'Invalid persisted AutoMod config for rule rule-1'],
    ['dizi config', { config: [1] }, 'Invalid persisted AutoMod config for rule rule-1'],
    ['sayı config', { config: 42 }, 'Invalid persisted AutoMod config for rule rule-1'],
  ])('%s FAIL-CLOSED hata fırlatır', async (_label, over, message) => {
    await expect(evaluateAutomodRules([rule(over)], context(), increment)).rejects.toThrow(message);
  });

  it('kimliksiz bozuk kural da açıkça bildirilir', async () => {
    await expect(evaluateAutomodRules([rule({ _id: undefined, enabled: 'evet' })], context(), increment))
      .rejects.toThrow('Invalid persisted AutoMod enabled state for rule <unknown>');
  });

  it('normalleştirmede reddedilen kalıcı config uygulanmaz, HATA verir', async () => {
    await expect(evaluateAutomodRules(
      [rule({ type: 'blocked_words', config: { words: [] } })], context(), increment,
    )).rejects.toThrow('blocked_words için config.words 1-100 kelime içermeli');
  });

  it('JSON METİN olarak saklanmış config uygulanır', async () => {
    const decision = await evaluateAutomodRules(
      [rule({ config: JSON.stringify({ action: 'timeout', timeoutMs: 120_000 }) })],
      context({ content: 'www.spam.test' }), increment,
    );

    expect(decision).toMatchObject({ matched: true, deleteMessage: false, timeoutMs: 120_000 });
  });

  it('MUAF rol taşıyan üye kuraldan etkilenmez', async () => {
    const decision = await evaluateAutomodRules(
      [rule({ config: { exemptRoles: ['mod'] } })],
      context({ content: 'https://x.test', memberRoleIds: ['uye', 'mod'] }), increment,
    );

    expect(decision.matched).toBe(false);
  });

  it.each([
    ['blocked_words', { words: ['küfür'] }, 'burada KÜFÜR var', 'Yasaklı kelime filtresi'],
    ['link_filter', {}, 'bak: https://kotu.test/a', 'Link filtresi'],
    ['link_filter', {}, 'www.kotu.test', 'Link filtresi'],
    ['invite_filter', {}, 'katıl: bridge.test/invite/abc123', 'Davet linki filtresi'],
    ['caps_lock', { minLength: 8 }, 'BÜYÜK HARFLE BAĞIRIYORUM', 'Aşırı büyük harf kullanımı'],
    ['mention_spam', { maxMentions: 2 }, '@ali @veli @ayse selam', 'Toplu mention filtresi'],
    ['repeated_chars', { minRepeat: 5 }, 'yaaaaaaa', 'Tekrar karakter filtresi'],
  ])('%s içerik kuralı eşleşir', async (type, config, content, reason) => {
    const decision = await evaluateAutomodRules(
      [rule({ type, config })], context({ content }), increment,
    );

    expect(decision.matched).toBe(true);
    expect(decision.reasons).toEqual([reason]);
  });

  it.each([
    ['blocked_words', { words: ['küfür'] }, 'temiz mesaj'],
    ['link_filter', {}, 'bağlantı yok'],
    ['invite_filter', {}, 'davet yok'],
    ['caps_lock', { minLength: 8 }, 'KISA'],
    ['caps_lock', { minLength: 8 }, 'Normal bir cümle yazdım'],
    ['mention_spam', { maxMentions: 5 }, '@ali selam'],
    ['repeated_chars', { minRepeat: 10 }, 'yaaa tamam'],
  ])('%s temiz içerikte eşleşmez', async (type, config, content) => {
    const decision = await evaluateAutomodRules(
      [rule({ type, config })], context({ content }), increment,
    );
    expect(decision.matched).toBe(false);
  });

  it('@everyone ve @here de mention sayılır', async () => {
    const decision = await evaluateAutomodRules(
      [rule({ type: 'mention_spam', config: { maxMentions: 2 } })],
      context({ content: '@everyone @here <@user-9> toplantı' }), increment,
    );
    expect(decision.matched).toBe(true);
  });

  it('mesaj SIKLIĞI sayacı eşik aşılınca eşleşir', async () => {
    increment.mockResolvedValue(6);

    const decision = await evaluateAutomodRules(
      [rule({ type: 'spam_messages', config: { maxMessages: 5, windowSecs: 7 } })],
      context(), increment,
    );

    expect(increment).toHaveBeenCalledWith('automod:spam:srv-1:rule-1:user-1', 7);
    expect(decision.reasons).toEqual(['Mesaj sıklığı filtresi']);
  });

  it('eşiğin altındaki sıklık eşleşmez', async () => {
    increment.mockResolvedValue(3);

    const decision = await evaluateAutomodRules(
      [rule({ type: 'spam_messages', config: {} })], context(), increment,
    );

    expect(decision.matched).toBe(false);
  });

  it('DÜZENLEME sıklık sayacını TÜKETMEZ', async () => {
    const decision = await evaluateAutomodRules(
      [rule({ type: 'spam_messages', config: {} })],
      context({ event: 'edit' }), increment,
    );

    expect(increment).not.toHaveBeenCalled();
    expect(decision.matched).toBe(false);
  });

  it('kimliksiz kural için sayaç anahtarı TÜR adına düşer', async () => {
    increment.mockResolvedValue(99);

    await evaluateAutomodRules(
      [rule({ _id: 42, type: 'spam_messages', config: {} })], context(), increment,
    );

    expect(increment).toHaveBeenCalledWith('automod:spam:srv-1:spam_messages:user-1', 5);
  });

  it('aynı gerekçeyi üreten iki kural TEKRARLANMAZ, en uzun timeout kazanır', async () => {
    const decision = await evaluateAutomodRules([
      rule({ _id: 'r1', type: 'link_filter', config: { action: 'timeout', timeoutMs: 60_000, logChannelId: 'log-1' } }),
      rule({ _id: 'r1', type: 'link_filter', config: { action: 'delete_and_timeout', timeoutMs: 300_000, logChannelId: 'log-1' } }),
      rule({ _id: 'r2', type: 'link_filter', config: { action: 'timeout', timeoutMs: 120_000, logChannelId: 'log-2' } }),
    ], context({ content: 'https://x.test' }), increment);

    expect(decision.matchedRuleIds).toEqual(['r1', 'r2']);
    expect(decision.reasons).toEqual(['Link filtresi']);
    expect(decision.deleteMessage).toBe(true);
    expect(decision.timeoutMs).toBe(300_000);
    expect(decision.logChannelIds).toEqual(['log-1', 'log-2']);
  });

  it('yalnız silme eylemi timeout üretmez', async () => {
    const decision = await evaluateAutomodRules(
      [rule({ config: { action: 'delete' } })], context({ content: 'https://x.test' }), increment,
    );

    expect(decision).toMatchObject({ deleteMessage: true, timeoutMs: null, logChannelIds: [] });
  });
});
