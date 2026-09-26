// server/tests/schema-contract-regressions.test.ts
// Faz 10 — GERÇEK PostgreSQL runtime'ının ortaya çıkardığı sözleşme hataları.
//
// Bu süitteki her kusurun ortak sebebi aynı: kod, VAR OLMAYAN bir kolona ya da
// TUTARSIZ bir kimliğe yazıyordu. Mock DB şemasız olduğu ve ilgili repository
// katmanı testlerde mock'landığı için hiçbiri deterministik testlerde
// görünmüyordu; yalnız canlı Postgres'e karşı çalışan iki kullanıcılı runtime
// açığa çıkardı.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { recordOf, numberOf } from './helpers/narrow';
import { createMockDb } from './helpers/mockDb';
import type { MockDb } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import { Social, Dms } from '../db/repositories';
import { requireDoc } from './helpers/mockDb';

// CANLI ŞEMADAN doğrulanmış kolon listeleri. Bir alan buraya eklenecekse
// önce migration ile gerçekten var edilmelidir.
const FRIENDSHIP_COLUMNS = ['_id', 'userId', 'friendId', 'status', 'createdAt'];

beforeEach(() => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
});

describe('friendships — hayalet kolon yazılmaz', () => {
  async function seedPending() {
    await db.friendships.insert({
      _id: 'fr-1', userId: 'user-a', friendId: 'user-b',
      status: 'pending', createdAt: Date.now(),
    });
  }

  it('kabul YALNIZ status alanını değiştirir (acceptedAt YOK)', async () => {
    await seedPending();

    await Social.acceptFriendship('fr-1');

    const row = await requireDoc(db.friendships, { _id: 'fr-1' });
    expect(row.status).toBe('accepted');
    // `acceptedAt` friendships tablosunda YOKTUR; yazılması üretimde
    // "Unknown column name" ile 500 üretiyordu.
    expect(row.acceptedAt).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual([...FRIENDSHIP_COLUMNS].sort());
  });

  it('reddetme YALNIZ status alanını değiştirir (declinedAt YOK)', async () => {
    await seedPending();

    await Social.declineFriendship('fr-1');

    const row = await requireDoc(db.friendships, { _id: 'fr-1' });
    expect(row.status).toBe('declined');
    expect(row.declinedAt).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual([...FRIENDSHIP_COLUMNS].sort());
  });
});

