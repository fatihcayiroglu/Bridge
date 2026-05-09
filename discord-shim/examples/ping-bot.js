/**
 * Örnek: Mevcut bir Discord.js botu — import satırı dışında HİÇBİR DEĞİŞİKLİK YOK
 */
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  SlashCommandBuilder,
} = require('../');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Map();

client.commands.set('ping', {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Gecikme süresini gösterir'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('Pong!')
      .addFields(
        { name: 'Durum', value: 'Cevrimici', inline: true },
        { name: 'Platform', value: 'Bridge', inline: true },
      )
      .setFooter({ text: 'Bridge Bot' })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  },
});

client.once(Events.ClientReady, (c) => {
  console.log(`${c.user.tag} Bridge'e baglandi!`);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (message.content.toLowerCase() === '!ping') {
    message.reply('Pong!');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    await interaction.reply('Bir hata olustu.');
  }
});

client.login(process.env.BRIDGE_TOKEN);
