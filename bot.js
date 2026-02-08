const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const axios = require('axios');

// ---------- ENV CHECK ----------
if (!process.env.DISCORD_TOKEN) console.warn('⚠️ DISCORD_TOKEN missing, bot may not login');
if (!process.env.CLIENT_ID) console.warn('⚠️ CLIENT_ID missing, some features may fail');
if (!process.env.DATABASE_URL) console.warn('⚠️ DATABASE_URL missing, database features may fail');

// ---------- DATABASE & BOT ----------
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const app = express();
const PORT = process.env.PORT || 3000;

const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID || '';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || '';
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URL || '';
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

    if (ranks.rows.length > 0) {
      const rank = ranks.rows[0];
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;

      const member = await guild.members.fetch(userId);
      const role = guild.roles.cache.get(rank.role_id);

      if (role && !member.roles.cache.has(rank.role_id)) {
        await member.roles.add(role);

        // Roblox promotion
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
    }
  } catch (e) {
    console.error('Auto-promote error:', e);
  }
}

// ============================================
// BOT READY
// ============================================
// BOT READY
client.once('ready', async () => { // <-- changed from clientReady
  console.log(`✅ ${client.user.tag} is online!`);

  try {
    const commands = [
      { name: 'activate', description: 'Activate bot', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
      { name: 'verify', description: 'Verify Roblox account' },
      { name: 'setup', description: 'Setup wizard', default_member_permissions: '8' },
      // ... rest of commands
    ];

    await client.application.commands.set(commands);
    console.log('✅ Commands registered!');
  } catch (e) {
    console.error('❌ Failed to register commands:', e);
  }
});

// INTERACTION
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  try {
    // Long commands need deferReply
    if (['bgcheck', 'points', 'addpoints', 'removepoints', 'leaderboard'].includes(commandName)) {
      await interaction.deferReply({ ephemeral: true });
    }

    if (commandName === 'activate') {
      const license = interaction.options.getString('license');
      await interaction.reply({ content: `✅ Activated with license ${license}`, ephemeral: true });
    }

    if (commandName === 'bgcheck') {
      // do your BGCheck stuff
      await interaction.editReply({ content: '🔍 Checked!' });
    }

    // ...other commands
  } catch (err) {
    console.error('❌ Command error:', err);
    if (!interaction.replied) await interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true });
  }
});


// ============================================
// (Rest of your interactionCreate & OAUTH routes remain unchanged, all deferred/replied properly)
// ============================================

app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
setInterval(() => console.log('🔄'), 300000);
client.login(process.env.DISCORD_TOKEN || '');