describe('DM kimliği tek kaynaktan üretilir', () => {
  const A = 'user-a', B = 'user-b';

  it('konuşma kimliği alt çizgi biçimindedir', async () => {
    const { dmId } = await Dms.findOrCreateConversation(A, B);

    expect(dmId).toBe([A, B].sort().join('_'));
    expect(dmId).not.toContain(':');
  });

  it('A→B ve B→A AYNI konuşmayı verir', async () => {
    const first  = await Dms.findOrCreateConversation(A, B);
    const second = await Dms.findOrCreateConversation(B, A);

    expect(first.dmId).toBe(second.dmId);
    expect(await db.dmConversations.find({})).toHaveLength(1);
  });

  it('konuşmanın kimliğiyle yazılan mesaj GEÇMİŞTE bulunur', async () => {
    // Üretimdeki hata: mesaj `A:B`, konuşma `A_B` ile kaydediliyordu; mesaj
    // canlı teslim ediliyor ama geçmişte HİÇ görünmüyordu.
    const { dmId } = await Dms.findOrCreateConversation(A, B);

    await Dms.insertMessage({
      dmId, userId: A, displayName: 'A', avatarColor: '#000',
      content: 'merhaba', reactions: {}, e2e: false,
    });

    const history = await Dms.findMessages(dmId, { limit: 50 });
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('merhaba');
  });

  it('iki noktalı kimlikle yazılan mesaj konuşmada GÖRÜNMEZ (regresyon kilidi)', async () => {
    const { dmId } = await Dms.findOrCreateConversation(A, B);
    const wrongId = [A, B].sort().join(':');

    await Dms.insertMessage({
      dmId: wrongId, userId: A, displayName: 'A', avatarColor: '#000',
      content: 'kayip', reactions: {}, e2e: false,
    });

    // Hatalı kimlik kullanılırsa mesaj erişilemez olur — bu yüzden tek
    // kaynak zorunludur.
    expect(await Dms.findMessages(dmId, { limit: 50 })).toHaveLength(0);
  });

  it('okundu imleci sayacı SIFIRLAR', async () => {
    const { dmId } = await Dms.findOrCreateConversation(A, B);
    await Dms.insertMessage({
      dmId, userId: B, displayName: 'B', avatarColor: '#000',
      content: 'selam', reactions: {}, e2e: false,
    });
    expect(await Dms.countUnread(dmId, A)).toBe(1);

    const ok = await Dms.markRead(dmId, A);

    expect(ok).toBe(true);
    const conv = await requireDoc(db.dmConversations, { _id: dmId });
    expect(await Dms.countUnread(dmId, A, numberOf(recordOf(conv.readAt, 'readAt')[A], 'okundu imleci'))).toBe(0);
  });

  it('KATILIMCI OLMAYAN okundu imlecini yazamaz', async () => {
    const { dmId } = await Dms.findOrCreateConversation(A, B);

    const ok = await Dms.markRead(dmId, 'user-yabanci');

    expect(ok).toBe(false);
    const conv = await requireDoc(db.dmConversations, { _id: dmId });
    // DIKKAT: `readAt` HIC OLUSMAMIS olabilir — testin bekledigi sonuc tam da
    // budur (katilimci olmayan hicbir sey yazamaz). Bu yuzden yokluk
    // BOS SOZLUGE indirgenir; `recordOf(conv.readAt, ...)` burada yanlis olurdu.
    expect(recordOf(conv.readAt ?? {}, 'readAt')['user-yabanci']).toBeUndefined();
  });

  it('okundu imleci YALNIZ çağıranın anahtarını değiştirir', async () => {
    const { dmId } = await Dms.findOrCreateConversation(A, B);

    await Dms.markRead(dmId, A);
    await Dms.markRead(dmId, B);
    const conv = await requireDoc(db.dmConversations, { _id: dmId });

    expect(Object.keys(recordOf(conv.readAt, 'readAt')).sort()).toEqual([A, B].sort());
  });

  it('okunmamış sayacı konuşmanın kimliğiyle çalışır', async () => {
    const { dmId } = await Dms.findOrCreateConversation(A, B);
    await Dms.insertMessage({
      dmId, userId: B, displayName: 'B', avatarColor: '#000',
      content: 'selam', reactions: {}, e2e: false,
    });

    expect(await Dms.countUnread(dmId, A)).toBe(1);
    expect(await Dms.countUnread(dmId, B)).toBe(0);   // kendi mesajı sayılmaz
  });
});

describe('Podcast PostgreSQL schema contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema and upgrade migration expose the channel-scoped runtime columns', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const sql = read('db', 'migrations_pg', '032_podcast_channel_schema.sql');

    for (const source of [schema, inline, sql]) {
      expect(source).toContain('podcast_settings');
      expect(source).toContain('podcast_episodes');
      expect(source).toContain('"channelId"');
      expect(source).toContain('"durationSeconds"');
      expect(source).toContain('"createdBy"');
    }
  });

  it('PodcastRepository queries the same channel-scoped identity used by the schema', () => {
    const repository = read('db', 'repositories', 'PodcastRepository.ts');
    expect(repository).toContain('findOne({ channelId })');
    expect(repository).toContain('find({ channelId, published: true })');
  });
});


describe('Bots PostgreSQL schema contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('bot creation writes canonical PostgreSQL owner/name columns, not phantom aliases', () => {
    const route = read('routes', 'bots.ts');
    expect(route).toContain('ownerId: _u.id');
    expect(route).toContain('username: normalizedName');
    expect(route).not.toContain('createdBy: _u.id');
    expect(route).not.toContain('db.bots.findOne({ webhookId })');
  });

  it('fresh bots schema contains the runtime columns added on upgrade', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    for (const col of ['"isPublic"', 'category', 'icon', '"contextCommands"']) {
      expect(schema).toContain(col);
      expect(inline).toContain(col);
    }
  });
});


