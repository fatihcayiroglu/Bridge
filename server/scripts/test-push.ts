#!/usr/bin/env node
// server/scripts/test-push.js
// Manuel push notification smoke test
//
// Kullanım:
//   DATABASE_URL=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
//   node server/scripts/test-push.js <userId>
//
// Örnek:
//   node server/scripts/test-push.js 64abc123def456
//
// Ne yapar:
//   1. Verilen kullanıcının push subscription'larını DB'den çeker
//   2. Her subscription'a test push gönderir
//   3. Başarı/hata özetini basar

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const userId = process.argv[2];
if (!userId) {
  console.error('Kullanım: node test-push.js <userId>');
  process.exit(1);
}

async function main() {
  const { Notifications } = require('../db/repositories');
  const { sendPushToUser } = require('../lib/pushSender');

  console.log(`\n🔔 Push smoke test — userId: ${userId}\n`);

  // Subscription kontrol
  const webSubs = await Notifications.findPushSubscriptionsForUser(userId).catch(() => []);
  const nativeTokens = await Notifications.findNativeTokensForUser(userId).catch(() => []);

  console.log(`Web subscriptions : ${webSubs.length}`);
  console.log(`Native (FCM) tokens: ${nativeTokens.length}`);

  if (webSubs.length === 0 && nativeTokens.length === 0) {
    console.warn('\n⚠️  Kullanıcının push subscription\'ı yok. Önce tarayıcıda bildirim iznini aktifleştirin.');
    process.exit(0);
  }

  const testPayload = {
    title: '🧪 Bridge Test',
    body: 'Bu bir smoke test bildirimidir.',
    icon: '/icon-192.png',
    tag: 'smoke-test',
    data: { type: 'smoke_test', ts: Date.now() },
  };

  console.log('\nGönderiliyor...');
  await sendPushToUser(userId, testPayload);
  console.log('✅ sendPushToUser tamamlandı. Cihazınızda bildirimi kontrol edin.\n');

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Hata:', err.message);
  process.exit(1);
});
export {};
