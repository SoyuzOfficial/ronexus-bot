const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const axios = require('axios');

// Database
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

// Discord Client
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMembers
  ] 
});

// Express Server
const app = express();
const PORT = process.env.PORT || 3000;

// OAuth Config
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URL;

// Pending verifications
const pendingVerifications = new Map();

// ============================================
// BOT READY
// ============================================
client.once('clientReady', async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  
  const commands = [
    // Core
    { name: 'activate', description: 'Activate bot with license', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
    { name: 'verify', description: 'Verify your Roblox account' },
    { name: 'setup', description: 'Server setup wizard', default_member_permissions: '8' },
    
    // Points
    { name: 'points', description: 'Check points', options: [{ name: 'user', description: 'User to check', type: 6 }] },
    { name: 'addpoints', description: 'Add points', default_member_permissions: '8', options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'removepoints', description: 'Remove points', default_member_permissions: '8', options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }] },
    { name: 'leaderboard', description: 'Points leaderboard' },
    
    // Security
    { name: 'backgroundcheck', description: 'Run background check on user', options: [{ name: 'user', description: 'User to check', type: 6, required: true }] },
    { name: 'xtracker', description: 'Check if user is exploiter', options: [{ name: 'roblox_id', description: 'Roblox user ID', type: 4, required: true }] },
    
    // Blacklist
    { name: 'blacklist', description: 'Blacklist user', default_member_permissions: '8', options: [{ name: 'roblox_id', description: 'Roblox ID', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] },
    { name: 'unblacklist', description: 'Remove blacklist', default_member_permissions: '8', options: [{ name: 'roblox_id', description: 'Roblox ID', type: 4, required: true }] },
    { name: 'viewblacklist', description: 'View blacklist' },
    
    // Moderation
    { name: 'kick', description: 'Kick user', default_member_permissions: '2', options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'ban', description: 'Ban user', default_member_permissions: '4', options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'warn', description: 'Warn user', default_member_permissions: '8', options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] }
  ];

  try {
    await client.application.commands.set(commands);
    console.log('✅ Commands registered!');
  } catch (error) {
    console.error('Command registration error:', error);
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Get Roblox user info
async function getRobloxUserInfo(userId) {
  try {
    const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
    return response.data;
  } catch (error) {
    console.error('Roblox API error:', error);
    return null;
  }
}

// Calculate risk score
function calculateRiskScore(accountAgeDays, badges, friends, hasVerifiedBadge, hasPremium) {
  let score = 0;
  
  // Account age
  if (accountAgeDays < 7) score += 3;
  else if (accountAgeDays < 30) score += 2;
  else if (accountAgeDays < 90) score += 1;
  
  // Badges
  if (badges === 0) score += 2;
  else if (badges < 5) score += 1;
  
  // Friends
  if (friends === 0) score += 2;
  else if (friends < 5) score += 1;
  
  // Premium/Verified
  if (hasVerifiedBadge) score -= 2;
  if (hasPremium) score -= 1;
  
  return Math.max(0, Math.min(10, score));
}

// Get risk level
function getRiskLevel(score) {
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  return 'LOW';
}

// Check XTracker
async function checkXTracker(robloxId) {
  try {
    const response = await axios.get(`https://api.xtracker.gg/v1/check/${robloxId}`);
    return {
      flagged: response.data.flagged || false,
      data: response.data
    };
  } catch (error) {
    console.error('XTracker API error:', error);
    return { flagged: false, data: null };
  }
}

// ============================================
// COMMANDS
// ============================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  
  const { commandName, guildId, user, options } = interaction;

  // ============ ACTIVATE ============
  if (commandName === 'activate') {
    const license = options.getString('license');
    
    try {
      // Check license
      const licCheck = await pool.query(
        'SELECT * FROM licenses WHERE license_key = $1 AND is_active = true', 
        [license]
      );
      
      if (licCheck.rows.length === 0) {
        return interaction.reply({ 
          content: '❌ Invalid license key!', 
          ephemeral: true 
        });
      }
      
      // Check if already activated
      const guildCheck = await pool.query(
        'SELECT * FROM guild_licenses WHERE guild_id = $1', 
        [guildId]
      );
      
      if (guildCheck.rows.length > 0) {
        return interaction.reply({ 
          content: '✅ Server already activated!', 
          ephemeral: true 
        });
      }
      
      // Activate
      await pool.query(
        'INSERT INTO guild_licenses (guild_id, license_key) VALUES ($1, $2)', 
        [guildId, license]
      );
      
      // Create config
await pool.query(
  'INSERT INTO guild_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', 
  [guildId]
);
      
      return interaction.reply({ 
        embeds: [new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Bot Activated!')
          .setDescription('Server is now activated!\n\nNext: Use `/verify` to link your Roblox account.')
          .setFooter({ text: `License: ${license}` })
        ] 
      });
      
    } catch (error) {
      console.error('Activation error:', error);
      return interaction.reply({ 
        content: `❌ Activation failed: ${error.message}`, 
        ephemeral: true 
      });
    }
  }

  // Check activation for other commands
  try {
    const activated = await pool.query(
      'SELECT * FROM guild_licenses WHERE guild_id = $1', 
      [guildId]
    );
    
    if (activated.rows.length === 0 && commandName !== 'activate') {
      return interaction.reply({ 
        content: '❌ Bot not activated! Use `/activate` with your license key.', 
        ephemeral: true 
      });
    }
  } catch (error) {
    console.error('Activation check error:', error);
  }

  // ============ VERIFY ============
  if (commandName === 'verify') {
    const state = `${guildId}_${user.id}_${Date.now()}`;
    pendingVerifications.set(state, { guildId, userId: user.id });
    
    const authUrl = `https://apis.roblox.com/oauth/v1/authorize?` +
      `client_id=${ROBLOX_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&` +
      `scope=openid profile&` +
      `response_type=code&` +
      `state=${state}`;
    
    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('🔗 Verify with Roblox')
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl)
    );
    
    return interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🔐 Roblox Verification')
        .setDescription('Click the button below to verify your Roblox account via OAuth2!')
      ],
      components: [button], 
      ephemeral: true 
    });
  }

  // ============ SETUP ============
  if (commandName === 'setup') {
    return interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('⚙️ RoNexus Setup')
        .addFields(
          { name: '1️⃣ Activate', value: 'Use `/activate YOUR_LICENSE`' },
          { name: '2️⃣ Verify', value: 'Use `/verify` to link Roblox' },
          { name: '3️⃣ Security', value: 'Use `/backgroundcheck` on new members' },
          { name: '4️⃣ Points', value: 'Use `/addpoints` to reward members' }
        )
      ] 
    });
  }

  // ============ POINTS ============
  if (commandName === 'points') {
    const target = options.getUser('user') || user;
    const res = await pool.query(
      'SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', 
      [guildId, target.id]
    );
    const pts = res.rows.length > 0 ? res.rows[0].points : 0;
    
    return interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('💰 Points')
        .setDescription(`${target} has **${pts}** points`)
      ] 
    });
  }

  // ============ ADD POINTS ============
  if (commandName === 'addpoints') {
    const target = options.getUser('user');
    const amount = options.getInteger('amount');
    const reason = options.getString('reason') || 'No reason';
    
    await pool.query(
      'INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (guild_id, user_id) DO UPDATE SET points = user_points.points + $3', 
      [guildId, target.id, amount]
    );
    
    return interaction.reply({ 
      content: `✅ Added **${amount}** points to ${target}!\nReason: ${reason}` 
    });
  }

  // ============ REMOVE POINTS ============
  if (commandName === 'removepoints') {
    const target = options.getUser('user');
    const amount = options.getInteger('amount');
    
    await pool.query(
      'UPDATE user_points SET points = GREATEST(0, points - $1) ' +
      'WHERE guild_id = $2 AND user_id = $3', 
      [amount, guildId, target.id]
    );
    
    return interaction.reply({ 
      content: `✅ Removed **${amount}** points from ${target}` 
    });
  }

  // ============ LEADERBOARD ============
  if (commandName === 'leaderboard') {
    const res = await pool.query(
      'SELECT user_id, points FROM user_points WHERE guild_id = $1 ORDER BY points DESC LIMIT 10', 
      [guildId]
    );
    
    if (res.rows.length === 0) {
      return interaction.reply('📋 No leaderboard data yet!');
    }
    
    const leaderboard = res.rows.map((r, i) => 
      `${i + 1}. <@${r.user_id}> - **${r.points}** points`
    ).join('\n');
    
    return interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🏆 Points Leaderboard')
        .setDescription(leaderboard)
      ] 
    });
  }

  // ============ BACKGROUND CHECK ============
  if (commandName === 'backgroundcheck') {
    await interaction.deferReply();
    
    const target = options.getUser('user');
    
    try {
      // Get verified user
      const verifiedUser = await pool.query(
        'SELECT * FROM verified_users WHERE guild_id = $1 AND user_id = $2', 
        [guildId, target.id]
      );
      
      if (verifiedUser.rows.length === 0) {
        return interaction.editReply('❌ User not verified!');
      }
      
      const robloxId = verifiedUser.rows[0].roblox_id;
      const robloxUsername = verifiedUser.rows[0].roblox_username;
      
      // Get Roblox info
      const robloxInfo = await getRobloxUserInfo(robloxId);
      
      if (!robloxInfo) {
        return interaction.editReply('❌ Could not fetch Roblox data!');
      }
      
      // Get badges
      const badgesRes = await axios.get(`https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100`);
      const badgeCount = badgesRes.data.data?.length || 0;
      
      // Get friends
      const friendsRes = await axios.get(`https://friends.roblox.com/v1/users/${robloxId}/friends/count`);
      const friendCount = friendsRes.data.count || 0;
      
      // Calculate account age
      const createdDate = new Date(robloxInfo.created);
      const accountAgeDays = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
      
      // Check premium
      const hasPremium = robloxInfo.isPremium || false;
      const hasVerifiedBadge = robloxInfo.hasVerifiedBadge || false;
      
      // Calculate risk
      const riskScore = calculateRiskScore(accountAgeDays, badgeCount, friendCount, hasVerifiedBadge, hasPremium);
      const riskLevel = getRiskLevel(riskScore);
      
      // Check XTracker
      const xtrackerResult = await checkXTracker(robloxId);
      
      // Save to database
      await pool.query(
        'INSERT INTO background_checks (guild_id, user_id, roblox_id, roblox_username, risk_score, risk_level, account_age_days, has_premium, total_badges, total_friends) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', 
        [guildId, target.id, robloxId, robloxUsername, riskScore, riskLevel, accountAgeDays, hasPremium, badgeCount, friendCount]
      );
      
      // Build embed
      const riskColor = riskLevel === 'CRITICAL' ? '#FF0000' : riskLevel === 'HIGH' ? '#FFA500' : riskLevel === 'MEDIUM' ? '#FFFF00' : '#00FF00';
      
      const embed = new EmbedBuilder()
        .setColor(riskColor)
        .setTitle('🔍 Background Check Results')
        .setDescription(`**User:** ${target}\n**Roblox:** ${robloxUsername} (${robloxId})`)
        .addFields(
          { name: '⚠️ Risk Level', value: `**${riskLevel}** (Score: ${riskScore}/10)`, inline: true },
          { name: '📅 Account Age', value: `${accountAgeDays} days`, inline: true },
          { name: '🎖️ Badges', value: `${badgeCount}`, inline: true },
          { name: '👥 Friends', value: `${friendCount}`, inline: true },
          { name: '💎 Premium', value: hasPremium ? 'Yes' : 'No', inline: true },
          { name: '✅ Verified', value: hasVerifiedBadge ? 'Yes' : 'No', inline: true },
          { name: '🚨 XTracker', value: xtrackerResult.flagged ? '**FLAGGED AS EXPLOITER**' : 'Clean', inline: false }
        )
        .setFooter({ text: 'Risk calculated based on account age, activity, and XTracker data' })
        .setTimestamp();
      
      return interaction.editReply({ embeds: [embed] });
      
    } catch (error) {
      console.error('Background check error:', error);
      return interaction.editReply(`❌ Background check failed: ${error.message}`);
    }
  }

  // ============ XTRACKER ============
  if (commandName === 'xtracker') {
    await interaction.deferReply();
    
    const robloxId = options.getInteger('roblox_id');
    
    try {
      const result = await checkXTracker(robloxId);
      
      // Cache result
      await pool.query(
        'INSERT INTO xtracker_cache (roblox_user_id, is_flagged, exploit_data) ' +
        'VALUES ($1, $2, $3) ' +
        'ON CONFLICT (roblox_user_id) DO UPDATE SET is_flagged = $2, exploit_data = $3, last_checked = NOW()', 
        [robloxId, result.flagged, JSON.stringify(result.data)]
      );
      
      const embed = new EmbedBuilder()
        .setColor(result.flagged ? '#FF0000' : '#00FF00')
        .setTitle('🔎 XTracker Check')
        .setDescription(`**Roblox ID:** ${robloxId}`)
        .addFields({
          name: 'Status',
          value: result.flagged ? '🚨 **FLAGGED AS EXPLOITER**' : '✅ **CLEAN**'
        })
        .setTimestamp();
      
      return interaction.editReply({ embeds: [embed] });
      
    } catch (error) {
      console.error('XTracker error:', error);
      return interaction.editReply('❌ XTracker check failed!');
    }
  }

  // ============ BLACKLIST ============
  if (commandName === 'blacklist') {
    const robloxId = options.getInteger('roblox_id');
    const reason = options.getString('reason');
    
    await pool.query(
      'INSERT INTO blacklisted_users (guild_id, roblox_user_id, reason) VALUES ($1, $2, $3)', 
      [guildId, robloxId, reason]
    );
    
    return interaction.reply({ 
      content: `🚫 Blacklisted Roblox ID **${robloxId}**\nReason: ${reason}` 
    });
  }

  // ============ UNBLACKLIST ============
  if (commandName === 'unblacklist') {
    const robloxId = options.getInteger('roblox_id');
    
    await pool.query(
      'DELETE FROM blacklisted_users WHERE guild_id = $1 AND roblox_user_id = $2', 
      [guildId, robloxId]
    );
    
    return interaction.reply({ 
      content: `✅ Removed Roblox ID **${robloxId}** from blacklist` 
    });
  }

  // ============ VIEW BLACKLIST ============
  if (commandName === 'viewblacklist') {
    const res = await pool.query(
      'SELECT roblox_user_id, reason FROM blacklisted_users WHERE guild_id = $1 LIMIT 20', 
      [guildId]
    );
    
    if (res.rows.length === 0) {
      return interaction.reply('📋 Blacklist is empty!');
    }
    
    const list = res.rows.map(r => 
      `**${r.roblox_user_id}**: ${r.reason}`
    ).join('\n');
    
    return interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setTitle('🚫 Server Blacklist')
        .setDescription(list)
        .setColor('#FF0000')
      ] 
    });
  }

  // ============ KICK ============
  if (commandName === 'kick') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'No reason';
    
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
      return interaction.reply({ 
        content: `👢 Kicked ${target}\nReason: ${reason}` 
      });
    } catch (error) {
      return interaction.reply({ 
        content: '❌ Cannot kick this user!', 
        ephemeral: true 
      });
    }
  }

  // ============ BAN ============
  if (commandName === 'ban') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'No reason';
    
    try {
      await interaction.guild.members.ban(target, { reason });
      return interaction.reply({ 
        content: `🔨 Banned ${target}\nReason: ${reason}` 
      });
    } catch (error) {
      return interaction.reply({ 
        content: '❌ Cannot ban this user!', 
        ephemeral: true 
      });
    }
  }

  // ============ WARN ============
  if (commandName === 'warn') {
    const target = options.getUser('user');
    const reason = options.getString('reason');
    
    await pool.query(
      'INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES ($1, $2, $3, $4)', 
      [guildId, target.id, user.id, reason]
    );
    
    return interaction.reply({ 
      content: `⚠️ Warned ${target}\nReason: ${reason}` 
    });
  }
});