describe('Runtime PostgreSQL schema closure (migration 034)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema, startup upgrade and numbered migration own every live runtime column', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '034_runtime_schema_contract_closure.sql');
    const contracts: Array<[string, string[]]> = [
      ['users', ['activity', 'activityUpdatedAt', 'ssoProvider', 'ssoId']],
      ['servers', ['featured', 'featuredAt', 'vanityUrl', 'ssoConfig']],
      ['members', ['nickname']],
      ['channels', ['modOnly']],
      ['threads', ['firstMessage', 'tags', 'participantCount', 'pinned', 'locked']],
      ['voice_messages', ['transcript']],
      ['messages', ['transcript', 'webhookId', 'isWebhook', 'flaggedMsgId']],
      ['webhooks', ['token', 'avatarUrl', 'createdBy']],
    ];

    for (const [, columns] of contracts) {
      for (const column of columns) {
        expect(schema).toMatch(new RegExp(`(?:"${column}"|\\b${column}\\b)`));
        expect(inline).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+(?:"${column}"|${column})`));
        expect(numbered).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+(?:"${column}"|${column})`));
      }
    }
  });

  it('routes use canonical storage names rather than creating duplicate aliases', () => {
    const voice = read('routes', 'voicemsg.ts');
    const webhooks = read('routes', 'webhooks.ts');
    const botWebhook = read('routes', 'bots.ts');
    const discover = read('routes', 'discover.ts');

    const vmStart = voice.indexOf('VoiceMessages.insert({');
    const vmEnd = voice.indexOf('});', vmStart);
    const vmInsert = voice.slice(vmStart, vmEnd);
    expect(vmInsert).toContain('url: fileUrl');
    expect(vmInsert).not.toMatch(/\n\s*fileUrl\s*:/);
    const webhookCreateStart = webhooks.indexOf('ChannelWebhooks.create({');
    const webhookCreateEnd = webhooks.indexOf('});', webhookCreateStart);
    const webhookCreate = webhooks.slice(webhookCreateStart, webhookCreateEnd);
    expect(webhookCreateStart).toBeGreaterThan(-1);
    expect(webhookCreate).toMatch(/\bavatarUrl\s*:/);
    expect(webhookCreate).not.toMatch(/^\s*avatar\s*:/m);
    expect(botWebhook).not.toContain('authorId: webhook.createdBy');
    expect(botWebhook).toContain('userId: `webhook:${webhook._id}`');
    expect(discover).toContain('featured: true');
    expect(discover).toContain('featured,');
  });
});


describe('Scheduled dispatch durability schema (migration 035)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema, startup upgrade and numbered migration own lease/failure fields', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '035_scheduled_dispatch_durability.sql');
    for (const column of ['claimOwner', 'claimUntil', 'dispatchAttempts', 'lastError', 'failedAt', 'failureReason']) {
      expect(schema).toMatch(new RegExp(`(?:"${column}"|\\b${column}\\b)`));
      expect(inline).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+(?:"${column}"|${column})`));
      expect(numbered).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+(?:"${column}"|${column})`));
    }
  });

  it('enforces one persisted message per scheduled id in all canonical schema paths', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '035_scheduled_dispatch_durability.sql');
    for (const src of [schema, inline, numbered]) {
      expect(src).toContain('idx_messages_scheduled_id');
      expect(src).toContain('messages("scheduledId")');
    }
  });
});


describe('Server Events canonical schema + privacy contract (migration 036)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('owns server_events and RSVP tables in fresh, startup and numbered migration paths', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '037_server_events_canonical_closure.sql');
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('server_events');
      expect(source).toContain('server_event_rsvp');
      expect(source).toContain('channel_id');
      expect(source).toContain('creator_id');
    }
    expect(schema).toContain('channel_id TEXT REFERENCES channels(_id) ON DELETE CASCADE');
    expect(inline).toContain('server_events_channel_id_fkey');
    expect(numbered).toContain('ON DELETE CASCADE');
  });

  it('filters channel-bound events inside SQL before pagination', () => {
    const repository = read('db', 'repositories', 'ServerEventRepository.ts');
    expect(repository).toContain('e.channel_id IS NULL OR e.channel_id = ANY');
    expect(repository).toContain('findReferencedChannelIds');
  });

  it('does not use legacy member.permissions.MANAGE_EVENTS as an auth owner', () => {
    const route = read('routes', 'serverEvents.ts');
    expect(route).toContain('resolvePermissions');
    expect(route).toContain('PERMS.MANAGE_SERVER');
    expect(route).toContain('PERMS.MANAGE_CHANNELS');
    expect(route).not.toContain('perms.MANAGE_EVENTS');
    expect(route).not.toContain('member.permissions as');
  });
});


