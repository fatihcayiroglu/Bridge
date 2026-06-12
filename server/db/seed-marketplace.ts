// server/db/seed-marketplace.ts
// Bot Marketplace için örnek bot kayıtları.
// Bu botlar gerçek üçüncü taraf entegrasyonu olmayan demo/örnek
// botlardır; topluluktan gerçek bot PR'larına kapı açmak için şablon
// görevi görür. Gerçek bot geliştirme için: bot-sdk/README.md

import { v4 as uuidv4 } from 'uuid';
import db from './loader';
import logger from '../lib/logger';

// Örnek botlar — her biri Bridge Bot SDK ile yazılmış bir şablon içeriyor
const EXAMPLE_BOTS = [
  {
    _id:         uuidv4(),
    name:        'BridgeBot',
    slug:        'bridgebot',
    description: 'Resmi Bridge yardımcı botu. Sunucu kurulumu, komut rehberi ve SSS yanıtları.',
    avatarUrl:   null,
    authorName:  'Bridge Team',
    authorUrl:   'https://github.com/bridge-app',
    sourceUrl:   'https://github.com/bridge-app/bridgebot',
    installCount: 0,
    tags:        ['resmi', 'yardımcı', 'komut'],
    permissions: ['messages:read', 'messages:send'],
    verified:    true,
    featured:    true,
    webhookUrl:  null,
    createdAt:   Date.now(),
  },
  {
    _id:         uuidv4(),
    name:        'PollBot',
    slug:        'pollbot',
    description: 'Gelişmiş anket ve oylama botu. Zamanlı anketler, çoklu seçenek, sonuç grafikleri.',
    avatarUrl:   null,
    authorName:  'Bridge Community',
    authorUrl:   null,
    sourceUrl:   null,
    installCount: 0,
    tags:        ['anket', 'topluluk', 'oylama'],
    permissions: ['messages:read', 'messages:send', 'reactions:manage'],
    verified:    false,
    featured:    true,
    webhookUrl:  null,
    createdAt:   Date.now(),
  },
  {
    _id:         uuidv4(),
    name:        'MusicBot',
    slug:        'musicbot',
    description: 'Ses kanallarında müzik çalma botu. YouTube, Spotify ve SoundCloud desteği.',
    avatarUrl:   null,
    authorName:  'Bridge Community',
    authorUrl:   null,
    sourceUrl:   null,
    installCount: 0,
    tags:        ['müzik', 'ses', 'eğlence'],
    permissions: ['voice:join', 'messages:read', 'messages:send'],
    verified:    false,
    featured:    true,
    webhookUrl:  null,
    createdAt:   Date.now(),
  },
  {
    _id:         uuidv4(),
    name:        'ModBot',
    slug:        'modbot',
    description: 'Otomatik moderasyon botu. Spam tespiti, kelime filtresi, uyarı sistemi.',
    avatarUrl:   null,
    authorName:  'Bridge Community',
    authorUrl:   null,
    sourceUrl:   null,
    installCount: 0,
    tags:        ['moderasyon', 'güvenlik', 'otomasyon'],
    permissions: ['messages:read', 'messages:delete', 'members:timeout', 'members:ban'],
    verified:    false,
    featured:    false,
    webhookUrl:  null,
    createdAt:   Date.now(),
  },
  {
    _id:         uuidv4(),
    name:        'WelcomeBot',
    slug:        'welcomebot',
    description: 'Yeni üyelere özelleştirilebilir karşılama mesajı gönderir. Rol ataması ve kanala yönlendirme.',
    avatarUrl:   null,
    authorName:  'Bridge Community',
    authorUrl:   null,
    sourceUrl:   null,
    installCount: 0,
    tags:        ['karşılama', 'otomasyon', 'yeni üye'],
    permissions: ['messages:send', 'roles:assign', 'members:read'],
    verified:    false,
    featured:    false,
    webhookUrl:  null,
    createdAt:   Date.now(),
  },
];

export async function seedMarketplace() {
  let seeded = 0;
  for (const bot of EXAMPLE_BOTS) {
    const exists = await db.bots?.findOne?.({ slug: bot.slug });
    if (!exists) {
      await db.bots?.insert?.(bot);
      seeded++;
    }
  }
  if (seeded > 0) {
    logger.info(
      { event: 'db.seed.marketplace.completed', count: seeded },
      `Bot marketplace: ${seeded} örnek bot eklendi.`
    );
  }
}

export default seedMarketplace;
