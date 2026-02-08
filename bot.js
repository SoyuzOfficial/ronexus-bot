// ===================================================
// RoNexus Bot (Fixed Full Version)
// ===================================================
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const axios = require('axios');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const app = express();
const PORT = process.env.PORT || 3000;

const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URL;

const pendingVerifications = new Map();

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getRobloxIdFromUsername(username) {
  try {
    const res = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username],
      excludeBannedUsers: false
    });
    if (res.data.data && res.data.data.length > 0) {
      return { id: res.data.data[0].id, username: res.data.data[0].name };
    }
    return null;
  } catch (e) {
    console.error('Roblox username lookup error:', e);
    return null;
  }
}

async function getRobloxUserInfo(userId) {
  try {
    const res = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
    return res.data;
  } catch (e) {
    console.error('Roblox user info error:', e);
    return null;
  }
}

function calculateRiskScore(accountAgeDays, badges, friends, hasVerifiedBadge, hasPremium) {
  let score = 0;
  if (accountAgeDays < 7) score += 3;
  else if (accountAgeDays < 30) score += 2;
  else if (accountAgeDays < 90) score += 1;
  if (badges === 0) score += 2;
  else if (badges < 5) score += 1;
  if (friends === 0) score += 2;
  else if (friends < 5) score += 1;
  if (hasVerifiedBadge) score -= 2;
  if (hasPremium) score -= 1;
  return Math.max(0, Math.min(10, score));
}

function getRiskLevel(score) {
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  return 'LOW';
}

async function checkXTracker(robloxId) {
  try {
    const res = await axios.get(`https://api.xtracker.gg/v1/check/${robloxId}`);
    return { flagged: res.data.flagged || false, data: res.data };
  } catch (e) {
    return { flagged: false, data: null };
  }
}

async function setRobloxGroupRank(groupId, userId, roleId, apiKey) {
  try {
    await axios.patch(
      `https://groups.roblox.com/v1/groups/${groupId}/users/${userId}`,
      { roleId: roleId },
      { headers: { 'x-api-key': apiKey } }
    );
    return true;
  } catch (e) {
    console.error('Roblox rank change error:', e);
    return false;
  }
}

async function checkAndPromote(guildId, userId, points) {
  try {
    const ranks = await pool.query(
      'SELECT * FROM ranks WHERE guild_id = $1 AND points_required <= $2 ORDER BY points_required DESC LIMIT 1',
      [guildId, points]
    );

    if (ranks.rows.length === 0) return;

    const rank = ranks.rows[0];
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.get(rank.role_id);

    if (role && !member.roles.cache.has(rank.role_id)) {
      await member.roles.add(role);

      const verified = await pool.query(
        'SELECT roblox_id FROM verified_users WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
      );

      if (verified.rows.length > 0) {
        const robloxGroups = await pool.query(
          'SELECT * FROM roblox_groups WHERE guild_id = $1 AND auto_rank_enabled = true',
          [guildId]
        );

        for (const group of robloxGroups.rows) {
          const mapping = await pool.query(
            'SELECT roblox_rank_id FROM group_rank_mapping WHERE roblox_group_id = $1 AND discord_role_id = $2',
            [group.id, rank.role_id]
          );
          if (mapping.rows.length > 0) {
            await setRobloxGroupRank(
              group.group_id,
              verified.rows[0].roblox_id,
              mapping.rows[0].roblox_rank_id,
              group.api_key
            );
          }
        }
      }
    }
  } catch (e) {
    console.error('Auto-promote error:', e);
  }
}