describe('Scheduled-message durable dispatch contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema, startup migration and numbered migration all own lease/idempotency columns', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '035_scheduled_dispatch_durability.sql');

    for (const column of ['claimOwner', 'claimUntil', 'dispatchAttempts', 'lastError', 'failedAt', 'failureReason']) {
      expect(schema).toContain(`"${column}"`);
      expect(inline).toContain(`"${column}"`);
      expect(numbered).toContain(`"${column}"`);
    }
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('idx_sched_dispatch_due');
      expect(source).toContain('idx_messages_scheduled_id');
    }
  });

  it('claim path is PostgreSQL-driven whenever a pool exists, including real-PG tests', () => {
    const repository = read('db', 'repositories', 'ScheduledMessageRepository.ts');
    expect(repository).toContain('rawPool?.connect ? rawPool : null');
    expect(repository).toMatch(/if\s*\(pool\)\s*\{/);
    expect(repository).not.toContain("NODE_ENV !== 'test' && pool?.connect");
    expect(repository).toContain('FOR UPDATE SKIP LOCKED');
    expect(repository).toContain('dispatchAttempts');
  });

  it('dispatcher re-checks current membership/channel permissions before persistence and finalizes after create', () => {
    const job = read('jobs', 'scheduledMessages.ts');
    const authorityIndex = job.indexOf('verifyDispatchAuthority(scheduled)');
    const createIndex = job.indexOf('Messages.create({');
    const finalizeIndex = job.indexOf('ScheduledMessages.finalizeSent');
    expect(authorityIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(authorityIndex);
    expect(finalizeIndex).toBeGreaterThan(createIndex);
    expect(job).toContain('PERMS.VIEW_CHANNELS');
    expect(job).toContain('PERMS.SEND_MESSAGES');
    expect(job).toContain('Messages.findByScheduledId(scheduled._id)');
  });
});


describe('Federation durable delivery lease contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema, startup migration and numbered migration own multi-node claim fields', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '038_federation_delivery_claims.sql');
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('ap_delivery_queue');
      expect(source).toContain('"claimOwner"');
      expect(source).toContain('"claimUntil"');
      expect(source).toContain('idx_apqueue_claim_due');
    }
  });

  it('repository claims due rows atomically and workers never use plain findPendingDeliveries', () => {
    const repository = read('db', 'repositories', 'FederationRepository.ts');
    const delivery = read('routes', 'federation', 'delivery.ts');
    expect(repository).toContain('FOR UPDATE SKIP LOCKED');
    expect(repository).toContain('claimPendingDeliveries');
    expect(repository).toContain('{ _id: id, claimOwner }');
    expect(delivery).toContain('Federation.claimPendingDeliveries');
    expect(delivery).not.toContain('Federation.findPendingDeliveries(Date.now())');
    expect(delivery).toContain('releaseDeliveryClaim');
  });
});


describe('Outgoing webhook PostgreSQL boolean/schema contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('clean schema and upgrade path expose runtime delivery-status fields', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '040_outgoing_webhook_schema_closure.sql');
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('outgoing_webhooks');
      expect(source).toContain('"consecutiveFailures"');
      expect(source).toContain('"lastFailedAt"');
      expect(source).toContain('"lastError"');
    }
  });

  it('runtime uses PostgreSQL BOOLEAN values, never integer aliases', () => {
    const repository = read('db', 'repositories', 'OutgoingWebhookRepository.ts');
    const route = read('routes', 'outgoingWebhooks.ts');
    expect(repository).toContain('enabled: true');
    expect(repository).not.toContain('enabled: 1');
    // Input coercion YOKTUR: string `"false"` truthy diye true'ya
    // çevrilemez. Rota yalnız gerçek boolean kabul eder ve DB'ye aynısını yazar.
    expect(route).toContain("typeof body.enabled !== 'boolean'");
    expect(route).toContain('updates.enabled = body.enabled');
    expect(route).not.toContain('Boolean(req.body.enabled)');
    // DB'den okunan değer de yayınlanırken boolean'a normalize edilir.
    expect(route).toMatch(/enabled:\s*!!/);
    expect(route).toContain('enabled: true');
    expect(route).not.toMatch(/enabled:\s*[01]\b/);
  });
});


