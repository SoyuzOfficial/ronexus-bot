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
        
        // Check for Roblox group promotion
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
client.once('clientReady', async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  
  const commands = [
    { name: 'activate', description: 'Activate bot', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
    { name: 'verify', description: 'Verify Roblox account' },
    { name: 'setup', description: 'Setup wizard', default_member_permissions: '8' },
    
    // Points
    { name: 'points', description: 'Check points', options: [{ name: 'user', description: 'Username or @user', type: 3 }] },
    { name: 'addpoints', description: 'Add points', default_member_permissions: '8', options: [{ name: 'user', description: 'Username or @user', type: 3, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'removepoints', description: 'Remove points', default_member_permissions: '8', options: [{ name: 'user', description: 'Username or @user', type: 3, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }] },
    { name: 'leaderboard', description: 'Leaderboard' },
    
    // Security
    { name: 'bgcheck', description: 'Background check (includes XTracker)', options: [{ name: 'username', description: 'Roblox username or Discord @user', type: 3, required: true }] },
    
    // Blacklist
    { name: 'blacklist', description: 'Blacklist user', default_member_permissions: '8', options: [{ name: 'roblox_username', description: 'Roblox username', type: 3, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] },
    { name: 'unblacklist', description: 'Remove blacklist', default_member_permissions: '8', options: [{ name: 'roblox_username', description: 'Roblox username', type: 3, required: true }] },
    { name: 'viewblacklist', description: 'View blacklist' },
    
    // Groups
    { name: 'addgroup', description: 'Add Roblox group', default_member_permissions: '8', options: [{ name: 'group_id', description: 'Roblox group ID', type: 4, required: true }, { name: 'api_key', description: 'Roblox API key', type: 3, required: true }] },
    { name: 'maprank', description: 'Map Discord role to Roblox rank', default_member_permissions: '8', options: [{ name: 'discord_role', description: 'Discord role', type: 8, required: true }, { name: 'roblox_rank_id', description: 'Roblox rank ID', type: 4, required: true }] },
    
    // Ranks
    { name: 'addrank', description: 'Add points rank', default_member_permissions: '8', options: [{ name: 'role', description: 'Discord role', type: 8, required: true }, { name: 'points', description: 'Points required', type: 4, required: true }, { name: 'name', description: 'Rank name', type: 3, required: true }] },
    
    // Moderation
    { name: 'kick', description: 'Kick user', default_member_permissions: '2', options: [{ name: 'user', description: '@user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'ban', description: 'Ban user', default_member_permissions: '4', options: [{ name: 'user', description: '@user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'warn', description: 'Warn user', default_member_permissions: '8', options: [{ name: 'user', description: '@user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] }
  ];

  await client.application.commands.set(commands);
  console.log('✅ Commands registered!');
});

// ============================================
// COMMANDS
// ============================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const { commandName, guildId, user, options } = interaction;

  // ACTIVATE
  if (commandName === 'activate') {
    const license = options.getString('license');
    try {
      const licCheck = await pool.query('SELECT * FROM licenses WHERE license_key = $1 AND is_active = true', [license]);
      if (licCheck.rows.length === 0) return interaction.reply({ content: '❌ Invalid license!', ephemeral: true });
      const guildCheck = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (guildCheck.rows.length > 0) return interaction.reply({ content: '✅ Already activated!', ephemeral: true });
      await pool.query('INSERT INTO guild_licenses (guild_id, license_key) VALUES ($1, $2)', [guildId, license]);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00FF00').setTitle('✅ Activated!').setDescription('Bot is now active!\n\nUse `/verify` to link Roblox\nUse `/setup` for more options')] });
    } catch (e) { console.error(e); return interaction.reply({ content: `❌ Error: ${e.message}`, ephemeral: true }); }
  }

  // Check activation
  const activated = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
  if (activated.rows.length === 0 && commandName !== 'activate') {
    return interaction.reply({ content: '❌ Not activated! Use `/activate YOUR_LICENSE`', ephemeral: true });
  }

  // VERIFY
  if (commandName === 'verify') {
    const state = `${guildId}_${user.id}_${Date.now()}`;
    pendingVerifications.set(state, { guildId, userId: user.id });
    const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=openid profile&response_type=code&state=${state}`;
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🔗 Verify with Roblox').setStyle(ButtonStyle.Link).setURL(authUrl));
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle('🔐 Verify').setDescription('Click below!')], components: [btn], ephemeral: true });
  }

  // SETUP
  if (commandName === 'setup') {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setTitle('⚙️ Setup').addFields(
      { name: '1️⃣ Groups', value: '`/addgroup` to link Roblox group' },
      { name: '2️⃣ Ranks', value: '`/addrank` to add point-based ranks' },
      { name: '3️⃣ Map Ranks', value: '`/maprank` to sync Discord → Roblox ranks' }
    )] });
  }

  // POINTS
  if (commandName === 'points') {
    const input = options.getString('user');
    let targetId = user.id;
    
    if (input) {
      const mention = input.match(/<@!?(\d+)>/);
      if (mention) targetId = mention[1];
      else {
        const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', [guildId, input]);
        if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
      }
    }
    
    const res = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    const pts = res.rows.length > 0 ? res.rows[0].points : 0;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('💰 Points').setDescription(`<@${targetId}> has **${pts}** points`)] });
  }

  // ADDPOINTS
  if (commandName === 'addpoints') {
    const input = options.getString('user');
    const amount = options.getInteger('amount');
    const reason = options.getString('reason') || 'None';
    
    let targetId = null;
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) {
      targetId = mention[1];
    } else {
      const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', [guildId, input]);
      if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
    }
    
    if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    
    await pool.query('INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO UPDATE SET points = user_points.points + $3', [guildId, targetId, amount]);
    
    const newPoints = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    await checkAndPromote(guildId, targetId, newPoints.rows[0].points);
    
    return interaction.reply({ content: `✅ +${amount} points to <@${targetId}>!\nReason: ${reason}` });
  }

  // REMOVEPOINTS
  if (commandName === 'removepoints') {
    const input = options.getString('user');
    const amount = options.getInteger('amount');
    
    let targetId = null;
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) targetId = mention[1];
    else {
      const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', [guildId, input]);
      if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
    }
    
    if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    
    await pool.query('UPDATE user_points SET points = GREATEST(0, points - $1) WHERE guild_id = $2 AND user_id = $3', [amount, guildId, targetId]);
    return interaction.reply({ content: `✅ -${amount} points from <@${targetId}>` });
  }

  // LEADERBOARD
  if (commandName === 'leaderboard') {
    const res = await pool.query('SELECT user_id, points FROM user_points WHERE guild_id = $1 ORDER BY points DESC LIMIT 10', [guildId]);
    if (res.rows.length === 0) return interaction.reply('📋 No data!');
    const lb = res.rows.map((r, i) => `${i + 1}. <@${r.user_id}> - **${r.points}** pts`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Leaderboard').setDescription(lb)] });
  }

  // BGCHECK
  if (commandName === 'bgcheck') {
    await interaction.deferReply();
    
    const input = options.getString('username');
    let robloxId = null;
    let robloxUsername = null;
    
    // Check if mention
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) {
      const verified = await pool.query('SELECT roblox_id, roblox_username FROM verified_users WHERE guild_id = $1 AND user_id = $2', [guildId, mention[1]]);
      if (verified.rows.length === 0) return interaction.editReply('❌ User not verified!');
      robloxId = verified.rows[0].roblox_id;
      robloxUsername = verified.rows[0].roblox_username;
    } else {
      // Lookup by username
      const lookup = await getRobloxIdFromUsername(input);
      if (!lookup) return interaction.editReply('❌ Roblox user not found!');
      robloxId = lookup.id;
      robloxUsername = lookup.username;
    }
    
    try {
      const robloxInfo = await getRobloxUserInfo(robloxId);
      if (!robloxInfo) return interaction.editReply('❌ Could not fetch Roblox data!');
      
      // Get badges
      const badgesRes = await axios.get(`https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100`);
      const badgeCount = badgesRes.data.data?.length || 0;
      
      // Get friends
      const friendsRes = await axios.get(`https://friends.roblox.com/v1/users/${robloxId}/friends/count`);
      const friendCount = friendsRes.data.count || 0;
      
      // Account age
      const createdDate = new Date(robloxInfo.created);
      const accountAgeDays = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
      
      const hasPremium = robloxInfo.isPremium || false;
      const hasVerifiedBadge = robloxInfo.hasVerifiedBadge || false;
      
      // Risk
      const riskScore = calculateRiskScore(accountAgeDays, badgeCount, friendCount, hasVerifiedBadge, hasPremium);
      const riskLevel = getRiskLevel(riskScore);
      
      // XTracker
      const xtracker = await checkXTracker(robloxId);
      
      // Save
      await pool.query('INSERT INTO background_checks (guild_id, user_id, roblox_id, roblox_username, risk_score, risk_level, account_age_days, has_premium, total_badges, total_friends) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', 
        [guildId, mention ? mention[1] : 'manual', robloxId, robloxUsername, riskScore, riskLevel, accountAgeDays, hasPremium, badgeCount, friendCount]);
      
      // Cache XTracker
      await pool.query('INSERT INTO xtracker_cache (roblox_user_id, is_flagged, exploit_data) VALUES ($1, $2, $3) ON CONFLICT (roblox_user_id) DO UPDATE SET is_flagged = $2, exploit_data = $3, last_checked = NOW()', 
        [robloxId, xtracker.flagged, JSON.stringify(xtracker.data)]);
      
      const riskColor = riskLevel === 'CRITICAL' ? '#FF0000' : riskLevel === 'HIGH' ? '#FFA500' : riskLevel === 'MEDIUM' ? '#FFFF00' : '#00FF00';
      
      const embed = new EmbedBuilder()
        .setColor(riskColor)
        .setTitle('🔍 Background Check')
        .setDescription(`**Roblox:** ${robloxUsername} (${robloxId})`)
        .addFields(
          { name: '⚠️ Risk', value: `**${riskLevel}** (${riskScore}/10)`, inline: true },
          { name: '📅 Account Age', value: `${accountAgeDays} days`, inline: true },
          { name: '🎖️ Badges', value: `${badgeCount}`, inline: true },
          { name: '👥 Friends', value: `${friendCount}`, inline: true },
          { name: '💎 Premium', value: hasPremium ? 'Yes' : 'No', inline: true },
          { name: '✅ Verified Badge', value: hasVerifiedBadge ? 'Yes' : 'No', inline: true }
        )
        .setFooter({ text: xtracker.flagged ? '🚨 XTRACKER: FLAGGED AS EXPLOITER' : '✅ XTracker: Clean' })
        .setTimestamp();
      
      return interaction.editReply({ embeds: [embed] });
      
    } catch (e) {
      console.error('BGCheck error:', e);
      return interaction.editReply(`❌ Error: ${e.message}`);
    }
  }

  // BLACKLIST
  if (commandName === 'blacklist') {
    const username = options.getString('roblox_username');
    const reason = options.getString('reason');
    const lookup = await getRobloxIdFromUsername(username);
    if (!lookup) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    await pool.query('INSERT INTO blacklisted_users (guild_id, roblox_user_id, roblox_username, reason) VALUES ($1, $2, $3, $4)', [guildId, lookup.id, lookup.username, reason]);
    return interaction.reply({ content: `🚫 Blacklisted **${lookup.username}**` });
  }

  // UNBLACKLIST
  if (commandName === 'unblacklist') {
    const username = options.getString('roblox_username');
    const lookup = await getRobloxIdFromUsername(username);
    if (!lookup) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    await pool.query('DELETE FROM blacklisted_users WHERE guild_id = $1 AND roblox_user_id = $2', [guildId, lookup.id]);
    return interaction.reply({ content: `✅ Removed **${lookup.username}**` });
  }

  // VIEW BLACKLIST
  if (commandName === 'viewblacklist') {
    const res = await pool.query('SELECT roblox_username, reason FROM blacklisted_users WHERE guild_id = $1 LIMIT 20', [guildId]);
    if (res.rows.length === 0) return interaction.reply('📋 Empty!');
    const list = res.rows.map(r => `**${r.roblox_username}**: ${r.reason}`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🚫 Blacklist').setDescription(list).setColor('#FF0000')] });
  }

  // ADD GROUP
  if (commandName === 'addgroup') {
    const groupId = options.getInteger('group_id');
    const apiKey = options.getString('api_key');
    await pool.query('INSERT INTO roblox_groups (guild_id, group_id, api_key, auto_rank_enabled) VALUES ($1, $2, $3, true)', [guildId, groupId, apiKey]);
    return interaction.reply({ content: `✅ Added Roblox group **${groupId}**!`, ephemeral: true });
  }

  // MAP RANK
  if (commandName === 'maprank') {
    const role = options.getRole('discord_role');
    const robloxRankId = options.getInteger('roblox_rank_id');
    const group = await pool.query('SELECT id FROM roblox_groups WHERE guild_id = $1 LIMIT 1', [guildId]);
    if (group.rows.length === 0) return interaction.reply({ content: '❌ No groups! Use `/addgroup` first.', ephemeral: true });
    await pool.query('INSERT INTO group_rank_mapping (roblox_group_id, discord_role_id, roblox_rank_id) VALUES ($1, $2, $3)', [group.rows[0].id, role.id, robloxRankId]);
    return interaction.reply({ content: `✅ Mapped ${role} → Roblox rank ${robloxRankId}`, ephemeral: true });
  }

  // ADD RANK
  if (commandName === 'addrank') {
    const role = options.getRole('role');
    const points = options.getInteger('points');
    const name = options.getString('name');
    const order = await pool.query('SELECT COUNT(*) FROM ranks WHERE guild_id = $1', [guildId]);
    await pool.query('INSERT INTO ranks (guild_id, rank_name, role_id, points_required, rank_order) VALUES ($1, $2, $3, $4, $5)', [guildId, name, role.id, points, parseInt(order.rows[0].count) + 1]);
    return interaction.reply({ content: `✅ Added rank **${name}** (${points} pts) → ${role}`, ephemeral: true });
  }

  // KICK
  if (commandName === 'kick') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'None';
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
      return interaction.reply({ content: `👢 Kicked ${target}` });
    } catch (e) { return interaction.reply({ content: '❌ Cannot kick!', ephemeral: true }); }
  }

  // BAN
  if (commandName === 'ban') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'None';
    try {
      await interaction.guild.members.ban(target, { reason });
      return interaction.reply({ content: `🔨 Banned ${target}` });
    } catch (e) { return interaction.reply({ content: '❌ Cannot ban!', ephemeral: true }); }
  }

  // WARN
  if (commandName === 'warn') {
    const target = options.getUser('user');
    const reason = options.getString('reason');
    
    // Create warnings table if doesn't exist
    await pool.query('CREATE TABLE IF NOT EXISTS warnings (id SERIAL PRIMARY KEY, guild_id VARCHAR(20), user_id VARCHAR(20), moderator_id VARCHAR(20), reason TEXT, timestamp TIMESTAMP DEFAULT NOW())');
    await pool.query('INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES ($1, $2, $3, $4)', [guildId, target.id, user.id, reason]);
    
    return interaction.reply({ content: `⚠️ Warned ${target}\nReason: ${reason}` });
  }
});

// OAUTH
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const pending = pendingVerifications.get(state);
  if (!pending) return res.send('❌ Invalid');
  
  try {
    const tokenRes = await axios.post('https://apis.roblox.com/oauth/v1/token', `client_id=${ROBLOX_CLIENT_ID}&client_secret=${ROBLOX_CLIENT_SECRET}&grant_type=authorization_code&code=${code}`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const userRes = await axios.get('https://apis.roblox.com/oauth/v1/userinfo', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const { sub: robloxId, preferred_username: robloxUsername } = userRes.data;
    
    await pool.query('INSERT INTO verified_users (user_id, guild_id, roblox_id, roblox_username) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO UPDATE SET roblox_id = $3, roblox_username = $4', [pending.userId, pending.guildId, robloxId, robloxUsername]);
    await pool.query('INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [pending.guildId, pending.userId]);
    
    pendingVerifications.delete(state);
    res.send(`✅ Verified as ${robloxUsername}! Close this.`);
  } catch (e) { console.error(e); res.send('❌ Error!'); }
});

app.get('/', (req, res) => res.send('🤖 RoNexus!'));
app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
setInterval(() => console.log('🔄'), 300000);
client.login(process.env.DISCORD_TOKEN);
