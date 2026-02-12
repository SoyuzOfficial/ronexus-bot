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
const XTRACKER_API_KEY = process.env.XTRACKER_API_KEY;

const pendingVerifications = new Map();
const AUTO_BLACKLIST_GROUPS = [35367142, 35447047, 35163259, 35361192, 14000981, 14680340];

// ============================================
// AUTO-CREATE TABLES
// ============================================
async function ensureTablesExist() {
  try {
    console.log('🔧 Creating tables...');
    
    // Create all tables with proper columns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id SERIAL PRIMARY KEY,
        license_key VARCHAR(50) UNIQUE NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS guild_licenses (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) UNIQUE NOT NULL,
        license_key VARCHAR(50) NOT NULL,
        activated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id VARCHAR(20) PRIMARY KEY,
        verified_role_id VARCHAR(20),
        rank_abbreviation VARCHAR(10)
      );
      
      -- Ensure rank_abbreviation column exists (for existing databases)
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='guild_config' AND column_name='rank_abbreviation'
        ) THEN
          ALTER TABLE guild_config ADD COLUMN rank_abbreviation VARCHAR(10);
        END IF;
      END $$;
      
      CREATE TABLE IF NOT EXISTS verified_users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20) NOT NULL,
        guild_id VARCHAR(20) NOT NULL,
        roblox_id VARCHAR(20) NOT NULL,
        roblox_username VARCHAR(50) NOT NULL,
        verified_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(guild_id, user_id)
      );
      
      CREATE TABLE IF NOT EXISTS user_points (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        points INT DEFAULT 0,
        UNIQUE(guild_id, user_id)
      );
      
      CREATE TABLE IF NOT EXISTS ranks (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        rank_name VARCHAR(100) NOT NULL,
        role_id VARCHAR(20) NOT NULL,
        points_required INT NOT NULL,
        rank_order INT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS roblox_groups (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        group_id BIGINT NOT NULL,
        api_key TEXT NOT NULL,
        auto_rank_enabled BOOLEAN DEFAULT TRUE
      );
      
      CREATE TABLE IF NOT EXISTS group_rank_mapping (
        id SERIAL PRIMARY KEY,
        roblox_group_id INT NOT NULL,
        discord_role_id VARCHAR(20) NOT NULL,
        roblox_rank_id INT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS blacklisted_users (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        roblox_user_id VARCHAR(20) NOT NULL,
        roblox_username VARCHAR(50) NOT NULL,
        reason TEXT NOT NULL,
        blacklisted_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS blacklisted_groups (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        group_id BIGINT NOT NULL,
        group_name VARCHAR(255),
        reason TEXT NOT NULL,
        blacklisted_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS warnings (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        moderator_id VARCHAR(20) NOT NULL,
        reason TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW(),
        active BOOLEAN DEFAULT TRUE
      );
      
      CREATE TABLE IF NOT EXISTS background_checks (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        roblox_id VARCHAR(20) NOT NULL,
        roblox_username VARCHAR(50) NOT NULL,
        risk_score INT NOT NULL,
        risk_level VARCHAR(20) NOT NULL,
        account_age_days INT NOT NULL,
        has_premium BOOLEAN DEFAULT FALSE,
        total_badges INT DEFAULT 0,
        total_friends INT DEFAULT 0,
        checked_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS xtracker_cache (
        id SERIAL PRIMARY KEY,
        roblox_user_id VARCHAR(20) UNIQUE NOT NULL,
        is_flagged BOOLEAN DEFAULT FALSE,
        exploit_data JSONB,
        last_checked TIMESTAMP DEFAULT NOW()
      );
    `);
    
    // Insert default free license if not exists
    await pool.query(`
      INSERT INTO licenses (license_key, is_active) 
      VALUES ('RNEX-FREE-2024', true) 
      ON CONFLICT (license_key) DO NOTHING
    `);
    
    console.log('✅ Tables ready!');
  } catch (e) {
    console.error('❌ Table error:', e.message);
  }
}

// ============================================
// HELPERS
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

async function getUserGroups(userId) {
  try {
    const res = await axios.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
    return res.data.data || [];
  } catch (e) {
    return [];
  }
}

async function getUserGamePasses(userId) {
  try {
    // Try to get game passes from user's inventory
    // Note: This endpoint might require authentication in some cases
    const res = await axios.get(`https://inventory.roblox.com/v1/users/${userId}/items/GamePass?limit=100&sortOrder=Desc`);
    return res.data.data || [];
  } catch (e) {
    // If that fails, try the games API to see what games they've created/own
    try {
      const gamesRes = await axios.get(`https://games.roblox.com/v2/users/${userId}/games?limit=50`);
      return gamesRes.data.data || [];
    } catch (e2) {
      console.error('GamePass API error:', e2.message);
      return [];
    }
  }
}

async function getAllBadges(userId) {
  try {
    let allBadges = [];
    let cursor = '';
    
    while (true) {
      const url = cursor 
        ? `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&cursor=${cursor}`
        : `https://badges.roblox.com/v1/users/${userId}/badges?limit=100`;
      
      const res = await axios.get(url);
      allBadges = allBadges.concat(res.data.data || []);
      
      if (!res.data.nextPageCursor) break;
      cursor = res.data.nextPageCursor;
      
      if (allBadges.length > 5000) break;
    }
    
    return allBadges.length;
  } catch (e) {
    return 0;
  }
}

async function checkPremium(userId) {
  try {
    const res = await axios.get(`https://premiumfeatures.roblox.com/v1/users/${userId}/validate-membership`);
    return res.data === true;
  } catch (e) {
    return false;
  }
}

async function detectAlts(userId, accountAgeDays) {
  const isAlt = accountAgeDays < 30;
  return {
    isLikelyAlt: isAlt,
    reason: isAlt ? 'Account < 30 days old' : 'Account age normal',
    confidence: isAlt ? 'medium' : 'low'
  };
}

function calculateRiskScore(accountAgeDays, badges, friends, hasVerifiedBadge, hasPremium, inBlacklistedGroup) {
  let score = 0;
  if (inBlacklistedGroup) score += 10;
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
    let XTRACKER_API_KEY= "A-icVR0g6qaEi1EgTYd-TQ"
  if (!XTRACKER_API_KEY) {
    return { flagged: false, confidence: 'no-api-key', reason: 'XTracker API key not set', ownership: [] };
  }
  
  try {
    let isFlagged = false;
    let cheats = [];
    let reason = 'Clean - Not in XTracker database';
    
    // Check registry
    try {
      const registryRes = await axios.get(`https://api.xtracker.xyz/api/registry/user?id=${robloxId}`, {
        headers: { 'Authorization': XTRACKER_API_KEY },
        timeout: 5000
      });
      
      if (registryRes.data && registryRes.data.evidence && registryRes.data.evidence.length > 0) {
        isFlagged = true;
        const evidenceReasons = registryRes.data.evidence.map(e => e.reason).join(', ');
        reason = `Flagged in XTracker registry - Evidence: ${evidenceReasons}`;
      }
    } catch (regError) {
      if (regError.response && regError.response.status !== 404) {
        console.error('XTracker registry:', regError.message);
      }
    }
    
    // Check ownership
    try {
      const ownershipRes = await axios.get(`https://api.xtracker.xyz/api/ownership/user?id=${robloxId}`, {
        headers: { 'Authorization': XTRACKER_API_KEY },
        timeout: 5000
      });
      
      if (ownershipRes.data && ownershipRes.data.owns_cheats) {
        isFlagged = true;
        cheats = ownershipRes.data.cheats || [];
        reason = `Owns exploits: ${cheats.join(', ')}`;
      }
    } catch (ownError) {
      if (ownError.response && ownError.response.status !== 404) {
        console.error('XTracker ownership:', ownError.message);
      }
    }
    
    return { 
      flagged: isFlagged,
      confidence: isFlagged ? 'high' : 'clean',
      reason: reason,
      ownership: cheats
    };
    
  } catch (e) {
    return { 
      flagged: false, 
      confidence: 'error', 
      reason: `API error: ${e.message}`, 
      ownership: [] 
    };
  }
}


async function setRobloxGroupRank(groupId, robloxUserId, roleId, apiKey) {
  try {
    await axios.patch(
      `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${robloxUserId}`,
      { role: `groups/${groupId}/roles/${roleId}` },
      { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch (e) {
    console.error('❌ Roblox rank error:', e.response?.data || e.message);
    return false;
  }
}

async function updateNickname(guild, userId, robloxUsername, abbreviation = null) {
  try {
    const member = await guild.members.fetch(userId);
    const nickname = abbreviation ? `[${abbreviation}] ${robloxUsername}` : robloxUsername;
    await member.setNickname(nickname);
    return true;
  } catch (e) {
    console.error('❌ Nickname error:', e.message);
    return false;
  }
}

async function giveVerifiedRole(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    let verifiedRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'verified');
    
    if (!verifiedRole) {
      verifiedRole = await guild.roles.create({
        name: 'Verified',
        color: '#00FF00',
        reason: 'Auto-created by RoNexus'
      });
    }
    
    await member.roles.add(verifiedRole);
    return true;
  } catch (e) {
    console.error('❌ Verified role error:', e.message);
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
        
        // Check for Roblox group sync
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
              const success = await setRobloxGroupRank(
                group.group_id,
                verified.rows[0].roblox_id,
                mapping.rows[0].roblox_rank_id,
                group.api_key
              );
              
              if (success) {
                console.log(`✅ Promoted ${userId} to rank ${mapping.rows[0].roblox_rank_id} in group ${group.group_id}`);
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('❌ Auto-promote error:', e.message);
  }
}

// ============================================
// BOT READY
// ============================================
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  await ensureTablesExist();
  
  const commands = [
    { name: 'activate', description: 'Activate bot', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
    { name: 'verify', description: 'Verify Roblox account' },
    { name: 'setup', description: 'Setup guide', default_member_permissions: '8' },
    
    // Config - MERGED setabbreviation into addrank
    { name: 'addgroup', description: 'Add Roblox group', default_member_permissions: '8', options: [
      { name: 'group_id', description: 'Roblox group ID', type: 4, required: true }, 
      { name: 'api_key', description: 'Open Cloud API key', type: 3, required: true }
    ]},
    { name: 'maprank', description: 'Map Discord role to Roblox rank', default_member_permissions: '8', options: [
      { name: 'discord_role', description: 'Discord role', type: 8, required: true }, 
      { name: 'roblox_rank_id', description: 'Roblox rank ID', type: 4, required: true }
    ]},
    { name: 'addrank', description: 'Add points-based rank', default_member_permissions: '8', options: [
      { name: 'role', description: 'Discord role', type: 8, required: true }, 
      { name: 'points', description: 'Points required', type: 4, required: true }, 
      { name: 'name', description: 'Rank name', type: 3, required: true },
      { name: 'abbreviation', description: 'Prefix (e.g. CD, EX) - sets for entire server', type: 3, required: false }
    ]},
    { name: 'removeabbreviation', description: 'Remove rank prefix', default_member_permissions: '8' },
    
    // Points
    { name: 'points', description: 'Check points', options: [{ name: 'user', description: 'Username or @user', type: 3 }] },
    { name: 'addpoints', description: 'Add points', default_member_permissions: '8', options: [
      { name: 'user', description: 'Username or @user', type: 3, required: true }, 
      { name: 'amount', description: 'Amount', type: 4, required: true }, 
      { name: 'reason', description: 'Reason', type: 3 }
    ]},
    { name: 'removepoints', description: 'Remove points', default_member_permissions: '8', options: [
      { name: 'user', description: 'Username or @user', type: 3, required: true }, 
      { name: 'amount', description: 'Amount', type: 4, required: true }
    ]},
    { name: 'leaderboard', description: 'Points leaderboard' },
    
    // Security
    { name: 'bgcheck', description: 'Background check', options: [{ name: 'username', description: 'Roblox username or @user', type: 3, required: true }] },
    
    // Blacklist
    { name: 'blacklist-user', description: 'Blacklist user', default_member_permissions: '8', options: [
      { name: 'roblox_username', description: 'Username', type: 3, required: true }, 
      { name: 'reason', description: 'Reason', type: 3, required: true }
    ]},
    { name: 'blacklist-group', description: 'Blacklist group', default_member_permissions: '8', options: [
      { name: 'group_id', description: 'Group ID', type: 4, required: true }, 
      { name: 'reason', description: 'Reason', type: 3, required: true }
    ]},
    { name: 'unblacklist-user', description: 'Remove user blacklist', default_member_permissions: '8', options: [
      { name: 'roblox_username', description: 'Username', type: 3, required: true }
    ]},
    { name: 'unblacklist-group', description: 'Remove group blacklist', default_member_permissions: '8', options: [
      { name: 'group_id', description: 'Group ID', type: 4, required: true }
    ]},
    { name: 'viewblacklist', description: 'View blacklists' },
    
    // Moderation
    { name: 'viewwarns', description: 'View warnings', options: [{ name: 'user', description: '@user', type: 6, required: true }] },
    { name: 'kick', description: 'Kick', default_member_permissions: '2', options: [
      { name: 'user', description: '@user', type: 6, required: true }, 
      { name: 'reason', description: 'Reason', type: 3 }
    ]},
    { name: 'ban', description: 'Ban', default_member_permissions: '4', options: [
      { name: 'user', description: '@user', type: 6, required: true }, 
      { name: 'reason', description: 'Reason', type: 3 }
    ]},
    { name: 'warn', description: 'Warn', default_member_permissions: '8', options: [
      { name: 'user', description: '@user', type: 6, required: true }, 
      { name: 'reason', description: 'Reason', type: 3, required: true }
    ]}
  ];

  await client.application.commands.set(commands);
  console.log('✅ Commands registered!');
});

// ============================================
// INTERACTIONS
// ============================================
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    const [action, robloxId] = interaction.customId.split('_');
    
    if (action === 'xtracker') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const result = await checkXTracker(robloxId);
        await pool.query(
          'INSERT INTO xtracker_cache (roblox_user_id, is_flagged, exploit_data) VALUES ($1, $2, $3) ON CONFLICT (roblox_user_id) DO UPDATE SET is_flagged = $2, exploit_data = $3, last_checked = NOW()', 
          [robloxId, result.flagged, JSON.stringify(result)]
        );
        
        const embed = new EmbedBuilder()
          .setColor(result.flagged ? '#FF0000' : '#00FF00')
          .setTitle('🔎 XTracker Check')
          .setDescription(`**Roblox ID:** ${robloxId}`)
          .addFields(
            { name: 'Status', value: result.flagged ? '🚨 **FLAGGED**' : '✅ **CLEAN**', inline: true },
            { name: 'Confidence', value: result.confidence, inline: true },
            { name: 'Details', value: result.reason, inline: false }
          );
        
        if (result.ownership && result.ownership.length > 0) {
          embed.addFields({ name: 'Owned Exploits', value: result.ownership.join(', '), inline: false });
        }
        
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }
    
    if (action === 'groups') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const userGroups = await getUserGroups(robloxId);
        
        if (userGroups.length === 0) {
          return interaction.editReply({ content: '📋 User is not in any groups!' });
        }
        
        const groupList = userGroups.slice(0, 20).map(g => 
          `• **${g.group.name}** (${g.group.id})\n  Role: ${g.role.name} (Rank ${g.role.rank})`
        ).join('\n\n');
        
        const embed = new EmbedBuilder()
          .setColor('#0099ff')
          .setTitle('👥 User Groups')
          .setDescription(`**Roblox ID:** ${robloxId}\n\n${groupList}`)
          .setFooter({ text: `Showing ${Math.min(userGroups.length, 20)} of ${userGroups.length} groups` });
        
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }
    
    if (action === 'gamepasses') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const gamepasses = await getUserGamePasses(robloxId);
        
        if (gamepasses.length === 0) {
          return interaction.editReply({ content: '📋 No gamepasses or games found for this user!' });
        }
        
        // Check if it's gamepasses or games data
        const isGames = gamepasses[0] && gamepasses[0].name && !gamepasses[0].assetId;
        
        let gpList;
        if (isGames) {
          // It's games data
          gpList = gamepasses.slice(0, 20).map(gp => 
            `• **${gp.name}**\n   Place ID: ${gp.id || 'N/A'}`
          ).join('\n');
        } else {
          // It's gamepasses data
          gpList = gamepasses.slice(0, 20).map(gp => 
            `• **${gp.name}** (${gp.assetId || gp.id})`
          ).join('\n');
        }
        
        const embed = new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle(isGames ? '🎮 User Games' : '🎫 User GamePasses')
          .setDescription(`**Roblox ID:** ${robloxId}\n**Total:** ${gamepasses.length}\n\n${gpList}`)
          .setFooter({ text: `Showing ${Math.min(gamepasses.length, 20)} of ${gamepasses.length} items` });
        
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        console.error('GamePasses error:', e);
        return interaction.editReply({ content: `❌ Unable to fetch gamepasses/games data` });
      }
    }
    
    if (action === 'friends') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        // Get friends with pagination up to 1000
        let allFriends = [];
        let cursor = '';
        
        while (allFriends.length < 1000) {
          const url = cursor 
            ? `https://friends.roblox.com/v1/users/${robloxId}/friends?cursor=${cursor}`
            : `https://friends.roblox.com/v1/users/${robloxId}/friends`;
          
          const friendsRes = await axios.get(url);
          const friends = friendsRes.data.data || [];
          
          allFriends = allFriends.concat(friends);
          
          if (!friendsRes.data.nextPageCursor || friends.length === 0) break;
          cursor = friendsRes.data.nextPageCursor;
        }
        
        if (allFriends.length === 0) {
          return interaction.editReply({ content: '📋 User has no friends!' });
        }
        
        // Show first 50 friends with total count
        const friendList = allFriends.slice(0, 50).map(f => 
          `• **${f.name}** (${f.id})`
        ).join('\n');
        
        const embed = new EmbedBuilder()
          .setColor('#9B59B6')
          .setTitle('👥 Additional Information - Friends')
          .setDescription(`**Roblox ID:** ${robloxId}\n**Total Friends:** ${allFriends.length}\n\n${friendList}`)
          .setFooter({ text: `Showing 50 of ${allFriends.length} friends (Max: 1000)` });
        
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }
    
    if (action === 'badges') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        // Get all badges with pagination up to 10,000
        let allBadges = [];
        let cursor = '';
        
        while (allBadges.length < 10000) {
          const url = cursor 
            ? `https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100&cursor=${cursor}`
            : `https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100`;
          
          const res = await axios.get(url);
          const badges = res.data.data || [];
          
          allBadges = allBadges.concat(badges);
          
          if (!res.data.nextPageCursor || badges.length === 0) break;
          cursor = res.data.nextPageCursor;
        }
        
        if (allBadges.length === 0) {
          return interaction.editReply({ content: '📋 User has no badges!' });
        }
        
        // Show first 100 badges in a scrollable list
        const badgeList = allBadges.slice(0, 100).map((b, i) => 
          `${i + 1}. **${b.name}**\n   From: ${b.displayName || 'Unknown Game'}`
        ).join('\n');
        
        const embed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('🎖️ User Badges')
          .setDescription(`**Roblox ID:** ${robloxId}\n**Total Badges:** ${allBadges.length}\n\n${badgeList}`)
          .setFooter({ text: `Showing 100 of ${allBadges.length} badges (Max: 10,000)` });
        
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }
    
    return;
  }

  if (!interaction.isCommand()) return;
  
  const { commandName, guildId, user, options } = interaction;

  if (commandName === 'activate') {
    const license = options.getString('license');
    try {
      const licCheck = await pool.query('SELECT * FROM licenses WHERE license_key = $1 AND is_active = true', [license]);
      if (licCheck.rows.length === 0) return interaction.reply({ content: '❌ Invalid license!', ephemeral: true });
      
      const guildCheck = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (guildCheck.rows.length > 0) return interaction.reply({ content: '✅ Already activated!', ephemeral: true });
      
      await pool.query('INSERT INTO guild_licenses (guild_id, license_key) VALUES ($1, $2)', [guildId, license]);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Activated!')
        .setDescription('**Next steps:**\n• `/verify` - Verify Roblox\n• `/addgroup GROUP_ID API_KEY` - Connect Roblox group\n• `/addrank @Role 100 "Member" CD` - Add rank with prefix')
      ]});
    } catch (e) { 
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); 
    }
  }

  const activated = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
  if (activated.rows.length === 0 && commandName !== 'activate') {
    return interaction.reply({ content: '❌ Not activated! Use `/activate RNEX-FREE-2024`', ephemeral: true });
  }

  if (commandName === 'verify') {
    const state = `${guildId}_${user.id}_${Date.now()}`;
    pendingVerifications.set(state, { guildId, userId: user.id });
    const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=openid%20profile&response_type=code&state=${state}`;
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('🔗 Verify with Roblox')
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl)
    );
    return interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🔐 Verify Your Account')
        .setDescription('Click the button below to verify with Roblox!')
      ], 
      components: [btn], 
      ephemeral: true 
    });
  }

  if (commandName === 'setup') {
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('⚙️ RoNexus Setup Guide')
      .addFields(
        { name: '1️⃣ Get Roblox API Key', value: '• Go to: https://create.roblox.com/credentials\n• Create Open Cloud API key\n• Select your group\n• Give it `group.member` permission\n• Copy the key' },
        { name: '2️⃣ Add Your Group', value: '`/addgroup GROUP_ID YOUR_API_KEY`' },
        { name: '3️⃣ Map Ranks', value: '`/maprank @DiscordRole ROBLOX_RANK_ID`' },
        { name: '4️⃣ Add Point Ranks', value: '`/addrank @Role 100 "Member" CD`\n(CD is the prefix like [CD])' },
        { name: '5️⃣ Verify Members', value: '`/verify` - Members verify Roblox' }
      )
    ]});
  }

  if (commandName === 'addrank') {
    const role = options.getRole('role');
    const points = options.getInteger('points');
    const name = options.getString('name');
    const abbreviation = options.getString('abbreviation');
    
    const order = await pool.query('SELECT COUNT(*) FROM ranks WHERE guild_id = $1', [guildId]);
    await pool.query(
      'INSERT INTO ranks (guild_id, rank_name, role_id, points_required, rank_order) VALUES ($1, $2, $3, $4, $5)', 
      [guildId, name, role.id, points, parseInt(order.rows[0].count) + 1]
    );
    
    // If abbreviation provided, set it for the entire guild
    if (abbreviation) {
      const abbr = abbreviation.toUpperCase().substring(0, 10);
      await pool.query(
        'INSERT INTO guild_config (guild_id, rank_abbreviation) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET rank_abbreviation = $2', 
        [guildId, abbr]
      );
      return interaction.reply({ 
        content: `✅ **${name}** (${points} pts) → ${role}\n✅ Prefix set to **[${abbr}]**\n\nVerified users will show as: **[${abbr}] Username**`, 
        ephemeral: true 
      });
    }
    
    return interaction.reply({ 
      content: `✅ **${name}** (${points} pts) → ${role}\n\nUsers auto-promote at ${points} points!`, 
      ephemeral: true 
    });
  }

  if (commandName === 'removeabbreviation') {
    await pool.query('UPDATE guild_config SET rank_abbreviation = NULL WHERE guild_id = $1', [guildId]);
    return interaction.reply({ content: '✅ Prefix removed\n\nVerified users will show as: **Username**', ephemeral: true });
  }

  if (commandName === 'addgroup') {
    const groupId = options.getInteger('group_id');
    const apiKey = options.getString('api_key');
    
    await pool.query(
      'INSERT INTO roblox_groups (guild_id, group_id, api_key, auto_rank_enabled) VALUES ($1, $2, $3, true)', 
      [guildId, groupId, apiKey]
    );
    return interaction.reply({ 
      content: `✅ Added group **${groupId}**!\n\n**Next:** Use \`/maprank @Role ROBLOX_RANK_ID\` to sync Discord roles with Roblox ranks`, 
      ephemeral: true 
    });
  }

  if (commandName === 'maprank') {
    const role = options.getRole('discord_role');
    const robloxRankId = options.getInteger('roblox_rank_id');
    
    const group = await pool.query('SELECT id FROM roblox_groups WHERE guild_id = $1 LIMIT 1', [guildId]);
    if (group.rows.length === 0) {
      return interaction.reply({ content: '❌ No Roblox groups added! Use `/addgroup` first.', ephemeral: true });
    }
    
    await pool.query(
      'INSERT INTO group_rank_mapping (roblox_group_id, discord_role_id, roblox_rank_id) VALUES ($1, $2, $3)', 
      [group.rows[0].id, role.id, robloxRankId]
    );
    return interaction.reply({ 
      content: `✅ Mapped ${role} ↔️ Roblox rank **${robloxRankId}**\n\nWhen users get this Discord role, they'll auto-rank in Roblox!`, 
      ephemeral: true 
    });
  }

  if (commandName === 'points') {
    const input = options.getString('user');
    let targetId = user.id;
    
    if (input) {
      const mention = input.match(/<@!?(\d+)>/);
      if (mention) {
        targetId = mention[1];
      } else {
        const verified = await pool.query(
          'SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', 
          [guildId, input]
        );
        if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
      }
    }
    
    const res = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    const pts = res.rows.length > 0 ? res.rows[0].points : 0;
    
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Points')
      .setDescription(`<@${targetId}> has **${pts}** points`)
    ]});
  }

  if (commandName === 'addpoints') {
    const input = options.getString('user');
    const amount = options.getInteger('amount');
    const reason = options.getString('reason') || 'No reason provided';
    
    let targetId = null;
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) {
      targetId = mention[1];
    } else {
      const verified = await pool.query(
        'SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', 
        [guildId, input]
      );
      if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
    }
    
    if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    
    await pool.query(
      'INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO UPDATE SET points = user_points.points + $3', 
      [guildId, targetId, amount]
    );
    
    const newPoints = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    await checkAndPromote(guildId, targetId, newPoints.rows[0].points);
    
    return interaction.reply({ 
      content: `✅ Added **+${amount}** points to <@${targetId}>!\n**Reason:** ${reason}\n**New Total:** ${newPoints.rows[0].points} points` 
    });
  }

  if (commandName === 'removepoints') {
    const input = options.getString('user');
    const amount = options.getInteger('amount');
    
    let targetId = null;
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) {
      targetId = mention[1];
    } else {
      const verified = await pool.query(
        'SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', 
        [guildId, input]
      );
      if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
    }
    
    if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    
    await pool.query(
      'UPDATE user_points SET points = GREATEST(0, points - $1) WHERE guild_id = $2 AND user_id = $3', 
      [amount, guildId, targetId]
    );
    
    return interaction.reply({ content: `✅ Removed **-${amount}** points from <@${targetId}>` });
  }

  if (commandName === 'leaderboard') {
    const res = await pool.query(
      'SELECT user_id, points FROM user_points WHERE guild_id = $1 ORDER BY points DESC LIMIT 10', 
      [guildId]
    );
    
    if (res.rows.length === 0) return interaction.reply('📋 No points data yet!');
    
    const lb = res.rows.map((r, i) => 
      `**${i + 1}.** <@${r.user_id}> - **${r.points}** points`
    ).join('\n');
    
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🏆 Points Leaderboard')
      .setDescription(lb)
    ]});
  }

  if (commandName === 'bgcheck') {
    await interaction.deferReply();
    
    const input = options.getString('username');
    let robloxId = null, robloxUsername = null;
    
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) {
      const verified = await pool.query(
        'SELECT roblox_id, roblox_username FROM verified_users WHERE guild_id = $1 AND user_id = $2', 
        [guildId, mention[1]]
      );
      if (verified.rows.length === 0) return interaction.editReply('❌ User not verified!');
      robloxId = verified.rows[0].roblox_id;
      robloxUsername = verified.rows[0].roblox_username;
    } else {
      const lookup = await getRobloxIdFromUsername(input);
      if (!lookup) return interaction.editReply('❌ Roblox user not found!');
      robloxId = lookup.id;
      robloxUsername = lookup.username;
    }
    
    try {
      const robloxInfo = await getRobloxUserInfo(robloxId);
      if (!robloxInfo) return interaction.editReply('❌ Failed to fetch user info!');
      
      const badgeCount = await getAllBadges(robloxId);
      const friendsRes = await axios.get(`https://friends.roblox.com/v1/users/${robloxId}/friends/count`);
      const friendCount = friendsRes.data.count || 0;
      const userGroups = await getUserGroups(robloxId);
      const groupIds = userGroups.map(g => g.group.id);
      
      const allBlacklistedGroups = [...AUTO_BLACKLIST_GROUPS];
      const manualBlacklist = await pool.query('SELECT group_id FROM blacklisted_groups WHERE guild_id = $1', [guildId]);
      manualBlacklist.rows.forEach(r => allBlacklistedGroups.push(parseInt(r.group_id)));
      
      const inBlacklistedGroup = groupIds.some(id => allBlacklistedGroups.includes(id));
      const blacklistedGroups = userGroups.filter(g => allBlacklistedGroups.includes(g.group.id));
      
      const createdDate = new Date(robloxInfo.created);
      const accountAgeDays = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
      
      const hasPremium = await checkPremium(robloxId);
      const hasVerifiedBadge = robloxInfo.hasVerifiedBadge || false;
      const altCheck = await detectAlts(robloxId, accountAgeDays);
      const riskScore = calculateRiskScore(accountAgeDays, badgeCount, friendCount, hasVerifiedBadge, hasPremium, inBlacklistedGroup);
      const riskLevel = getRiskLevel(riskScore);
      
      await pool.query(
        'INSERT INTO background_checks (guild_id, user_id, roblox_id, roblox_username, risk_score, risk_level, account_age_days, has_premium, total_badges, total_friends) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', 
        [guildId, mention ? mention[1] : 'manual', robloxId, robloxUsername, riskScore, riskLevel, accountAgeDays, hasPremium, badgeCount, friendCount]
      );
      
      const riskColor = riskLevel === 'CRITICAL' ? '#FF0000' : riskLevel === 'HIGH' ? '#FFA500' : riskLevel === 'MEDIUM' ? '#FFFF00' : '#00FF00';
      const embed = new EmbedBuilder()
        .setColor(riskColor)
        .setTitle('🔍 Background Check')
        .setDescription(`**${robloxUsername}** (${robloxId})`)
        .addFields(
          { name: '⚠️ Risk Level', value: `${riskLevel} (${riskScore}/10)`, inline: true },
          { name: '📅 Account Age', value: `${accountAgeDays} days`, inline: true },
          { name: '🎖️ Badges', value: `${badgeCount}`, inline: true },
          { name: '👥 Friends', value: `${friendCount}`, inline: true },
          { name: '💎 Premium', value: hasPremium ? '✅ Yes' : '❌ No', inline: true },
          { name: '✅ Verified Badge', value: hasVerifiedBadge ? '✅ Yes' : '❌ No', inline: true },
          { name: '🔄 Alt Detection', value: `${altCheck.isLikelyAlt ? '🚨 Likely Alt' : '✅ Normal'}\n${altCheck.reason}`, inline: false }
        );
      
      if (inBlacklistedGroup) {
        const groupList = blacklistedGroups.map(g => `• **${g.group.name}** (${g.group.id})`).join('\n');
        embed.addFields({ name: '🚨 BLACKLISTED GROUPS DETECTED', value: groupList });
      }
      
      embed.setFooter({ text: 'Click buttons below for more info' });
      
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`xtracker_${robloxId}`)
          .setLabel('🔎 XTracker')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`groups_${robloxId}`)
          .setLabel('👥 Groups')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`gamepasses_${robloxId}`)
          .setLabel('🎫 GamePasses')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`badges_${robloxId}`)
          .setLabel('🎖️ Badges')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`friends_${robloxId}`)
          .setLabel('👥 Friends')
          .setStyle(ButtonStyle.Secondary)
      );
      
      return interaction.editReply({ embeds: [embed], components: [buttons] });
    } catch (e) {
      console.error('❌ Background check error:', e);
      return interaction.editReply(`❌ Error: ${e.message}`);
    }
  }

  if (commandName === 'blacklist-user') {
    const username = options.getString('roblox_username');
    const reason = options.getString('reason');
    
    const lookup = await getRobloxIdFromUsername(username);
    if (!lookup) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    
    await pool.query(
      'INSERT INTO blacklisted_users (guild_id, roblox_user_id, roblox_username, reason) VALUES ($1, $2, $3, $4)', 
      [guildId, lookup.id, lookup.username, reason]
    );
    return interaction.reply({ content: `🚫 Blacklisted **${lookup.username}**\n**Reason:** ${reason}` });
  }

  if (commandName === 'blacklist-group') {
    const groupId = options.getInteger('group_id');
    const reason = options.getString('reason');
    
    try {
      const groupInfo = await axios.get(`https://groups.roblox.com/v1/groups/${groupId}`);
      await pool.query(
        'INSERT INTO blacklisted_groups (guild_id, group_id, group_name, reason) VALUES ($1, $2, $3, $4)', 
        [guildId, groupId, groupInfo.data.name, reason]
      );
      return interaction.reply({ content: `🚫 Blacklisted **${groupInfo.data.name}** (${groupId})\n**Reason:** ${reason}` });
    } catch (e) {
      return interaction.reply({ content: '❌ Invalid group ID!', ephemeral: true });
    }
  }

  if (commandName === 'unblacklist-user') {
    const username = options.getString('roblox_username');
    const lookup = await getRobloxIdFromUsername(username);
    if (!lookup) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    
    await pool.query('DELETE FROM blacklisted_users WHERE guild_id = $1 AND roblox_user_id = $2', [guildId, lookup.id]);
    return interaction.reply({ content: `✅ Removed **${lookup.username}** from blacklist` });
  }

  if (commandName === 'unblacklist-group') {
    const groupId = options.getInteger('group_id');
    await pool.query('DELETE FROM blacklisted_groups WHERE guild_id = $1 AND group_id = $2', [guildId, groupId]);
    return interaction.reply({ content: `✅ Removed group **${groupId}** from blacklist` });
  }

  if (commandName === 'viewblacklist') {
    const users = await pool.query('SELECT roblox_username, reason FROM blacklisted_users WHERE guild_id = $1 LIMIT 10', [guildId]);
    const groups = await pool.query('SELECT group_name, group_id, reason FROM blacklisted_groups WHERE guild_id = $1 LIMIT 10', [guildId]);
    
    const embed = new EmbedBuilder()
      .setTitle('🚫 Blacklist')
      .setColor('#FF0000');
    
    if (users.rows.length > 0) {
      const userList = users.rows.map(r => `• **${r.roblox_username}** - ${r.reason}`).join('\n');
      embed.addFields({ name: 'Blacklisted Users', value: userList });
    }
    
    if (groups.rows.length > 0) {
      const groupList = groups.rows.map(r => `• **${r.group_name}** (${r.group_id}) - ${r.reason}`).join('\n');
      embed.addFields({ name: 'Blacklisted Groups', value: groupList });
    }
    
    if (users.rows.length === 0 && groups.rows.length === 0) {
      return interaction.reply('📋 No blacklisted users or groups!');
    }
    
    embed.addFields({ 
      name: 'Auto-Blacklisted Groups', 
      value: '• Log4Shell (35367142)\n• qlz (35447047)\n• Chosen Twenty (35163259)\n• C20Ware (35361192)\n• Chosen 20 (14000981)\n• Chosen 20 uniforms (14680340)' 
    });
    
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'viewwarns') {
    const target = options.getUser('user');
    
    try {
      const warns = await pool.query(
        'SELECT reason, moderator_id, timestamp FROM warnings WHERE guild_id = $1 AND user_id = $2 AND active = true ORDER BY timestamp DESC LIMIT 10', 
        [guildId, target.id]
      );
      
      if (warns.rows.length === 0) {
        return interaction.reply({ content: `📋 ${target} has no active warnings!`, ephemeral: true });
      }
      
      const warnList = warns.rows.map((w, i) => 
        `**${i + 1}.** ${w.reason}\n• By: <@${w.moderator_id}>\n• ${new Date(w.timestamp).toLocaleDateString()}`
      ).join('\n\n');
      
      const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(`⚠️ Warnings for ${target.username}`)
        .setDescription(warnList)
        .setFooter({ text: `Total Active Warnings: ${warns.rows.length}` });
      
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
    }
  }

  if (commandName === 'kick') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'No reason provided';
    
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
      return interaction.reply({ content: `👢 Kicked ${target}\n**Reason:** ${reason}` });
    } catch (e) { 
      return interaction.reply({ content: '❌ Cannot kick this user!', ephemeral: true }); 
    }
  }

  if (commandName === 'ban') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'No reason provided';
    
    try {
      await interaction.guild.members.ban(target, { reason });
      return interaction.reply({ content: `🔨 Banned ${target}\n**Reason:** ${reason}` });
    } catch (e) { 
      return interaction.reply({ content: '❌ Cannot ban this user!', ephemeral: true }); 
    }
  }

  if (commandName === 'warn') {
    const target = options.getUser('user');
    const reason = options.getString('reason');
    
    try {
      await pool.query(
        'INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES ($1, $2, $3, $4)', 
        [guildId, target.id, user.id, reason]
      );
      return interaction.reply({ content: `⚠️ Warned ${target}\n**Reason:** ${reason}` });
    } catch (e) {
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
    }
  }
});