describe('Scheduled-message cancel/claim race contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('cancelledAt is owned by clean schema, startup migration and numbered migration', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '041_scheduled_cancel_claim_safety.sql');
    for (const source of [schema, inline, numbered]) expect(source).toContain('"cancelledAt"');
    expect(numbered).toContain('idx_sched_dispatch_due');
  });

  it('dispatcher excludes cancelled schedules and cancellation uses row locking', () => {
    const repository = read('db', 'repositories', 'ScheduledMessageRepository.ts');
    expect(repository).toContain('AND "cancelledAt" IS NULL');
    expect(repository).toContain('FOR UPDATE');
    expect(repository).toContain("return 'dispatching'");
    expect(repository).toContain('{ _id: id, claimOwner, sent: false, cancelledAt: null }');
  });
});


describe('Outgoing webhook durable delivery contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('clean schema, startup migration and numbered migration own the durable queue', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '042_outgoing_webhook_durable_delivery.sql');
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('outgoing_webhook_deliveries');
      expect(source).toContain('"claimOwner"');
      expect(source).toContain('"claimUntil"');
      expect(source).toContain('idx_ogwh_delivery_due');
      expect(source).toContain('idx_ogwh_delivery_webhook');
    }
  });

  it('runtime uses a bounded persistent queue with atomic claims and stable delivery ids', () => {
    const repository = read('db', 'repositories', 'OutgoingWebhookRepository.ts');
    const route = read('routes', 'outgoingWebhooks.ts');
    expect(repository).toContain('enqueueDeliveryBounded');
    expect(repository).toContain('FOR UPDATE SKIP LOCKED');
    expect(repository).toContain('pg_advisory_xact_lock');
    expect(route).toContain('enqueueDeliveryBounded');
    expect(route).toContain("'X-Bridge-Delivery': deliveryId");
    expect(route).toContain('DELIVERY_QUEUE_LIMIT_PER_WEBHOOK');
    expect(route).not.toContain('setTimeout(() => fireWithRetry');
  });

  it('all outgoing-webhook enabled writes use PostgreSQL BOOLEAN values', () => {
    const repository = read('db', 'repositories', 'OutgoingWebhookRepository.ts');
    const route = read('routes', 'outgoingWebhooks.ts');
    expect(repository).not.toMatch(/enabled:\s*[01]\b/);
    expect(route).not.toMatch(/enabled:\s*[01]\b/);
    expect(route).toContain('updates.enabled = body.enabled');
    expect(route).not.toContain('Boolean(req.body.enabled)');
  });
});


describe('Notification preferences PostgreSQL/runtime contract', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema, startup upgrade and numbered migration own mute expiry and uniqueness', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '045_notification_prefs_contract.sql');
    const adapter = read('db', 'postgres', 'pgCollection.ts');
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('notification_prefs');
      expect(source).toContain('"muteUntil"');
      expect(source).toContain('idx_notification_prefs_user_channel_unique');
      expect(source).toContain('notification_prefs_level_check');
    }
    expect(adapter).toContain("'muteUntil'");
  });

  it('server preference runtime uses channelId namespace instead of nonexistent server columns', () => {
    const route = read('routes', 'notificationPrefs.ts');
    const repository = read('db', 'repositories', 'NotificationRepository.ts');
    expect(route).toContain('`server:${serverId}`');
    expect(repository).toContain('`server:${serverId}`');
    expect(route).not.toMatch(/isServerLevel\s*:/);
    expect(route).not.toContain('isServerLevel: true');
  });
});


