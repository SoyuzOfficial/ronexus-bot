/**
 * RoNexus Bot – Hardened Edition
 * If this crashes now, Discord itself is on life support.
 */

const { 
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const axios = require('axios');

// =======================
// PROCESS SAFETY NETS
// =======================
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

// =======================
// DISCORD / DB / SERVER
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// ROBLOX OAUTH
// =======================
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URL;
const pendingVerifications = new Map();

// =======================
// DB INIT (AUTO CREATE)
// =======================
async function initDB() {
  const tables = `
  CREATE TABLE IF NOT EXISTS licenses (
    license_key TEXT PRIMARY KEY,
    is_active BOOLEAN DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS guild_licenses (
    guild_id VARCHAR(20) PRIMARY KEY,
    license_key TEXT
  );

  CREATE TABLE IF NOT EXISTS verified_users (
    guild_id VARCHAR(20),
    user_id VARCHAR(20),
    roblox_id BIGINT,
    roblox_username TEXT,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS user_points (
    guild_id VARCHAR(20),
    user_id VARCHAR(20),
    points INT DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS ranks (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20),
    rank_name TEXT,
    role_id VARCHAR(20),
    points_required INT
  );

  CREATE TABLE IF NOT EXISTS roblox_groups (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20),
    group_id BIGINT,
    api_key TEXT,
    auto_rank_enabled BOOLEAN DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS group_rank_mapping (
    id SERIAL PRIMARY KEY,
    roblox_group_id INT,
    discord_role_id VARCHAR(20),
    roblox_rank_id INT
  );

  CREATE TABLE IF NOT EXISTS blacklisted_users (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20),
    roblox_user_id BIGINT,
    roblox_username TEXT,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20),
    user_id VARCHAR(20),
    moderator_id VARCHAR(20),
    reason TEXT,
    timestamp TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS background_checks (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20),
    user_id VARCHAR(20),
    roblox_id BIGINT,
    roblox_username TEXT,
    risk_score INT,
    risk_level TEXT,
    account_age_days INT,
    has_premium BOOLEAN,
    total_badges INT,
    total_friends INT,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS xtracker_cache (
    roblox_user_id BIGINT PRIMARY KEY,
    is_flagged BOOLEAN,
    exploit_data JSONB,
    last_checked TIMESTAMP DEFAULT NOW()
  );
  `;

  await pool.query(tables);
  console.log('✅ Database ready');
}

// =======================
// HELPERS
// =======================
function safeReply(interaction, data) {
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply(data).catch(() => {});
  }
  return interaction.reply(data).catch(() => {});
}

function calculateRiskScore(age, badges, friends, verified, premium) {
  let score = 0;
  if (age < 7) score += 3;
  else if (age < 30) score += 2;
  if (badges === 0) score += 2;
  if (friends === 0) score += 2;
  if (verified) score -= 2;
  if (premium) score -= 1;
  return Math.max(0, Math.min(10, score));
}

function getRiskLevel(score) {
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  return 'LOW';
}

// =======================
// BOT READY
// =======================
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} online`);
  await initDB();

  const commands = [
    { name: 'activate', description: 'Activate bot', options: [{ name: 'license', type: 3, required: true }] },
    { name: 'verify', description: 'Verify Roblox account' },
    { name: 'bgcheck', description: 'Background check', options: [{ name: 'username', type: 3, required: true }] }
  ];

  await client.application.commands.set(commands);
  console.log('✅ Commands registered');
});

// =======================
// COMMAND HANDLER
// =======================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, user } = interaction;

  if (commandName === 'verify') {
    if (!OAUTH_REDIRECT || !OAUTH_REDIRECT.startsWith('https://')) {
      return safeReply(interaction, {
        content: '❌ OAuth redirect URL is misconfigured.',
        flags: 64
      });
    }

    const state = `${guildId}_${user.id}_${Date.now()}`;
    pendingVerifications.set(state, { guildId, userId: user.id });

    const authUrl =
      `https://apis.roblox.com/oauth/v1/authorize` +
      `?client_id=${ROBLOX_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` +
      `&scope=openid profile` +
      `&response_type=code` +
      `&state=${state}`;

    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Verify with Roblox')
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl)
    );

    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setTitle('🔐 Verify').setDescription('Click below')],
      components: [btn],
      flags: 64
    });
  }

  if (commandName === 'bgcheck') {
    await interaction.deferReply();

    try {
      const username = interaction.options.getString('username');
      const lookup = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [username],
        excludeBannedUsers: false
      });

      if (!lookup.data.data.length) {
        return interaction.editReply('❌ Roblox user not found');
      }

      const robloxId = lookup.data.data[0].id;
      const info = await axios.get(`https://users.roblox.com/v1/users/${robloxId}`);

      const created = new Date(info.data.created);
      const age = Math.floor((Date.now() - created) / 86400000);

      const riskScore = calculateRiskScore(
        age,
        0,
        0,
        info.data.hasVerifiedBadge,
        info.data.isPremium
      );

      const riskLevel = getRiskLevel(riskScore);

      await pool.query(
        `INSERT INTO background_checks 
        (guild_id, user_id, roblox_id, roblox_username, risk_score, risk_level, account_age_days)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [guildId, null, robloxId, info.data.name, riskScore, riskLevel, age]
      );

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔍 Background Check')
            .addFields(
              { name: 'User', value: info.data.name },
              { name: 'Risk', value: `${riskLevel} (${riskScore}/10)` },
              { name: 'Account Age', value: `${age} days` }
            )
        ]
      });

    } catch (err) {
      console.error(err);
      return interaction.editReply('❌ Background check failed safely.');
    }
  }
});

// =======================
// OAUTH CALLBACK
// =======================
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const pending = pendingVerifications.get(state);
  if (!pending) return res.send('Invalid state');

  try {
    const token = await axios.post(
      'https://apis.roblox.com/oauth/v1/token',
      `client_id=${ROBLOX_CLIENT_ID}&client_secret=${ROBLOX_CLIENT_SECRET}&grant_type=authorization_code&code=${code}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const userInfo = await axios.get(
      'https://apis.roblox.com/oauth/v1/userinfo',
      { headers: { Authorization: `Bearer ${token.data.access_token}` } }
    );

    await pool.query(
      `INSERT INTO verified_users (guild_id,user_id,roblox_id,roblox_username)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id,user_id)
       DO UPDATE SET roblox_id=$3, roblox_username=$4`,
      [pending.guildId, pending.userId, userInfo.data.sub, userInfo.data.preferred_username]
    );

    pendingVerifications.delete(state);
    res.send('✅ Verified! You can close this tab.');

  } catch (e) {
    console.error(e);
    res.send('❌ Verification failed');
  }
});

app.get('/', (_, res) => res.send('🤖 RoNexus Online'));
app.listen(PORT, () => console.log(`🌐 Web on ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
