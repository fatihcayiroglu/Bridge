// client/tests/access-revocation.test.ts — Final21 Phase 16.
//
// The server evicts sockets and emits `membership:revoked` / `channel:access-revoked` /
// `permissions:updated`; before Phase 16 no client code listened, so a removed member kept a
// frozen view of a server or channel they could no longer read. These rules decide what the
// view does; ChannelListManager.svelte applies them.

import { describe, expect, it } from 'vitest';
import { activeChannelSurvives, decideAccessReaction, openChannelExpired } from '../js/core/channel-list/access-revocation.ts';

const onServer = (activeChannelId: string | null = 'c1') => ({ currentServerId: 's1', activeChannelId });
const elsewhere = { currentServerId: 's2', activeChannelId: 'x1' };

describe('membership:revoked', () => {
  it('reloads the server rail and tells the user when they were inside that server', () => {
    expect(decideAccessReaction('membership:revoked', { serverId: 's1' }, onServer())).toEqual({
      reloadServers: true, reloadChannelsOf: null, notice: 'server-access-lost',
    });
  });

  it('still reloads the rail, but does not interrupt, when the user is elsewhere', () => {
    expect(decideAccessReaction('membership:revoked', { serverId: 's1' }, elsewhere)).toEqual({
      reloadServers: true, reloadChannelsOf: null, notice: null,
    });
  });
});

describe('channel:access-revoked', () => {
  it('reloads the channel list and explains when the OPEN channel was the one revoked', () => {
    expect(decideAccessReaction('channel:access-revoked', { serverId: 's1', channelId: 'c1' }, onServer('c1'))).toEqual({
      reloadServers: false, reloadChannelsOf: 's1', notice: 'channel-access-lost',
    });
  });

  it('reloads silently when a channel the user was not reading was revoked', () => {
    expect(decideAccessReaction('channel:access-revoked', { serverId: 's1', channelId: 'c9' }, onServer('c1'))).toEqual({
      reloadServers: false, reloadChannelsOf: 's1', notice: null,
    });
  });

  it('ignores a revocation for a server that is not on screen', () => {
    expect(decideAccessReaction('channel:access-revoked', { serverId: 's1', channelId: 'c1' }, elsewhere)).toEqual({
      reloadServers: false, reloadChannelsOf: null, notice: null,
    });
  });
});

describe('permissions:updated', () => {
  it('reloads the list of the server on screen (channels may appear or disappear), without a notice', () => {
    expect(decideAccessReaction('permissions:updated', { serverId: 's1', channelId: 'c1' }, onServer())).toEqual({
      reloadServers: false, reloadChannelsOf: 's1', notice: null,
    });
  });

  it('does nothing for another server', () => {
    expect(decideAccessReaction('permissions:updated', { serverId: 's1' }, elsewhere).reloadChannelsOf).toBeNull();
  });
});

describe('malformed payloads are ignored, never acted on', () => {
  it.each([null, undefined, 'x', 42, {}, { serverId: 7 }, { serverId: '' }])('%p', (payload) => {
    for (const event of ['membership:revoked', 'channel:access-revoked', 'permissions:updated'] as const) {
      expect(decideAccessReaction(event, payload, onServer())).toEqual({
        reloadServers: false, reloadChannelsOf: null, notice: null,
      });
    }
  });

  it('an empty channelId never matches an empty active channel', () => {
    const reaction = decideAccessReaction('channel:access-revoked', { serverId: 's1', channelId: '' }, onServer(null));
    expect(reaction.notice).toBeNull();
  });
});

describe('activeChannelSurvives — the open channel is released when the authorized list drops it', () => {
  it('keeps a channel that is still listed', () => {
    expect(activeChannelSurvives('c1', ['c0', 'c1'])).toBe(true);
  });

  it('releases a channel that is no longer listed', () => {
    expect(activeChannelSurvives('c1', ['c0', 'c2'])).toBe(false);
  });

  it('releases when the list came back empty', () => {
    expect(activeChannelSurvives('c1', [])).toBe(false);
  });

  it('nothing open means nothing to release', () => {
    expect(activeChannelSurvives(null, [])).toBe(true);
  });
});

describe('channel:expired (P7 D2)', () => {
  it('reloads the list of the server on screen; the payload carries no channel id', () => {
    expect(decideAccessReaction('channel:expired', { serverId: 's1' }, onServer('c1'))).toEqual({
      reloadServers: false, reloadChannelsOf: 's1', notice: null,
    });
  });

  it('does nothing for a server the user is not looking at, or a malformed payload', () => {
    expect(decideAccessReaction('channel:expired', { serverId: 's1' }, elsewhere)).toEqual({
      reloadServers: false, reloadChannelsOf: null, notice: null,
    });
    expect(decideAccessReaction('channel:expired', { serverId: 7 }, onServer('c1')).reloadChannelsOf).toBeNull();
  });

  it('tells the user only when the channel they had open is gone after the reload', () => {
    expect(openChannelExpired('c1', ['c2', 'c3'])).toBe(true);
    expect(openChannelExpired('c1', ['c1', 'c2'])).toBe(false);
    expect(openChannelExpired(null, [])).toBe(false);
    expect(openChannelExpired('', [])).toBe(false);
  });
});

describe('resumeReloadDue (P7 D2 lifecycle)', () => {
  it('needs a server and coalesces near-duplicate lifecycle events', async () => {
    const { resumeReloadDue, RESUME_RELOAD_COALESCE_MS } = await import('../js/core/channel-list/access-revocation.ts');
    expect(resumeReloadDue(null, 0, 10)).toBe(false);
    expect(resumeReloadDue('s1', 0, 10)).toBe(true);
    expect(resumeReloadDue('s1', 1_000, 1_000 + RESUME_RELOAD_COALESCE_MS - 1)).toBe(false);
    expect(resumeReloadDue('s1', 1_000, 1_000 + RESUME_RELOAD_COALESCE_MS)).toBe(true);
  });
});

describe('channels:changed (P7 D2 live list sync)', () => {
  it('reloads the list of the server on screen only, without a notice', () => {
    expect(decideAccessReaction('channels:changed', { serverId: 's1' }, onServer('c1'))).toEqual({
      reloadServers: false, reloadChannelsOf: 's1', notice: null,
    });
    expect(decideAccessReaction('channels:changed', { serverId: 's1' }, elsewhere).reloadChannelsOf).toBeNull();
    expect(decideAccessReaction('channels:changed', {}, onServer('c1')).reloadChannelsOf).toBeNull();
  });
});