describe('ActivityPub received-message audience + canonical inbox contract (migration 046)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema, inline upgrade, numbered migration and adapter all own visibility', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '046_activitypub_message_visibility.sql');
    const adapter = read('db', 'postgres', 'pgCollection.ts');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS ap_messages');
    expect(schema).toContain('ap_messages_visibility_check');
    expect(schema).toContain('idx_ap_messages_visibility_actor');
    expect(inline).toContain('ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS visibility TEXT');
    expect(numbered).toContain(`WHEN "targetUserId" IS NULL THEN 'public'`);
    expect(numbered).toContain(`ELSE 'direct'`);
    expect(numbered).toContain('SET NOT NULL');
    expect(numbered).toContain('ap_messages_visibility_check');
    expect(adapter).toContain("'visibility'");
  });

  it('legacy helpers module is only a compatibility facade over canonical inbox/delivery owners', () => {
    const helpers = read('routes', 'federation', 'helpers.ts');
    expect(helpers).toContain("from './inbox-handlers'");
    expect(helpers).toContain("from './delivery'");
    expect(helpers).not.toMatch(/async function handleApCreate/);
    expect(helpers).not.toMatch(/async function deliverApActivity/);
  });

  it('production inbox dispatches the canonical create/update/delete/like/announce handlers', () => {
    const route = read('routes', 'federation', 'activitypub.ts');
    for (const type of ['Create', 'Update', 'Delete', 'Like', 'Announce']) {
      expect(route).toContain(`case '${type}':`);
    }
    expect(route).toContain('signer !== claimedActor');
    expect(route).toContain("error: 'HTTP Signature actor mismatch'");
  });

  it('public timeline requires explicit public audience classification', () => {
    const route = read('routes', 'federation', 'social.ts');
    expect(route).toContain("visibility: 'public'");
  });
});


describe('ActivityPub activity journal PostgreSQL/runtime contract (migration 047)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema and both upgrade paths support inbound and outbound journal identities', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '047_activitypub_activity_journal_contract.sql');
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('ap_activities');
      expect(source).toContain('"actorUserId"');
      expect(source).toContain('"activityId"');
      expect(source).toContain('"noteId"');
      expect(source).toContain('"publishedAt"');
      expect(source).toContain('idx_ap_activities_activity_id');
    }
    expect(schema).toContain('"targetUserId" TEXT');
    expect(numbered).toContain('ALTER COLUMN "targetUserId" DROP NOT NULL');
  });

  it('all production ActivityPub activity writers persist createdAt', () => {
    const activitypub = read('routes', 'federation', 'activitypub.ts');
    const delivery = read('routes', 'federation', 'delivery.ts');
    expect(activitypub).toContain('createdAt:   Date.now()');
    expect(delivery).toContain('createdAt:   Date.now()');
  });

  it('inbox journals canonical activity id/type and only marks processed after dispatch', () => {
    const activitypub = read('routes', 'federation', 'activitypub.ts');
    expect(activitypub).toContain("activityId: typeof activity.id === 'string' ? activity.id : null");
    expect(activitypub).toContain('type: String(activity.type)');
    expect(activitypub).toMatch(/\{\s*\$set:\s*\{\s*processed:\s*true,\s*processedAt:\s*Date\.now\(\)\s*\}\s*\}/);
    expect(activitypub).toContain("['Follow', 'Like', 'Announce']");
  });
});


