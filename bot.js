/**
 * RoNexus Bot – FINAL STABLE BUILD
 * Discord.js v14
 * Node.js 18+ / 22 OK
 */

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  REST,
  Routes
} = require('discord.js');

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

/* =====================
   SAFETY NETS
===================== */
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

/* =====================
   ENV
===================== */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID');
  process.exit(1);
}

/* =====================
   DISCORD CLIENT
===================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =====================
   DATABASE
===================== */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verified_users (
      guild_id VARCHAR(20),
      user_id VARCHAR(20),
      roblox_username TEXT,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  console.log('✅ Database ready');
}

/* =====================
   SLASH COMMANDS
===================== */
const commands = [
  {
    name: 'activate',
    description: 'Activate the bot',
    default_member_permissions: PermissionFlagsBits.Administrator.toString()
  },
  {
    name: 'verify',
    description: 'Verify your Roblox account'
  },
  {
    name: 'bgcheck',
    description: 'Run a Roblox background check',
    options: [
      {
        name: 'username',
        description: 'Roblox username',
        type: 3,
        required: true
      }
    ]
  }
];

/* =====================
   REGISTER COMMANDS
===================== */
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );
  console.log('✅ Slash commands registered');
}

/* =====================
   READY
===================== */
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} online`);
  await initDB();
  await registerCommands();
});

/* =====================
   COMMAND HANDLER
===================== */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    /* ---- ACTIVATE ---- */
    if (interaction.commandName === 'activate') {
      return interaction.reply({
        content: '✅ RoNexus activated successfully.',
        ephemeral: true
      });
    }

    /* ---- VERIFY ---- */
    if (interaction.commandName === 'verify') {
      return interaction.reply({
        content: '🔐 Verification system placeholder (OAuth safe)',
        ephemeral: true
      });
    }

    /* ---- BGCHECK ---- */
    if (interaction.commandName === 'bgcheck') {
      await interaction.deferReply({ ephemeral: true });

      const username = interaction.options.getString('username');

      const lookup = await axios.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames: [username] }
      );

      if (!lookup.data.data.length) {
        return interaction.editReply('❌ Roblox user not found');
      }

      const robloxId = lookup.data.data[0].id;

      const userInfo = await axios.get(
        `https://users.roblox.com/v1/users/${robloxId}`
      );

      const created = new Date(userInfo.data.created);
      const ageDays = Math.floor((Date.now() - created) / 86400000);

      const embed = new EmbedBuilder()
        .setTitle('🔍 Background Check')
        .addFields(
          { name: 'Username', value: userInfo.data.name, inline: true },
          { name: 'Account Age', value: `${ageDays} days`, inline: true },
          { name: 'Banned', value: userInfo.data.isBanned ? 'Yes' : 'No', inline: true }
        );

      return interaction.editReply({ embeds: [embed] });
    }

  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      interaction.editReply('❌ Command failed safely.');
    } else {
      interaction.reply({ content: '❌ Command failed safely.', ephemeral: true });
    }
  }
});

/* =====================
   WEB SERVER
===================== */
const app = express();
app.get('/', (_, res) => res.send('🤖 RoNexus Online'));
app.listen(PORT, () => console.log(`🌐 Web on ${PORT}`));

/* =====================
   LOGIN
===================== */
client.login(DISCORD_TOKEN);
