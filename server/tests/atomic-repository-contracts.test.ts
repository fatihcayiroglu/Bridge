/**
 * PostgreSQL atomic-owner contract tests.
 *
 * These tests intentionally drive the production transaction methods with a
 * mocked Pool client. They prove SQL/branch/transaction ownership, NOT real
 * PostgreSQL locking/concurrency semantics. Real-PG verification remains a
 * separate required gate.
 */
process.env.NODE_ENV = 'test';

import db from '../db/loader';
// `_pool` mock'ta ARTIK varsayılan değildir (bkz. helpers/mockDb.ts). Bu süit
// SQL/işlem sahipliğini ölçtüğü için havuz stub'unu AÇIKÇA ister — niyet
// dosyada görünür olsun diye.
import { attachPgPoolStub } from './helpers/mockDb';
attachPgPoolStub(db as unknown as import('./helpers/mockDb').MockDb);
import PollRepository from '../db/repositories/PollRepository';
import InviteRepository from '../db/repositories/InviteRepository';
import DmRepository from '../db/repositories/DmRepository';
import ServerRepository from '../db/repositories/ServerRepository';
// AuthRepository keeps CommonJS compatibility; require returns the singleton.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuthRepository = require('../db/repositories/AuthRepository');

type QueryResult = { rows?: Array<Record<string, unknown>>; rowCount?: number };