describe('ActivityPub side-effect / fresh-install PostgreSQL closure (049)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema and startup migrations create shipping federation-key and badge stores', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    for (const table of ['server_federation_keys', 'user_badges']) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(inline).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('049 aligns AP Like/Announce/notification runtime columns across fresh, startup and numbered paths', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '049_activitypub_side_effect_idempotency.sql');
    const rollback = read('db', 'migrations_pg', 'rollback', '049_activitypub_side_effect_idempotency.down.sql');
    for (const source of [schema, inline, numbered]) {
      expect(source).toContain('ap_likes');
      expect(source).toContain('ap_announces');
      expect(source).toContain('notifications');
      expect(source).toContain('"activityId"');
    }
    for (const source of [schema, inline, numbered]) expect(source).toContain('"dmId"');
    expect(numbered).toContain('idx_ap_likes_activity_actor_target');
    expect(numbered).toContain('idx_ap_announces_activity_actor_target');
    expect(numbered).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]*idx_ap_(likes|announces)_activity_id/i);
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_ap_likes_activity_actor_target');
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_ap_likes_activity_id');
    expect(rollback).toContain('DROP COLUMN IF EXISTS "dmId"');
  });

  it('PostgreSQL identifier whitelist accepts the notification dmId written by federation', () => {
    const adapter = read('db', 'postgres', 'pgCollection.ts');
    expect(adapter).toMatch(/['"]dmId['"]/);
  });

  it('050 repairs dirty slowmode values before installing the channel constraint', () => {
    const numbered = read('db', 'migrations_pg', '050_channel_settings_contract.sql');
    const inline = read('db', 'postgres', 'migrations.ts');
    for (const source of [numbered, inline]) {
      expect(source).toMatch(/UPDATE\s+channels\s+SET\s+slowmode\s*=\s*0/i);
      expect(source).toMatch(/CHECK\s*\(\s*slowmode\s+IN\s*\(0,5,10,15,30,60,120,300,600,900,1800,3600,7200,21600\)\s*\)/);
    }
  });
});


describe('Security-state schema drift repair (052-054)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('052 revokes unbound historical refresh sessions before making tokenVersion mandatory', () => {
    const numbered = read('db', 'migrations_pg', '052_refresh_token_version_binding.sql');
    const inline = read('db', 'postgres', 'migrations.ts');
    for (const source of [numbered, inline]) {
      const add = source.indexOf('ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER');
      const revoke = source.indexOf('DELETE FROM refresh_tokens WHERE "tokenVersion" IS NULL');
      const mandatory = source.indexOf('ALTER COLUMN "tokenVersion" SET NOT NULL');
      expect(add).toBeGreaterThan(-1);
      expect(revoke).toBeGreaterThan(add);
      expect(mandatory).toBeGreaterThan(revoke);
    }
  });

  it('053 repairs malformed, nullable and default-less server MFA state before enforcing the enum', () => {
    const numbered = read('db', 'migrations_pg', '053_server_mfa_domain.sql');
    const inline = read('db', 'postgres', 'migrations.ts');
    const schema = read('db', 'postgres', 'schema.ts');
    for (const source of [numbered, inline]) {
      expect(source).toMatch(/UPDATE\s+servers\s+SET\s+"mfaLevel"\s*=\s*2[\s\S]*"mfaLevel"\s+IS\s+NULL[\s\S]*NOT\s+IN\s*\(0,\s*1,\s*2\)/i);
      expect(source).toContain('ALTER COLUMN "mfaLevel" SET DEFAULT 0');
      expect(source).toContain('ALTER COLUMN "mfaLevel" SET NOT NULL');
      expect(source).toContain('servers_mfa_level_check');
      expect(source).toContain('CHECK ("mfaLevel" IN (0, 1, 2))');
    }
    expect(schema).toContain('"mfaLevel" INTEGER NOT NULL DEFAULT 0');
    expect(schema).toContain('servers_mfa_level_check CHECK ("mfaLevel" IN (0, 1, 2))');
  });

  it('054 deterministically deduplicates directional bridge pairs before installing a unique pair index', () => {
    const numbered = read('db', 'migrations_pg', '054_channel_bridge_pair_uniqueness.sql');
    const inline = read('db', 'postgres', 'migrations.ts');
    const rollback = read('db', 'migrations_pg', 'rollback', '054_channel_bridge_pair_uniqueness.down.sql');
    for (const source of [numbered, inline]) {
      const dedupe = source.indexOf('DELETE FROM channel_bridges bridge');
      const unique = source.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bridges_pair_unique');
      expect(dedupe).toBeGreaterThan(-1);
      expect(unique).toBeGreaterThan(dedupe);
      expect(source).toContain('PARTITION BY "sourceChannelId", "targetChannelId"');
      expect(source).toContain('ORDER BY "createdAt" DESC NULLS LAST, _id DESC');
      expect(source).toContain('ranked.duplicate_rank > 1');
    }
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_channel_bridges_pair_unique');
  });
});