// ============================================
// OAUTH CALLBACK
// ============================================
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const pending = pendingVerifications.get(state);
  
  if (!pending) return res.send('❌ Invalid verification state');
  
  try {
    const tokenRes = await axios.post(
      'https://apis.roblox.com/oauth/v1/token', 
      `client_id=${ROBLOX_CLIENT_ID}&client_secret=${ROBLOX_CLIENT_SECRET}&grant_type=authorization_code&code=${code}`, 
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    
    const userRes = await axios.get('https://apis.roblox.com/oauth/v1/userinfo', { 
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } 
    });
    
    const { sub: robloxId, preferred_username: robloxUsername } = userRes.data;
    
    await pool.query(
      'INSERT INTO verified_users (user_id, guild_id, roblox_id, roblox_username) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO UPDATE SET roblox_id = $3, roblox_username = $4', 
      [pending.userId, pending.guildId, robloxId, robloxUsername]
    );
    
    await pool.query(
      'INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', 
      [pending.guildId, pending.userId]
    );
    
    const guild = client.guilds.cache.get(pending.guildId);
    if (guild) {
      // Ensure guild_config row exists first
      await pool.query(
        'INSERT INTO guild_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING',
        [pending.guildId]
      );
      
      // Get the rank abbreviation
      const configRes = await pool.query('SELECT rank_abbreviation FROM guild_config WHERE guild_id = $1', [pending.guildId]);
      const abbreviation = configRes.rows.length > 0 && configRes.rows[0].rank_abbreviation 
        ? configRes.rows[0].rank_abbreviation 
        : null;
      
      await updateNickname(guild, pending.userId, robloxUsername, abbreviation);
      await giveVerifiedRole(guild, pending.userId);
    }
    
    pendingVerifications.delete(state);
    
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>✅ Verified!</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      text-align: center;
      padding: 50px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      margin: 0;
    }
    h1 {
      color: #43b581;
      font-size: 48px;
      margin: 20px 0;
    }
    p {
      font-size: 18px;
      line-height: 1.6;
    }
    .success {
      background: rgba(67, 181, 129, 0.2);
      padding: 20px;
      border-radius: 10px;
      margin: 20px auto;
      max-width: 500px;
    }
  </style>
</head>
<body>
  <h1>✅ Verification Successful!</h1>
  <div class="success">
    <p><strong>Roblox Username:</strong> ${robloxUsername}</p>
    <p>Your Discord nickname has been updated!</p>
    <p>You've been given the Verified role!</p>
  </div>
  <p>You can close this page and return to Discord.</p>
</body>
</html>`);
  } catch (e) { 
    console.error('❌ OAuth error:', e);
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>❌ Verification Error</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      text-align: center;
      padding: 50px;
      background: #2c2f33;
      color: white;
    }
    h1 {
      color: #f04747;
    }
  </style>
</head>
<body>
  <h1>❌ Verification Failed</h1>
  <p>${e.message}</p>
  <p>Please try again or contact support.</p>
</body>
</html>`);
  }
});

app.get('/', (req, res) => res.send('🤖 RoNexus Bot Online!'));

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// Keep-alive ping
setInterval(() => {
  console.log('🔄 Keep-alive ping');
}, 300000);

client.login(process.env.DISCORD_TOKEN);