function pgClient(handler: (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>) {
  return {
    query: jest.fn((sql: string, params?: unknown[]) => Promise.resolve(handler(sql, params))),
    release: jest.fn(),
  };
}

describe('atomic PostgreSQL repository owners — mocked SQL contract only', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const pool = (db as unknown as { _pool: { connect: jest.Mock } })._pool;

  beforeEach(() => {
    // Production methods intentionally bypass the in-memory compatibility path
    // only outside NODE_ENV=test. The DB object remains the isolated Jest mock;
    // only its Pool client is driven here.
    process.env.NODE_ENV = 'production';
    pool.connect.mockReset();
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('DmRepository.markReadWithReceipt', () => {
    it('locks the DM row and preserves the other participant read cursor', async () => {
      const client = pgClient((sql, params) => {
        if (/SELECT participants, "readAt" FROM dm_conversations/.test(sql)) {
          return { rows: [{ participants: ['ua', 'ub'], readAt: { ub: 123 } }] };
        }
        if (/UPDATE dm_conversations SET "readAt"/.test(sql)) {
          const next = JSON.parse(String(params?.[1] ?? '{}'));
          expect(next.ub).toBe(123);
          expect(Number(next.ua)).toBeGreaterThan(0);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      });
      pool.connect.mockResolvedValue(client);

      const out = await DmRepository.markReadWithReceipt('ua_ub', 'ua');

      expect(out?.participants).toEqual(['ua', 'ub']);
      expect(out?.readAt).toBeGreaterThan(0);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/SELECT participants, "readAt" FROM dm_conversations WHERE _id = \$1 FOR UPDATE/),
        ['ua_ub'],
      );
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-participant before writing and rolls back', async () => {
      const client = pgClient((sql) => /SELECT participants, "readAt" FROM dm_conversations/.test(sql)
        ? { rows: [{ participants: ['uc', 'ud'], readAt: {} }] }
        : { rows: [] });
      pool.connect.mockResolvedValue(client);

      const out = await DmRepository.markReadWithReceipt('uc_ud', 'ua');

      expect(out).toBeNull();
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /UPDATE dm_conversations SET "readAt"/.test(String(sql)))).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('PollRepository.mutateVoteAtomic', () => {
    it('locks the poll row and commits a successful single-choice vote', async () => {
      const poll = {
        _id: 'poll-1', channelId: 'ch-1', serverId: 'srv-1', createdBy: 'owner',
        question: 'Q?', multiSelect: false, allowVoteChange: true, closed: false,
        options: [
          { id: 'a', text: 'A', votes: [] },
          { id: 'b', text: 'B', votes: ['other'] },
        ],
      };
      const client = pgClient((sql, params) => {
        if (/SELECT \* FROM polls/.test(sql)) return { rows: [poll] };
        if (/UPDATE polls SET options/.test(sql)) {
          const options = JSON.parse(String(params?.[1] ?? '[]'));
          return { rows: [{ ...poll, options }] };
        }
        return { rows: [] };
      });
      pool.connect.mockResolvedValue(client);

      const out = await PollRepository.mutateVoteAtomic('poll-1', 'user-1', ['a'], 'toggle');

      expect(out?.status).toBe('ok');
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/SELECT \* FROM polls WHERE _id = \$1 FOR UPDATE/),
        ['poll-1'],
      );
      const updateCall = client.query.mock.calls.find(([sql]) => /UPDATE polls SET options/.test(String(sql)));
      expect(updateCall).toBeTruthy();
      expect(JSON.parse(String(updateCall?.[1]?.[1]))[0].votes).toContain('user-1');
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('allowVoteChange=false iken farklı oy değişikliğini lock altında reddeder', async () => {
      const poll = {
        _id: 'poll-1', channelId: 'ch-1', serverId: 'srv-1', createdBy: 'owner',
        question: 'Q?', multiSelect: false, allowVoteChange: false, closed: false,
        options: [
          { id: 'a', text: 'A', votes: ['user-1'] },
          { id: 'b', text: 'B', votes: [] },
        ],
      };
      const client = pgClient((sql) => /SELECT \* FROM polls/.test(sql) ? { rows: [poll] } : { rows: [] });
      pool.connect.mockResolvedValue(client);

      const out = await PollRepository.mutateVoteAtomic('poll-1', 'user-1', ['b'], 'toggle');

      expect(out).toEqual({ status: 'vote_change_forbidden' });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /UPDATE polls SET options/.test(String(sql)))).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });


    it.each([
      ['not found', null, ['a'], 'toggle', 'not_found'],
      ['closed', { closed: true, options: [] }, ['a'], 'toggle', 'closed'],
      ['invalid persisted expiry', { closed: false, expiresAt: 'not-a-time', options: [] }, ['a'], 'toggle', 'expired'],
      ['expired', { closed: false, expiresAt: 1, options: [] }, ['a'], 'toggle', 'expired'],
      ['exact expiry string', { closed: false, expiresAt: String(Date.now()), options: [] }, ['a'], 'toggle', 'expired'],
      ['single choice', { closed: false, multiSelect: false, options: [{id:'a',text:'A',votes:[]},{id:'b',text:'B',votes:[]}] }, ['a','b'], 'toggle', 'single_choice'],
      ['invalid option', { closed: false, multiSelect: true, options: [{id:'a',text:'A',votes:[]}] }, ['missing'], 'toggle', 'invalid_option'],
    ])('%s exits under the row lock without mutation', async (_name, patch, requested, mode, status) => {
      const base = { _id:'poll-1', channelId:'ch-1', serverId:'srv-1', createdBy:'owner', question:'Q?', multiSelect:false, allowVoteChange:true, closed:false, options:[{id:'a',text:'A',votes:[]}] };
      const client = pgClient((sql) => /SELECT \* FROM polls/.test(sql) ? { rows: patch === null ? [] : [{...base, ...patch}] } : { rows: [] });
      pool.connect.mockResolvedValue(client);
      await expect(PollRepository.mutateVoteAtomic('poll-1','u1',requested as string[],mode as 'toggle'|'remove')).resolves.toEqual({status});
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /UPDATE polls SET options/.test(String(sql)))).toBe(false);
    });

    it('rejects an empty toggle before acquiring a database connection', async () => {
      await expect(PollRepository.mutateVoteAtomic('poll-1', 'u1', [], 'toggle'))
        .resolves.toEqual({ status: 'invalid_option' });
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('idempotent replay is accepted when vote changes are disabled', async () => {
      const poll = { _id:'poll-1',channelId:'c',serverId:'s',createdBy:'o',question:'Q',multiSelect:false,allowVoteChange:false,closed:false,options:[{id:'a',text:'A',votes:['u1']}] };
      const client=pgClient(sql=>/SELECT \* FROM polls/.test(sql)?{rows:[poll]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      const out=await PollRepository.mutateVoteAtomic('poll-1','u1',['a'],'toggle');
      expect(out).toEqual({status:'ok',poll}); expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.query.mock.calls.some(([sql])=>/UPDATE polls SET options/.test(String(sql)))).toBe(false);
    });

    it('remove is forbidden when vote changes are disabled even before a vote exists', async () => {
      const poll={_id:'poll-1',channelId:'c',serverId:'s',createdBy:'o',question:'Q',multiSelect:true,allowVoteChange:false,closed:false,options:[{id:'a',text:'A',votes:[]}]};
      const client=pgClient(sql=>/SELECT \* FROM polls/.test(sql)?{rows:[poll]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      await expect(PollRepository.mutateVoteAtomic('poll-1','u1',[],'remove')).resolves.toEqual({status:'vote_change_forbidden'});
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('multi-select toggle and remove mutate only the caller vote', async () => {
      const makePoll=()=>({_id:'poll-1',channelId:'c',serverId:'s',createdBy:'o',question:'Q',multiSelect:true,allowVoteChange:true,closed:false,options:[{id:'a',text:'A',votes:['other']},{id:'b',text:'B',votes:['u1']}]});
      let poll=makePoll();
      let client=pgClient((sql,params)=>/SELECT \* FROM polls/.test(sql)?{rows:[poll]}:/UPDATE polls SET options/.test(sql)?{rows:[{...poll,options:JSON.parse(String(params?.[1]))}]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      const toggled=await PollRepository.mutateVoteAtomic('poll-1','u1',['a','b'],'toggle');
      expect(toggled?.status).toBe('ok'); if(toggled?.status==='ok'){expect(toggled.poll.options[0].votes).toEqual(['other','u1']); expect(toggled.poll.options[1].votes).toEqual([]);}
      poll=makePoll(); client=pgClient((sql,params)=>/SELECT \* FROM polls/.test(sql)?{rows:[poll]}:/UPDATE polls SET options/.test(sql)?{rows:[{...poll,options:JSON.parse(String(params?.[1]))}]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      const removed=await PollRepository.mutateVoteAtomic('poll-1','u1',[],'remove');
      expect(removed?.status).toBe('ok'); if(removed?.status==='ok'){expect(removed.poll.options[0].votes).toEqual(['other']); expect(removed.poll.options[1].votes).toEqual([]);}
    });

    it('database failure rolls back and preserves the original error', async () => {
      const original=new Error('poll select failed');
      const client=pgClient(sql=>{if(sql==='BEGIN')return {rows:[]}; if(/SELECT \* FROM polls/.test(sql)) throw original; if(sql==='ROLLBACK') throw new Error('rollback failed'); return {rows:[]};}); pool.connect.mockResolvedValue(client);
      await expect(PollRepository.mutateVoteAtomic('poll-1','u1',['a'],'toggle')).rejects.toBe(original);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('PollRepository.updateEditableAtomic', () => {
    it('optionlarda mevcut oy varsa options editini lock altında reddeder', async () => {
      const poll = {
        _id: 'poll-1', channelId: 'ch-1', serverId: 'srv-1', createdBy: 'owner', question: 'Q?',
        options: [{ id: 'a', text: 'A', votes: ['u1'] }],
      };
      const client = pgClient((sql) => /SELECT \* FROM polls/.test(sql) ? { rows: [poll] } : { rows: [] });
      pool.connect.mockResolvedValue(client);

      const out = await PollRepository.updateEditableAtomic(
        'poll-1',
        { options: [{ id: 'a', text: 'Changed', votes: [] }] },
        true,
      );

      expect(out).toEqual({ status: 'has_votes' });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalledTimes(1);
    });


    it.each([
      ['missing', [], {}, false, 'not_found'],
      ['closed', [{_id:'poll-1',closed:true,options:[]}], {question:'x'}, false, 'closed'],
    ])('%s edit exits without dynamic update', async (_name, rows, fields, changing, status) => {
      const client=pgClient(sql=>/SELECT \* FROM polls/.test(sql)?{rows:rows as any[]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      await expect(PollRepository.updateEditableAtomic('poll-1',fields as Record<string,unknown>,changing as boolean)).resolves.toEqual({status});
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('empty edit is an idempotent commit and supported fields use parameterized SQL', async () => {
      const poll={_id:'poll-1',channelId:'c',serverId:'s',createdBy:'o',question:'Q',options:[{id:'a',text:'A',votes:[]}]};
      let client=pgClient(sql=>/SELECT \* FROM polls/.test(sql)?{rows:[poll]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      await expect(PollRepository.updateEditableAtomic('poll-1',{},false)).resolves.toEqual({status:'ok',poll}); expect(client.query).toHaveBeenCalledWith('COMMIT');
      client=pgClient((sql,params)=>/SELECT \* FROM polls/.test(sql)?{rows:[poll]}:/UPDATE polls SET/.test(sql)?{rows:[{...poll,question:params?.[1],options:JSON.parse(String(params?.[2]))}]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      const out=await PollRepository.updateEditableAtomic('poll-1',{question:'New',options:[{id:'a',text:'AA',votes:[]}]},true);
      expect(out?.status).toBe('ok'); expect(client.query.mock.calls.some(([sql])=>/"question" = \$2/.test(String(sql))&&/"options" = \$3::jsonb/.test(String(sql)))).toBe(true);
    });

    it('unsupported edit field rolls back instead of interpolating attacker-controlled column names', async () => {
      const poll={_id:'poll-1',channelId:'c',serverId:'s',createdBy:'o',question:'Q',options:[]};
      const client=pgClient(sql=>/SELECT \* FROM polls/.test(sql)?{rows:[poll]}:{rows:[]}); pool.connect.mockResolvedValue(client);
      await expect(PollRepository.updateEditableAtomic('poll-1',{createdBy:'attacker'},false)).rejects.toThrow('Unsupported poll edit field');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK'); expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('AuthRepository.rotateRefreshTokenAtomic', () => {
    const input = {
      oldTokenHash: 'old-hash', newTokenHash: 'new-hash', newFamily: 'family-new',
      now: 1_000, expiresAt: 9_000,
    };

    it('row lock altında eski tokenı used yapar ve aynı family ile yenisini ekler', async () => {
      const client = pgClient((sql) => {
        if (/FROM refresh_tokens/.test(sql) && /FOR UPDATE/.test(sql)) {
          return { rows: [{ token: 'old-hash', userId: 'u1', expiresAt: 8_000, used: false, family: 'family-existing', tokenVersion: 3 }] };
        }
        if (/SELECT \* FROM users/.test(sql)) return { rows: [{ _id: 'u1', tokenVersion: 3 }] };
        return { rows: [] };
      });
      pool.connect.mockResolvedValue(client);

      const out = await AuthRepository.rotateRefreshTokenAtomic(input);

      expect(out).toEqual({ status: 'ok', user: { _id: 'u1', tokenVersion: 3 } });
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/FROM refresh_tokens[\s\S]*FOR UPDATE/),
        ['old-hash'],
      );
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE refresh_tokens[\s\S]*used = TRUE/),
        ['old-hash', 1_000, 'family-existing'],
      );
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO refresh_tokens/),
        ['new-hash', 'u1', 9_000, 1_000, 'family-existing', 3],
      );
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('tokenVersion değişmiş stale refresh ailesini revoke eder', async () => {
      const client = pgClient((sql) => {
        if (/FROM refresh_tokens/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [{ token: 'old-hash', userId: 'u1', expiresAt: 8_000, used: false, family: 'family-existing', tokenVersion: 2 }] };
        if (/SELECT \* FROM users/.test(sql)) return { rows: [{ _id: 'u1', tokenVersion: 3 }] };
        return { rows: [] };
      });
      pool.connect.mockResolvedValue(client);
      await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({ status: 'revoked' });
      expect(client.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE family = $1', ['family-existing']);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
    });

    it('used token replayinde family zincirini siler ve reuse döndürür', async () => {
      const client = pgClient((sql) => {
        if (/FROM refresh_tokens/.test(sql) && /FOR UPDATE/.test(sql)) {
          return { rows: [{ token: 'old-hash', userId: 'u1', expiresAt: 8_000, used: true, family: 'family-existing', tokenVersion: 3 }] };
        }
        return { rows: [] };
      });
      pool.connect.mockResolvedValue(client);

      const out = await AuthRepository.rotateRefreshTokenAtomic(input);

      expect(out).toEqual({ status: 'reuse' });
      expect(client.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE family = $1', ['family-existing']);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });
  describe('ServerRepository.createWithDefaultsAtomic', () => {
    const input = {
      serverId: 'srv-new', ownerId: 'owner-1', name: 'Atomic', icon: '🌐',
      textChannelId: 'c-text', voiceChannelId: 'c-voice', createdAt: 1_700_000_000_000,
      maxOwnedServers: 2,
    };

    it('serializes the owner limit and commits server + channels + membership together', async () => {
      const client = pgClient((sql) => {
        if (/COUNT\(\*\).*FROM servers/.test(sql)) return { rows: [{ count: '1' }] };
        if (/INSERT INTO servers/.test(sql)) return { rows: [{ _id: input.serverId, ownerId: input.ownerId, name: input.name }] };
        return { rows: [], rowCount: 1 };
      });
      pool.connect.mockResolvedValue(client);

      const out = await ServerRepository.createWithDefaultsAtomic(input);

      expect(out.status).toBe('created');
      expect(client.query).toHaveBeenCalledWith('BEGIN');
      expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['server-create:owner-1']);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO channels[\s\S]*\$1,\$3[\s\S]*\$4[\s\S]*\$2,\$3[\s\S]*\$4/),
        [input.textChannelId, input.voiceChannelId, input.serverId, input.createdAt],
      );
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO members/.test(String(sql)))).toBe(true);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.query.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rejects at the concurrency-safe owner limit before inserting anything', async () => {
      const client = pgClient((sql) => /COUNT\(\*\).*FROM servers/.test(sql)
        ? { rows: [{ count: '2' }] }
        : { rows: [], rowCount: 1 });
      pool.connect.mockResolvedValue(client);

      await expect(ServerRepository.createWithDefaultsAtomic(input)).resolves.toEqual({ status: 'limit' });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO servers/.test(String(sql)))).toBe(false);
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO channels/.test(String(sql)))).toBe(false);
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO members/.test(String(sql)))).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back the aggregate when a child insert fails', async () => {
      const client = pgClient((sql) => {
        if (/COUNT\(\*\).*FROM servers/.test(sql)) return { rows: [{ count: '0' }] };
        if (/INSERT INTO servers/.test(sql)) return { rows: [{ _id: input.serverId }] };
        if (/INSERT INTO channels/.test(sql)) throw new Error('channel insert failed');
        return { rows: [], rowCount: 1 };
      });
      pool.connect.mockResolvedValue(client);

      await expect(ServerRepository.createWithDefaultsAtomic(input)).rejects.toThrow('channel insert failed');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO members/.test(String(sql)))).toBe(false);
      expect(client.query.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('ServerRepository.deleteGraphAtomic', () => {
    function serverDeleteClient(failOnMessages = false) {
      const tables = [
        'servers','channels','messages','members','roles','polls','automod_rules',
        'channel_permissions','notification_prefs','saved_messages','bots','bot_ratings',
        'server_bots','outgoing_webhooks','outgoing_webhook_deliveries','server_events',
      ];
      const columns: Record<string, string[]> = {
        channels:['serverId'], messages:['serverId','channelId'], members:['serverId'], roles:['serverId'],
        polls:['serverId','channelId'], automod_rules:['serverId'], channel_permissions:['serverId','channelId'],
        notification_prefs:['channelId'], saved_messages:['destinationType','destinationId'], bots:['serverId'],
        bot_ratings:['botId'], server_bots:['serverId','botId'], outgoing_webhooks:['serverId'],
        outgoing_webhook_deliveries:['serverId'], server_events:['server_id'], servers:['_id'],
      };
      return pgClient((sql) => {
        if (/information_schema\.tables/.test(sql)) return { rows: tables.map(table_name => ({ table_name })) };
        if (/information_schema\.columns/.test(sql)) {
          return { rows: Object.entries(columns).flatMap(([table_name, names]) => names.map(column_name => ({ table_name, column_name }))) };
        }
        if (/SELECT _id, \"ownerId\" FROM servers/.test(sql)) return { rows: [{ _id:'srv-1', ownerId:'owner-1' }] };
        if (/SELECT _id FROM channels/.test(sql)) return { rows: [{ _id:'c1' }] };
        if (/SELECT _id FROM bots/.test(sql)) return { rows: [{ _id:'b1' }] };
        if (failOnMessages && /DELETE FROM "messages"/.test(sql)) throw new Error('delete failed');
        return { rows: [], rowCount: 1 };
      });
    }

    it('locks the tenant and commits its server/channel graph in one transaction', async () => {
      const client = serverDeleteClient();
      pool.connect.mockResolvedValue(client);

      await expect(ServerRepository.deleteGraphAtomic('srv-1', 'owner-1')).resolves.toBe('deleted');

      expect(client.query).toHaveBeenCalledWith('BEGIN');
      expect(client.query).toHaveBeenCalledWith('SELECT _id, \"ownerId\" FROM servers WHERE _id=$1 FOR UPDATE', ['srv-1']);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE FROM notification_prefs/),
        [['c1'], 'server:srv-1'],
      );
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE FROM bot_ratings/),
        [['b1']],
      );
      expect(client.query.mock.calls.some(([sql]) => /DELETE FROM server_bots/.test(String(sql)))).toBe(true);
      const finalDelete = client.query.mock.calls.find(([sql]) => String(sql) === 'DELETE FROM servers WHERE _id=$1');
      expect(finalDelete?.[1]).toEqual(['srv-1']);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.query.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('re-checks owner identity under the row lock before any graph mutation', async () => {
      const client = serverDeleteClient();
      const base = client.query.getMockImplementation()!;
      client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (/SELECT _id, \"ownerId\" FROM servers/.test(sql)) return { rows: [{ _id:'srv-1', ownerId:'new-owner' }] };
        return base(sql, params);
      });
      pool.connect.mockResolvedValue(client);

      await expect(ServerRepository.deleteGraphAtomic('srv-1', 'old-owner')).resolves.toBe('owner_mismatch');

      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /^DELETE FROM/.test(String(sql)))).toBe(false);
      expect(client.query.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back the entire graph when any child delete fails', async () => {
      const client = serverDeleteClient(true);
      pool.connect.mockResolvedValue(client);

      await expect(ServerRepository.deleteGraphAtomic('srv-1', 'owner-1')).rejects.toThrow('delete failed');

      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(false);
      expect(client.query.mock.calls.some(([sql]) => String(sql) === 'DELETE FROM servers WHERE _id=$1')).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('InviteRepository.consumeForMemberAtomic', () => {
    it('locks the invite and consumes exactly one slot with membership in the same transaction', async () => {
      const client = pgClient((sql) => {
        if (/FROM invites/.test(sql) && /FOR UPDATE/.test(sql)) {
          return { rows: [{ _id: 'inv-1', serverId: 'srv-1', expiresAt: 9_000, maxUses: 1, uses: 0 }] };
        }
        if (/INSERT INTO members/.test(sql)) return { rows: [{ userId: 'u1' }] };
        if (/UPDATE invites SET uses = uses \+ 1/.test(sql)) return { rows: [{ uses: 1 }] };
        return { rows: [] };
      });
      pool.connect.mockResolvedValue(client);

      const out = await InviteRepository.consumeForMemberAtomic('inv-1', 'u1', 'srv-1', 1_000);

      expect(out).toEqual({ status: 'ok', uses: 1 });
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/FROM invites WHERE _id = \$1 FOR UPDATE/),
        ['inv-1'],
      );
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO members[\s\S]*ON CONFLICT/),
        ['u1', 'srv-1', 1_000],
      );
      expect(client.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE invites SET uses = uses \+ 1/),
        ['inv-1'],
      );
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['exact expiry', '1000'],
      ['malformed expiry', '1000oops'],
    ])('rejects %s fail-closed before membership insert', async (_name, expiresAt) => {
      const client = pgClient((sql) => /FROM invites/.test(sql) && /FOR UPDATE/.test(sql)
        ? { rows: [{ _id: 'inv-1', serverId: 'srv-1', expiresAt, maxUses: 5, uses: 0 }] }
        : { rows: [] });
      pool.connect.mockResolvedValue(client);
      const out = await InviteRepository.consumeForMemberAtomic('inv-1', 'u1', 'srv-1', 1_000);
      expect(out).toEqual({ status: 'expired' });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO members/.test(String(sql)))).toBe(false);
    });

    it.each([
      ['non-canonical maxUses', '01', 0],
      ['malformed maxUses', 'oops', 0],
      ['non-canonical uses', 5, '01'],
      ['malformed uses', 5, 'oops'],
    ])('treats corrupt persisted quota state as exhausted: %s', async (_name, maxUses, uses) => {
      const client = pgClient((sql) => /FROM invites/.test(sql) && /FOR UPDATE/.test(sql)
        ? { rows: [{ _id: 'inv-1', serverId: 'srv-1', expiresAt: 9_000, maxUses, uses }] }
        : { rows: [] });
      pool.connect.mockResolvedValue(client);

      const out = await InviteRepository.consumeForMemberAtomic('inv-1', 'u1', 'srv-1', 1_000);

      expect(out).toEqual({ status: 'max_uses' });
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO members/.test(String(sql)))).toBe(false);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('rejects a full invite under the row lock before membership insert', async () => {
      const client = pgClient((sql) => /FROM invites/.test(sql) && /FOR UPDATE/.test(sql)
        ? { rows: [{ _id: 'inv-1', serverId: 'srv-1', expiresAt: 9_000, maxUses: 1, uses: 1 }] }
        : { rows: [] });
      pool.connect.mockResolvedValue(client);

      const out = await InviteRepository.consumeForMemberAtomic('inv-1', 'u1', 'srv-1', 1_000);

      expect(out).toEqual({ status: 'max_uses' });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO members/.test(String(sql)))).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('does not burn a use when membership already exists or is banned', async () => {
      for (const banned of [false, true]) {
        const client = pgClient((sql) => {
          if (/FROM invites/.test(sql) && /FOR UPDATE/.test(sql)) {
            return { rows: [{ _id: 'inv-1', serverId: 'srv-1', expiresAt: 9_000, maxUses: 5, uses: 2 }] };
          }
          if (/INSERT INTO members/.test(sql)) return { rows: [] };
          if (/SELECT banned FROM members/.test(sql)) return { rows: [{ banned }] };
          return { rows: [] };
        });
        pool.connect.mockResolvedValue(client);

        const out = await InviteRepository.consumeForMemberAtomic('inv-1', 'u1', 'srv-1', 1_000);
        expect(out).toEqual({ status: banned ? 'banned' : 'already_member' });
        expect(client.query.mock.calls.some(([sql]) => /UPDATE invites SET uses/.test(String(sql)))).toBe(false);
        expect(client.release).toHaveBeenCalledTimes(1);
      }
    });
  });

});