// ============================================
// OAUTH CALLBACK
// ============================================
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const pending = pendingVerifications.get(state);
  
  if (!pending) {
    return res.send('❌ Invalid or expired verification request');
  }
  
  try {
    // Exchange code for token
    const tokenResponse = await axios.post(
      'https://apis.roblox.com/oauth/v1/token',
      `client_id=${ROBLOX_CLIENT_ID}&client_secret=${ROBLOX_CLIENT_SECRET}&grant_type=authorization_code&code=${code}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    
    // Get user info
    const userResponse = await axios.get(
      'https://apis.roblox.com/oauth/v1/userinfo',
      { headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` } }
    );
    
    const { sub: robloxId, preferred_username: robloxUsername } = userResponse.data;
    
    // Save to database
    await pool.query(
      'INSERT INTO verified_users (user_id, guild_id, roblox_id, roblox_username) ' +
      'VALUES ($1, $2, $3, $4) ' +
      'ON CONFLICT (guild_id, user_id) DO UPDATE SET roblox_id = $3, roblox_username = $4', 
      [pending.userId, pending.guildId, robloxId, robloxUsername]
    );
    
    // Initialize points
    await pool.query(
      'INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, 0) ' +
      'ON CONFLICT (guild_id, user_id) DO NOTHING', 
      [pending.guildId, pending.userId]
    );
    
    pendingVerifications.delete(state);
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Verified!</title>
        <style>
          body { font-family: Arial; text-align: center; padding: 50px; background: #2c2f33; color: white; }
          h1 { color: #43b581; }
        </style>
      </head>
      <body>
        <h1>✅ Verification Successful!</h1>
        <p>You've been verified as <strong>${robloxUsername}</strong>!</p>
        <p>You can close this window now.</p>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('OAuth error:', error);
    res.send('❌ Verification error. Please try again.');
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.send('🤖 RoNexus Bot is running!');
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`🌐 OAuth server running on port ${PORT}`);
});

// Keep alive
setInterval(() => {
  console.log('🔄 Bot heartbeat');
}, 300000);

// ============================================
// LOGIN
// ============================================
client.login(process.env.DISCORD_TOKEN);
