// server/tests/p7-abuse-policy.test.ts
//
// P7 B1 — the shared abuse-policy owner (lib/abusePolicy.ts). Each rule is
// tested for the abusive pattern the lab measured AND for the legitimate
// neighbour it must leave alone. Runs on the single-node window (no Redis);
// the cluster-wide Redis path is exercised by scripts/abuse-lab.

import {
  ABUSE_POLICY,
  checkContentAbuse,
  claimNewDmConversation,
  contentFingerprint,
  distinctMentionCount,
  linkHostsOf,
  mentionNotificationAllowed,
  mentionsWithinLimit,
} from '../lib/abusePolicy';
import { _socketRateStore } from '../socket/socketRateLimit';

const T0 = 1_800_000_000_000;
let seq = 0;
const user = () => `abuse-user-${++seq}`;

beforeAll(() => { delete process.env.REDIS_URL; });

describe('P7 B1 content fingerprint', () => {
  it('folds case, punctuation and links to their host — but never numbers', () => {
    expect(contentFingerprint('FREE Nitro!!  at https://www.Spam.example/claim?id=991'))
      .toBe(contentFingerprint('free nitro at http://spam.example/other/path'));
    // Messages that differ only by a number are different messages (lab LEG-04).
    expect(contentFingerprint('Room 101 is free now')).not.toBe(contentFingerprint('Room 102 is free now'));
    expect(contentFingerprint('see you at 5')).not.toBe(contentFingerprint('see you later'));
  });

  it('a malformed link counts as "a link" without a host, and non-text content is never counted', async () => {
    expect(linkHostsOf('see http://[broken here')).toEqual([]);
    expect(contentFingerprint('see http://[broken here')).toBe('see link here');
    const u = user();
    for (let i = 0; i < ABUSE_POLICY.repeat.max + 2; i++) {
      await expect(checkContentAbuse(u, { text: 'not a string' } as unknown as string, T0 + i)).resolves.toEqual({ allowed: true });
    }
  });

  it('an offline backlog of messages that differ only by a number is never a repeat', async () => {
    const u = user();
    for (let i = 0; i < 10; i++) {
      await expect(checkContentAbuse(u, `typed offline message ${i}`, T0 + i * 1_000)).resolves.toEqual({ allowed: true });
    }
  });

  it('extracts at most five distinct, normalized link hosts', () => {
    expect(linkHostsOf('a https://WWW.Example.com/x b www.example.com/y c http://other.test')).toEqual(['example.com', 'other.test']);
    const many = Array.from({ length: 9 }, (_, i) => `https://h${i}.test`).join(' ');
    expect(linkHostsOf(many)).toHaveLength(5);
    expect(linkHostsOf('no links here, just example.com text and file.txt')).toEqual([]);
    expect(linkHostsOf('claim at spam.example/free-nitro now')).toEqual(['spam.example']);
  });
});

describe('P7 B1 repeated content (lab ATK-02)', () => {
  it('the same text more than max times per window is refused, then allowed again after the window', async () => {
    const u = user();
    const text = 'JOIN NOW → spam.example/free-nitro';
    for (let i = 0; i < ABUSE_POLICY.repeat.max; i++) {
      await expect(checkContentAbuse(u, text, T0 + i * 1_400)).resolves.toEqual({ allowed: true });
    }
    await expect(checkContentAbuse(u, text, T0 + 5_000)).resolves.toEqual({
      allowed: false, reason: 'spam_repeat', retryAfterMs: ABUSE_POLICY.repeat.windowMs,
    });
    await expect(checkContentAbuse(u, text.toUpperCase(), T0 + ABUSE_POLICY.repeat.windowMs + 6_000)).resolves.toEqual({ allowed: true });
  });

  it('short replies repeat freely and different accounts never share a budget', async () => {
    const u = user();
    for (let i = 0; i < 10; i++) await expect(checkContentAbuse(u, 'lol ok', T0 + i)).resolves.toEqual({ allowed: true });
    const text = 'the same long announcement text';
    for (let i = 0; i < ABUSE_POLICY.repeat.max; i++) await checkContentAbuse(u, text, T0 + i);
    await expect(checkContentAbuse(user(), text, T0 + 10)).resolves.toEqual({ allowed: true });
  });
});