describe('Authentication security-state rollback contract (057)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('restores the refresh-token version constraint owned by 052 when rolling back 057', () => {
    const migration052 = read('db', 'migrations_pg', '052_refresh_token_version_binding.sql');
    const migration057 = read('db', 'migrations_pg', '057_authentication_security_state.sql');
    const rollback057 = read('db', 'migrations_pg', 'rollback', '057_authentication_security_state.down.sql');

    for (const source of [migration052, migration057]) {
      expect(source).toContain('ADD CONSTRAINT refresh_tokens_token_version_nonnegative');
      expect(source).toContain('CHECK ("tokenVersion" >= 0)');
    }

    expect(rollback057).toMatch(
      /DROP CONSTRAINT IF EXISTS refresh_tokens_token_version_nonnegative[\s\S]*ADD CONSTRAINT refresh_tokens_token_version_nonnegative[\s\S]*CHECK \("tokenVersion" >= 0\)/,
    );
  });
});

describe('E2EE/X3DH PostgreSQL contract (055)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverRoot = path.resolve(__dirname, '..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

  it('fresh schema, startup migration and numbered migration own every public/X3DH key column', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const numbered = read('db', 'migrations_pg', '055_e2ee_x3dh_key_contract.sql');
    const adapter = read('db', 'postgres', 'pgCollection.ts');
    const columns = [
      'e2ePublicKey', 'e2eKeyVersion', 'e2eAlgorithm', 'e2eKeyUpdatedAt',
      'x3dhIdentityKey', 'x3dhSignedPreKey', 'x3dhOneTimePreKeys', 'x3dhUpdatedAt',
    ];
    for (const column of columns) {
      for (const source of [schema, inline, numbered]) expect(source).toContain(`"${column}"`);
      expect(adapter).toContain(`'${column}'`);
    }
    expect(adapter).toMatch(/JSONB_COLS[\s\S]*x3dhSignedPreKey/);
    expect(adapter).toMatch(/JSONB_COLS[\s\S]*x3dhOneTimePreKeys/);
  });

  it('fails closed on ambiguous key-material drift before enforcing constraints', () => {
    const numbered = read('db', 'migrations_pg', '055_e2ee_x3dh_key_contract.sql');
    const inline = read('db', 'postgres', 'migrations.ts');
    for (const source of [numbered, inline]) {
      expect(source).toContain('invalid persisted E2EE/X3DH key state');
      expect(source).toContain('RAISE EXCEPTION');
      expect(source).not.toContain(`SET "e2eKeyVersion" = 1`);
      expect(source).not.toContain(`SET "e2eAlgorithm" = 'X25519'`);
      expect(source).not.toContain(`SET "x3dhOneTimePreKeys" = '[]'::jsonb`);
      expect(source).toContain('users_e2e_key_version_check');
      expect(source).toContain('users_e2e_algorithm_check');
      expect(source).toContain('users_x3dh_otpks_array_check');
    }
  });

  it('has a matching explicit rollback and the runtime consumes OTPKs via the repository atomic owner', () => {
    const rollback = read('db', 'migrations_pg', 'rollback', '055_e2ee_x3dh_key_contract.down.sql');
    const route = read('lib', 'e2e.ts');
    const repository = read('db', 'repositories', 'UserRepository.ts');
    expect(rollback).toContain('DROP CONSTRAINT IF EXISTS users_x3dh_otpks_array_check');
    expect(rollback).not.toMatch(/DROP COLUMN[\s\S]*x3dhOneTimePreKeys/);
    expect(rollback).not.toMatch(/DROP COLUMN[\s\S]*e2ePublicKey/);
    expect(rollback).toMatch(/must[\s\S]*never destroy[\s\S]*key material/i);
    expect(route).toContain('Users.consumeX3dhPreKeyBundle');
    expect(route).not.toMatch(/x3dhOneTimePreKeys:\s*otpks\.slice\(1\)/);
    expect(repository).toContain('FOR UPDATE');
    expect(repository).toMatch(/THEN\s+"x3dhOneTimePreKeys"\s*-\s*0/);
    expect(repository).toContain('SET "x3dhOneTimePreKeys" = c.remaining_keys');
  });
});
