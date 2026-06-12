/**
 * Bridge Bot SDK — örnek karşılama botu
 * Kullanım: BRIDGE_BOT_TOKEN=brg_xxx BRIDGE_SERVER_URL=http://localhost:3001 node index.js
 */
// Önce: cd bot-sdk && npm install && npm run build
const { BridgeBot } = require('../../dist/index');

const bot = new BridgeBot({
  token: process.env.BRIDGE_BOT_TOKEN,
  serverUrl: process.env.BRIDGE_SERVER_URL || 'http://localhost:3001',
  debug: true,
});

bot.on('ready', (info) => {
  console.log(`✅ ${info.username} hazır`);
});

bot.command('ping', {
  description: 'Pong döndürür',
  handler: async (ctx) => ctx.reply('🏓 Pong!'),
});

bot.command('welcome', {
  description: 'Kanala hoş geldin mesajı gönderir',
  handler: async (ctx) => {
    await ctx.reply(`Hoş geldin, ${ctx.user?.username || 'misafir'}! 🌉`);
  },
});

bot.connect().catch((err) => {
  console.error('Bot bağlanamadı:', err.message);
  process.exit(1);
});