describe('P7 B1 repeated link host (lab ATK-03)', () => {
  it('varied spam pointing at one site is refused after max per window', async () => {
    const u = user();
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    for (let i = 0; i < ABUSE_POLICY.linkHost.max; i++) {
      await expect(checkContentAbuse(u, `free nitro ${words[i]} at spam.example/${i}`, T0 + i * 900)).resolves.toEqual({ allowed: true });
    }
    await expect(checkContentAbuse(u, 'totally different words https://spam.example/zzz', T0 + 5_000)).resolves.toMatchObject({
      allowed: false, reason: 'spam_links',
    });
    // Another site is a separate budget.
    await expect(checkContentAbuse(u, 'my blog post https://blog.example/today', T0 + 5_100)).resolves.toEqual({ allowed: true });
  });

  it('links into this Bridge instance (jump links) never count', async () => {
    process.env.INSTANCE_URL = 'https://bridge.example.org';
    try {
      const u = user();
      for (let i = 0; i < ABUSE_POLICY.linkHost.max + 5; i++) {
        await expect(checkContentAbuse(u, `see this ${'x'.repeat(i + 1)} https://bridge.example.org/channels/c/${i}`, T0 + i)).resolves.toEqual({ allowed: true });
      }
    } finally { delete process.env.INSTANCE_URL; }
  });

  it('counter keys hold digests only — no message text, no visited host', async () => {
    const u = user();
    await checkContentAbuse(u, 'a very private sentence with https://private-host.example/path', T0);
    const keys = [..._socketRateStore.keys()].filter(k => k.includes(u)).join(' ');
    expect(keys).toContain('abuse:repeat:');
    expect(keys).toContain('abuse:linkhost:');
    expect(keys).not.toContain('private');
    expect(keys).not.toContain('sentence');
  });
});

describe('P7 B1 mentions (lab ATK-04a/b)', () => {
  it('counts distinct people, not @everyone/@here or repeats', () => {
    expect(distinctMentionCount('<@a> <@a> <@b> @carol @Carol @everyone @here email@example.com')).toBe(3);
  });

  it('a message mentioning more than the limit is refused unless the sender may mention everyone', () => {
    const mass = Array.from({ length: ABUSE_POLICY.mentions.perMessage + 1 }, (_, i) => `<@user${i}>`).join(' ');
    const fine = Array.from({ length: ABUSE_POLICY.mentions.perMessage }, (_, i) => `<@user${i}>`).join(' ');
    expect(mentionsWithinLimit(fine, false)).toBe(true);
    expect(mentionsWithinLimit(mass, false)).toBe(false);
    expect(mentionsWithinLimit(mass, true)).toBe(true);
  });

  it('one sender can ping one person at most N times per window; other targets are unaffected', async () => {
    const sender = user();
    for (let i = 0; i < ABUSE_POLICY.mentions.perTarget; i++) {
      await expect(mentionNotificationAllowed(sender, 'victim', T0 + i * 900)).resolves.toBe(true);
    }
    await expect(mentionNotificationAllowed(sender, 'victim', T0 + 5_000)).resolves.toBe(false);
    await expect(mentionNotificationAllowed(sender, 'someone-else', T0 + 5_000)).resolves.toBe(true);
    await expect(mentionNotificationAllowed(user(), 'victim', T0 + 5_000)).resolves.toBe(true);
    await expect(mentionNotificationAllowed(sender, 'victim', T0 + ABUSE_POLICY.mentions.perTargetWindowMs + 6_000)).resolves.toBe(true);
  });
});

describe('P7 B1 new DM conversations (lab ATK-05)', () => {
  it('opening new conversations is bounded per window with a retry time', async () => {
    const u = user();
    for (let i = 0; i < ABUSE_POLICY.dmNew.max; i++) {
      await expect(claimNewDmConversation(u, T0 + i * 300)).resolves.toEqual({ allowed: true });
    }
    await expect(claimNewDmConversation(u, T0 + 4_000)).resolves.toEqual({ allowed: false, retryAfterMs: ABUSE_POLICY.dmNew.windowMs });
    await expect(claimNewDmConversation(user(), T0 + 4_000)).resolves.toEqual({ allowed: true });
    await expect(claimNewDmConversation(u, T0 + ABUSE_POLICY.dmNew.windowMs + 5_000)).resolves.toEqual({ allowed: true });
  });
});