// ============================================
// BOT READY
// ============================================
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} is online!`);

  const commands = [
    { name: 'activate', description: 'Activate bot', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
    { name: 'verify', description: 'Verify Roblox account' },
    { name: 'setup', description: 'Setup wizard', default_member_permissions: PermissionFlagsBits.Administrator },

    { name: 'points', description: 'Check points', options: [{ name: 'user', description: 'Username or @user', type: 3 }] },
    { name: 'addpoints', description: 'Add points', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'user', description: 'Username or @user', type: 3, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'removepoints', description: 'Remove points', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'user', description: 'Username or @user', type: 3, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }] },
    { name: 'leaderboard', description: 'Leaderboard' },

    { name: 'bgcheck', description: 'Background check (includes XTracker)', options: [{ name: 'username', description: 'Roblox username or Discord @user', type: 3, required: true }] },

    { name: 'blacklist', description: 'Blacklist user', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'roblox_username', description: 'Roblox username', type: 3, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] },
    { name: 'unblacklist', description: 'Remove blacklist', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'roblox_username', description: 'Roblox username', type: 3, required: true }] },
    { name: 'viewblacklist', description: 'View blacklist' },

    { name: 'addgroup', description: 'Add Roblox group', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'group_id', description: 'Roblox group ID', type: 4, required: true }, { name: 'api_key', description: 'Roblox API key', type: 3, required: true }] },
    { name: 'maprank', description: 'Map Discord role to Roblox rank', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'discord_role', description: 'Discord role', type: 8, required: true }, { name: 'roblox_rank_id', description: 'Roblox rank ID', type: 4, required: true }] },

    { name: 'addrank', description: 'Add points rank', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'role', description: 'Discord role', type: 8, required: true }, { name: 'points', description: 'Points required', type: 4, required: true }, { name: 'name', description: 'Rank name', type: 3, required: true }] },

    { name: 'kick', description: 'Kick user', default_member_permissions: PermissionFlagsBits.KickMembers, options: [{ name: 'user', description: '@user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'ban', description: 'Ban user', default_member_permissions: PermissionFlagsBits.BanMembers, options: [{ name: 'user', description: '@user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'warn', description: 'Warn user', default_member_permissions: PermissionFlagsBits.Administrator, options: [{ name: 'user', description: '@user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] }
  ];

  await client.application.commands.set(commands);
  console.log('✅ Commands registered!');
});

// ============================================
// INTERACTION HANDLER
// ============================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName, guildId, user, options } = interaction;

  // For commands that may take >3s, defer
  const deferCommands = ['bgcheck'];
  if (deferCommands.includes(commandName)) await interaction.deferReply({ ephemeral: true });

  try {
    // ---------- ACTIVATE ----------
    if (commandName === 'activate') {
      const license = options.getString('license');
      const licCheck = await pool.query('SELECT * FROM licenses WHERE license_key = $1 AND is_active = true', [license]);
      if (!licCheck.rows.length) return interaction.reply({ content: '❌ Invalid license!', ephemeral: true });
      const guildCheck = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (guildCheck.rows.length) return interaction.reply({ content: '✅ Already activated!', ephemeral: true });
      await pool.query('INSERT INTO guild_licenses (guild_id, license_key) VALUES ($1, $2)', [guildId, license]);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00FF00').setTitle('✅ Activated!').setDescription('Bot is now active!\n\nUse `/verify` to link Roblox\nUse `/setup` for more options')] });
    }

    // Check activation for other commands
    if (commandName !== 'activate') {
      const activated = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (!activated.rows.length) return interaction.reply({ content: '❌ Not activated! Use `/activate YOUR_LICENSE`', ephemeral: true });
    }

    // ---------- VERIFY ----------
    if (commandName === 'verify') {
      const state = `${guildId}_${user.id}_${Date.now()}`;
      pendingVerifications.set(state, { guildId, userId: user.id });
      const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=openid profile&response_type=code&state=${state}`;
      const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🔗 Verify with Roblox').setStyle(ButtonStyle.Link).setURL(authUrl));
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle('🔐 Verify').setDescription('Click below!')], components: [btn], ephemeral: true });
    }

    // ---------- SETUP ----------
    if (commandName === 'setup') {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setTitle('⚙️ Setup').addFields(
        { name: '1️⃣ Groups', value: '`/addgroup` to link Roblox group' },
        { name: '2️⃣ Ranks', value: '`/addrank` to add point-based ranks' },
        { name: '3️⃣ Map Ranks', value: '`/maprank` to sync Discord → Roblox ranks' }
      )] });
    }

    // ---------- POINTS ----------
    if (commandName === 'points') {
      let targetId = user.id;
      const input = options.getString('user');
      if (input) {
        const mention = input.match(/<@!?(\d+)>/);
        if (mention) targetId = mention[1];
        else {
          const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', [guildId, input]);
          if (verified.rows.length) targetId = verified.rows[0].user_id;
        }
      }
      const res = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
      const pts = res.rows.length ? res.rows[0].points : 0;
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('💰 Points').setDescription(`<@${targetId}> has **${pts}** points`)] });
    }

    // ---------- ADDPOINTS ----------
    if (commandName === 'addpoints') {
      let targetId = null;
      const input = options.getString('user');
      const amount = options.getInteger('amount');
      const reason = options.getString('reason') || 'None';

      const mention = input.match(/<@!?(\d+)>/);
      if (mention) targetId = mention[1];
      else {
        const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', [guildId, input]);
        if (verified.rows.length) targetId = verified.rows[0].user_id;
      }
      if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });

      await pool.query('INSERT INTO user_points (guild_id, user_id, points) VALUES ($1,$2,$3) ON CONFLICT (guild_id,user_id) DO UPDATE SET points = user_points.points + $3', [guildId, targetId, amount]);

      const newPoints = await pool.query('SELECT points FROM user_points WHERE guild_id=$1 AND user_id=$2', [guildId, targetId]);
      await checkAndPromote(guildId, targetId, newPoints.rows[0].points);

      return interaction.reply({ content: `✅ +${amount} points to <@${targetId}>!\nReason: ${reason}` });
    }

    // ---------- REMOVEPPOINTS ----------
    if (commandName === 'removepoints') {
      let targetId = null;
      const input = options.getString('user');
      const amount = options.getInteger('amount');
      const mention = input.match(/<@!?(\d+)>/);
      if (mention) targetId = mention[1];
      else {
        const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id=$1 AND roblox_username ILIKE $2', [guildId, input]);
        if (verified.rows.length) targetId = verified.rows[0].user_id;
      }
      if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
      await pool.query('UPDATE user_points SET points = GREATEST(0, points - $1) WHERE guild_id=$2 AND user_id=$3', [amount, guildId, targetId]);
      return interaction.reply({ content: `✅ -${amount} points from <@${targetId}>` });
    }

    // ---------- LEADERBOARD ----------
    if (commandName === 'leaderboard') {
      const res = await pool.query('SELECT user_id, points FROM user_points WHERE guild_id=$1 ORDER BY points DESC LIMIT 10', [guildId]);
      if (!res.rows.length) return interaction.reply('📋 No data!');
      const lb = res.rows.map((r, i) => `${i + 1}. <@${r.user_id}> - **${r.points}** pts`).join('\n');
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Leaderboard').setDescription(lb)] });
    }

    // ---------- BGCheck ----------
    if (commandName === 'bgcheck') {
      const input = options.getString('username');
      let robloxId = null, robloxUsername = null;
      const mention = input.match(/<@!?(\d+)>/);

      if (mention) {
        const verified = await pool.query('SELECT roblox_id, roblox_username FROM verified_users WHERE guild_id=$1 AND user_id=$2', [guildId, mention[1]]);
        if (!verified.rows.length) return interaction.editReply('❌ User not verified!');
        robloxId = verified.rows[0].roblox_id;
        robloxUsername = verified.rows[0].roblox_username;
      } else {
        const lookup = await getRobloxIdFromUsername(input);
        if (!lookup) return interaction.editReply('❌ Roblox user not found!');
        robloxId = lookup.id;
        robloxUsername = lookup.username;
      }

      const robloxInfo = await getRobloxUserInfo(robloxId);
      if (!robloxInfo) return interaction.editReply('❌ Could not fetch Roblox data!');

      const badgesRes = await axios.get(`https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100`);
      const badgeCount = badgesRes.data.data?.length || 0;
      const friendsRes = await axios.get(`https://friends.roblox.com/v1/users/${robloxId}/friends/count`);
      const friendCount = friendsRes.data.count || 0;
      const account
