const query = jest.fn();
jest.mock('../db/postgres/pool', () => ({ pool: { query } }));

import { ServerEvents } from '../db/repositories/ServerEventRepository';

beforeEach(() => query.mockReset());

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'e1', server_id: 's1', creator_id: 'u1', title: 'Event', description: null,
  location: null, channel_id: null, starts_at: new Date('2026-09-01T10:00:00Z'),
  ends_at: null, status: 'scheduled', cover_image: null,
  created_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date('2026-08-01T00:00:00Z'),
  ...overrides,
});

describe('ServerEventRepository PostgreSQL contract', () => {
  it.each([
    ['upcoming', true, false],
    ['past', false, true],
    ['all', false, false],
  ] as const)('lists %s events with stable parameter positions and visibility allowlist', async (filter, hasStart, hasEnd) => {
    query
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [row(), row({ id: 'e2' })] });

    const out = await ServerEvents.findByServer('s1', 'u1', filter, 20, 5, ['c1', 'c2']);
    expect(out.total).toBe(2);
    expect(out.events).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(2);

    const countParams = query.mock.calls[0][1];
    const eventParams = query.mock.calls[1][1];
    expect(countParams[0]).toBe('s1');
    expect(countParams[1]).toBe('cancelled');
    expect(countParams[2] instanceof Date).toBe(hasStart);
    expect(countParams[3] instanceof Date).toBe(hasEnd);
    expect(countParams[4]).toEqual(['c1', 'c2']);
    expect(eventParams.slice(0, 5)).toEqual([countParams[0], countParams[1], countParams[2], countParams[3], 'u1']);
    expect(eventParams.slice(5)).toEqual([20, 5, ['c1', 'c2']]);
    expect(query.mock.calls[1][0]).toContain('e.channel_id = ANY($8::text[])');
  });

  it('rejects malformed pagination/filter at repository boundary before SQL', async () => {
    await expect(ServerEvents.findByServer('s1', 'u1', 'bad' as never, 20, 0, [])).rejects.toThrow(/filter/);
    await expect(ServerEvents.findByServer('s1', 'u1', 'all', 0, 0, [])).rejects.toThrow(/limit/);
    await expect(ServerEvents.findByServer('s1', 'u1', 'all', 101, 0, [])).rejects.toThrow(/limit/);
    await expect(ServerEvents.findByServer('s1', 'u1', 'all', 20, -1, [])).rejects.toThrow(/offset/);
    await expect(ServerEvents.findByServer('s1', 'u1', 'all', 20.5, 0, [])).rejects.toThrow(/limit/);
    expect(query).not.toHaveBeenCalled();
  });

  it('normalizes missing count row to zero and referenced channel ids to non-empty strings', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(ServerEvents.findByServer('s1', 'u1', 'all', 20, 0, [])).resolves.toEqual({ events: [], total: 0 });

    query.mockResolvedValueOnce({ rows: [{ channel_id: 'c1' }, { channel_id: '' }, { channel_id: 'c2' }] });
    await expect(ServerEvents.findReferencedChannelIds('s1')).resolves.toEqual(['c1', 'c2']);
    expect(query.mock.calls[2][1]).toEqual(['s1']);
  });

  it('findOne and exists preserve server scoping and return null/false on missing rows', async () => {
    query.mockResolvedValueOnce({ rows: [row()] });
    await expect(ServerEvents.findOne('e1', 's1')).resolves.toMatchObject({ id: 'e1' });
    expect(query.mock.calls[0][1]).toEqual(['e1', 's1']);

    query.mockResolvedValueOnce({ rows: [] });
    await expect(ServerEvents.findOne('missing', 's1')).resolves.toBeNull();
    query.mockResolvedValueOnce({ rows: [{ id: 'e1' }] });
    await expect(ServerEvents.exists('e1', 's1')).resolves.toBe(true);
    query.mockResolvedValueOnce({ rows: [] });
    await expect(ServerEvents.exists('missing', 's1')).resolves.toBe(false);
  });

  it('covers RSVP list/read/upsert/delete/count behavior without fabricating values', async () => {
    const rsvp = { status: 'going', created_at: new Date(), user_id: 'u1', username: 'alice', display_name: 'Alice', avatar: null };
    query.mockResolvedValueOnce({ rows: [rsvp] });
    await expect(ServerEvents.findRsvpList('e1')).resolves.toEqual([rsvp]);
    expect(query.mock.calls[0][0]).toContain('LIMIT 50');

    query.mockResolvedValueOnce({ rows: [{ status: 'interested' }] });
    await expect(ServerEvents.findMyRsvp('e1', 'u1')).resolves.toBe('interested');
    query.mockResolvedValueOnce({ rows: [] });
    await expect(ServerEvents.findMyRsvp('e1', 'u2')).resolves.toBeNull();

    query.mockResolvedValueOnce({ rows: [] });
    await ServerEvents.upsertRsvp('e1', 'u1', 'going');
    expect(query.mock.calls[3][0]).toContain('ON CONFLICT (event_id, user_id)');
    expect(query.mock.calls[3][1]).toEqual(['e1', 'u1', 'going']);

    query.mockResolvedValueOnce({ rows: [] });
    await ServerEvents.deleteRsvp('e1', 'u1');
    expect(query.mock.calls[4][1]).toEqual(['e1', 'u1']);

    query.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    await expect(ServerEvents.countAttendees('e1')).resolves.toBe(7);
    query.mockResolvedValueOnce({ rows: [] });
    await expect(ServerEvents.countAttendees('e1')).resolves.toBe(0);
  });

  it('creates canonical scheduled event and returns PostgreSQL row', async () => {
    const created = row();
    query.mockResolvedValueOnce({ rows: [created] });
    const input = {
      serverId: 's1', creatorId: 'u1', title: 'Event', description: null,
      location: null, channelId: null, startsAt: created.starts_at,
      endsAt: null, coverImage: null,
    };
    await expect(ServerEvents.create(input)).resolves.toEqual(created);
    expect(query.mock.calls[0][0]).toContain("'scheduled'");
    expect(query.mock.calls[0][1]).toEqual(['s1', 'u1', 'Event', null, null, null, created.starts_at, null, null]);
  });

  it('updates only allowlisted fields, scopes by event+server, and handles empty/missing updates', async () => {
    await expect(ServerEvents.update('e1', 's1', { ignored: 'x' })).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();

    const updated = row({ title: 'New', status: 'active' });
    query.mockResolvedValueOnce({ rows: [updated] });
    const starts = new Date('2026-09-02T10:00:00Z');
    await expect(ServerEvents.update('e1', 's1', {
      title: 'New', description: 'd', location: 'l', channelId: 'c1', startsAt: starts,
      endsAt: null, coverImage: 'https://x.example/a.png', status: 'active', ignored: 'drop-me',
    })).resolves.toEqual(updated);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('updated_at = NOW()');
    expect(sql).not.toContain('ignored');
    expect(params.slice(-2)).toEqual(['e1', 's1']);

    query.mockResolvedValueOnce({ rows: [] });
    await expect(ServerEvents.update('missing', 's1', { title: 'x' })).resolves.toBeNull();
  });

  it('deletes only within canonical event/server scope', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await ServerEvents.delete('e1', 's1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id=$1 AND server_id=$2'), ['e1', 's1']);
  });

  it('scans reminder windows with and without cursor using bounded parameterized LIMIT', async () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const end = new Date('2026-09-01T01:00:00Z');
    query.mockResolvedValueOnce({ rows: [row()] });
    await expect(ServerEvents.findScheduledInWindow(start, end, undefined, 100)).resolves.toHaveLength(1);
    expect(query.mock.calls[0][1]).toEqual([start.toISOString(), end.toISOString(), 100]);
    expect(query.mock.calls[0][0]).not.toContain('AND id >');

    query.mockResolvedValueOnce({ rows: [] });
    await ServerEvents.findScheduledInWindow(start, end, 'e1', 25);
    expect(query.mock.calls[1][1]).toEqual([start.toISOString(), end.toISOString(), 'e1', 25]);
    expect(query.mock.calls[1][0]).toContain('AND id > $3');
    expect(query.mock.calls[1][0]).toContain('LIMIT $4');
  });

  it('rejects invalid reminder windows/cursors/limits before reaching PostgreSQL', async () => {
    const valid = new Date('2026-09-01T00:00:00Z');
    const later = new Date('2026-09-01T01:00:00Z');
    await expect(ServerEvents.findScheduledInWindow(new Date('bad'), later)).rejects.toThrow(/valid Date/);
    await expect(ServerEvents.findScheduledInWindow(later, valid)).rejects.toThrow(/must not precede/);
    await expect(ServerEvents.findScheduledInWindow(valid, later, '', 100)).rejects.toThrow(/cursor/);
    await expect(ServerEvents.findScheduledInWindow(valid, later, undefined, 0)).rejects.toThrow(/limit/);
    await expect(ServerEvents.findScheduledInWindow(valid, later, undefined, 1001)).rejects.toThrow(/limit/);
    await expect(ServerEvents.findScheduledInWindow(valid, later, undefined, 1.5)).rejects.toThrow(/limit/);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns reminder attendees and propagates PostgreSQL failures', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'u1' }, { user_id: 'u2' }] });
    await expect(ServerEvents.findAttendees('e1')).resolves.toEqual([{ user_id: 'u1' }, { user_id: 'u2' }]);
    expect(query.mock.calls[0][1]).toEqual(['e1']);

    query.mockRejectedValueOnce(new Error('postgres down'));
    await expect(ServerEvents.findOne('e1', 's1')).rejects.toThrow('postgres down');
  });
});
