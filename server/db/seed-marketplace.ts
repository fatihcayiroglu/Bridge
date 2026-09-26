// server/db/seed-marketplace.ts
// Optional idempotent seed for the *marketplace catalog*.
//
// Historical code accidentally wrote marketplace-shaped rows into the server
// bot credential table (`bots`). That table intentionally requires serverId,
// ownerId, username and tokenHash, and has no slug/name/author fields. The seed
// therefore could never work on real PostgreSQL. Keep the two product domains
// separate: server bot credentials use BotRepository; public catalog entries use
// BotMarketplaceRepository.

import { BotMarketplace } from './repositories/BotMarketplaceRepository';
import logger from '../lib/logger';

type ExampleBot = {
  id: string; name: string; description: string; longDescription: string;
  author: string; authorVerified: boolean; avatar: string; category: string;
  tags: string[]; commands: string[]; permissions: string[]; changelog: string;
  supportUrl: string; sourceUrl: string; verified: boolean; featured: boolean;
};

// Final21 Phase 14: examples may only claim what a Bridge bot can do — receive the
// slash commands users invoke and reply to them (lib/botScopes.ts). Music, moderation
// and welcome/role examples described actions no bot can perform and were removed;
// no example claims verification or links to a repository the project does not control.
// Migration 073 applies the same correction to rows an earlier seed already created.
const EXAMPLE_BOTS: readonly ExampleBot[] = [
  { id:'bridgebot', name:'BridgeBot', description:'Bridge yardımcı botu örneği: komut rehberi ve SSS yanıtları.', longDescription:'Kullanıcının çağırdığı komutlara yanıt veren örnek yardımcı bot.', author:'Bridge Team', authorVerified:false, avatar:'🤖', category:'utility', tags:['yardımcı','komut'], commands:['help'], permissions:['commands','messages:reply'], changelog:'Built-in example', supportUrl:'#', sourceUrl:'#', verified:false, featured:false },
  { id:'pollbot', name:'PollBot', description:'Anket ve oylama botu örneği.', longDescription:'Komutla başlatılan anketlere yanıt veren örnek bot.', author:'Bridge Community', authorVerified:false, avatar:'📊', category:'management', tags:['anket','topluluk','oylama'], commands:['poll'], permissions:['commands','messages:reply'], changelog:'Built-in example', supportUrl:'#', sourceUrl:'#', verified:false, featured:false },
];

export async function seedMarketplace(): Promise<number> {
  let seeded = 0;
  for (const bot of EXAMPLE_BOTS) {
    const exists = await BotMarketplace.findById(bot.id);
    if (exists) continue;
    const now = Date.now();
    try {
      const inserted = await BotMarketplace.submit({
        id: bot.id, name: bot.name, author: bot.author, authorVerified: bot.authorVerified,
        avatar: bot.avatar, category: bot.category, tags: [...bot.tags], description: bot.description,
        longDescription: bot.longDescription, commands: [...bot.commands], permissions: [...bot.permissions],
        changelog: bot.changelog, supportUrl: bot.supportUrl, sourceUrl: bot.sourceUrl,
        submittedBy: null, createdAt: now, updatedAt: now,
      });
      if (!inserted) continue;
      await BotMarketplace.update(bot.id, {
        approved: true, verified: bot.verified, featured: bot.featured,
        authorVerified: bot.authorVerified,
      });
      seeded++;
    } catch (err) {
      // Concurrent seeders may both observe "missing". A unique conflict means
      // another process won the idempotent seed race; other errors are real.
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  if (seeded > 0) logger.info({ event:'db.seed.marketplace.completed', count:seeded }, `Bot marketplace: ${seeded} örnek bot eklendi.`);
  return seeded;
}

export { EXAMPLE_BOTS };
export default seedMarketplace;
