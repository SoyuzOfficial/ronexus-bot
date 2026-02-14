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
        license_key VARCHAR(100) UNIQUE NOT NULL,
        whop_membership_id VARCHAR(100) UNIQUE,
        tier VARCHAR(20) NOT NULL DEFAULT 'starter',
        max_servers INT DEFAULT 1,
        max_groups INT DEFAULT 3,
        is_active BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS guild_licenses (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        license_key VARCHAR(100) NOT NULL,
        activated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(guild_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_license_key ON licenses(license_key);
      CREATE INDEX IF NOT EXISTS idx_whop_membership ON licenses(whop_membership_id);
      CREATE INDEX IF NOT EXISTS idx_guild_license ON guild_licenses(guild_id);
      
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

async function checkIfPrivateProfile(userId) {
  try {
    // Try to get inventory - if it fails with 401, account is private
    const res = await axios.get(`https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`);
    return res.data.canView === false;
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 403) {
      return true; // Private
    }
    return false; // Assume public if error
  }
}

async function getPreviousUsernames(userId) {
  try {
    // Try to get username history from the users endpoint
    // Note: Roblox removed public username history, so this might return empty
    // We'll try to get at least the display name if different
    const userRes = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
    const names = [];
    
    // Check if display name is different (this is the closest we can get)
    if (userRes.data.displayName && userRes.data.displayName !== userRes.data.name) {
      names.push(userRes.data.displayName);
    }
    
    // Try the games API which sometimes shows creator names
    try {
      const gamesRes = await axios.get(`https://games.roblox.com/v2/users/${userId}/games?limit=10`);
      if (gamesRes.data.data && gamesRes.data.data.length > 0) {
        gamesRes.data.data.forEach(game => {
          if (game.creator && game.creator.name && game.creator.name !== userRes.data.name) {
            if (!names.includes(game.creator.name)) {
              names.push(game.creator.name);
            }
          }
        });
      }
    } catch (e) {
      // Ignore games API errors
    }
    
    return names;
  } catch (e) {
    console.error('Previous usernames error:', e.message);
    return [];
  }
}

async function getProfilePicture(userId) {
  try {
    const res = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`);
    if (res.data.data && res.data.data.length > 0) {
      return res.data.data[0].imageUrl;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getUserGames(userId) {
  try {
    const res = await axios.get(`https://games.roblox.com/v2/users/${userId}/games?limit=50&sortOrder=Desc`);
    return res.data.data || [];
  } catch (e) {
    console.error('Games API error:', e.message);
    return [];
  }
}

async function getUserGamePasses(userId) {
  try {
    // Get user's game passes from inventory
    let allPasses = [];
    let cursor = '';
    
    while (allPasses.length < 100) {
      const url = cursor 
        ? `https://inventory.roblox.com/v1/users/${userId}/items/GamePass?limit=100&cursor=${cursor}`
        : `https://inventory.roblox.com/v1/users/${userId}/items/GamePass?limit=100`;
      
      const res = await axios.get(url);
      const passes = res.data.data || [];
      
      allPasses = allPasses.concat(passes);
      
      if (!res.data.nextPageCursor || passes.length === 0) break;
      cursor = res.data.nextPageCursor;
    }
    
    return allPasses;
  } catch (e) {
    console.error('GamePasses API error:', e.message);
    return [];
  }
}

async function getAllBadges(userId) {
  try {
    let allBadges = [];
    let cursor = '';
    let fetchCount = 0;
    const maxBadges = 10000; // Reasonable limit to avoid timeouts
    
    while (allBadges.length < maxBadges && fetchCount < 100) {
      const url = cursor 
        ? `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&cursor=${cursor}`
        : `https://badges.roblox.com/v1/users/${userId}/badges?limit=100`;
      
      try {
        const res = await axios.get(url, { timeout: 5000 });
        const badges = res.data.data || [];
        
        if (badges.length === 0) break;
        
        allBadges = allBadges.concat(badges);
        
        if (!res.data.nextPageCursor) break;
        cursor = res.data.nextPageCursor;
        
        fetchCount++;
      } catch (err) {
        console.error('Badge fetch error:', err.message);
        break;
      }
    }
    
    return allBadges.length;
  } catch (e) {
    console.error('getAllBadges error:', e.message);
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

async function detectAlts(userId, accountAgeDays, badges, friends, hasVerifiedBadge, hasPremium, inBlacklistedGroup) {
  let altScore = 0;
  let reasons = [];
  
  // Factor 1: Account age (0-40 points)
  if (accountAgeDays < 1) {
    altScore += 40;
    reasons.push('Brand new account (<1 day)');
  } else if (accountAgeDays < 7) {
    altScore += 30;
    reasons.push('Very new account (<7 days)');
  } else if (accountAgeDays < 30) {
    altScore += 20;
    reasons.push('New account (<30 days)');
  } else if (accountAgeDays < 90) {
    altScore += 10;
    reasons.push('Relatively new (<90 days)');
  }
  
  // Factor 2: Friend count (0-25 points)
  if (friends === 0) {
    altScore += 25;
    reasons.push('No friends');
  } else if (friends < 3) {
    altScore += 20;
    reasons.push('Very few friends');
  } else if (friends < 10) {
    altScore += 10;
    reasons.push('Low friend count');
  }
  
  // Factor 3: Badge count (0-20 points)
  if (badges === 0) {
    altScore += 20;
    reasons.push('No badges earned');
  } else if (badges < 5) {
    altScore += 15;
    reasons.push('Very few badges');
  } else if (badges < 20) {
    altScore += 8;
    reasons.push('Low badge count');
  }
  
  // Factor 4: Blacklisted group (instant red flag)
  if (inBlacklistedGroup) {
    altScore += 50;
    reasons.push('IN BLACKLISTED GROUP');
  }
  
  // Factor 5: Verified badge (reduces score)
  if (hasVerifiedBadge) {
    altScore -= 20;
    reasons.push('Has verified badge (legit)');
  }
  
  // Factor 6: Premium (reduces score)
  if (hasPremium) {
    altScore -= 15;
    reasons.push('Has premium (legit)');
  }
  
  // Ensure score is between 0-100
  altScore = Math.max(0, Math.min(100, altScore));
  
  // Determine confidence level
  let confidence;
  let isLikelyAlt;
  
  if (altScore >= 80) {
    confidence = 'CRITICAL - Almost certainly an alt';
    isLikelyAlt = true;
  } else if (altScore >= 60) {
    confidence = 'HIGH - Very likely an alt';
    isLikelyAlt = true;
  } else if (altScore >= 40) {
    confidence = 'MEDIUM - Possibly an alt';
    isLikelyAlt = true;
  } else if (altScore >= 20) {
    confidence = 'LOW - Some alt indicators';
    isLikelyAlt = false;
  } else {
    confidence = 'CLEAN - Unlikely to be alt';
    isLikelyAlt = false;
  }
  
  return {
    isLikelyAlt: isLikelyAlt,
    altScore: altScore,
    confidence: confidence,
    reason: reasons.length > 0 ? reasons.join(', ') : 'Normal account activity',
    factors: {
      accountAge: accountAgeDays,
      friends: friends,
      badges: badges,
      hasVerifiedBadge: hasVerifiedBadge,
      hasPremium: hasPremium,
      inBlacklistedGroup: inBlacklistedGroup
    }
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
  let XTRACKER_API_KEY = process.env.XTRACKER_API_KEY || "A-icVR0g6qaEi1EgTYd-TQ";
  
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

async function getTierInfo(tier) {
  const tiers = {
    'starter': { name: '🥉 Starter', maxServers: 1, maxGroups: 3, price: '$3/month' },
    'professional': { name: '🥈 Professional', maxServers: 5, maxGroups: 10, price: '$12/month' },
    'enterprise': { name: '🥇 Enterprise', maxServers: -1, maxGroups: -1, price: '$35/month' } // -1 = unlimited
  };
  return tiers[tier] || tiers['starter'];
}

async function checkLicenseLimits(licenseKey, guildId) {
  try {
    // Get license info
    const licenseRes = await pool.query(
      'SELECT tier, max_servers, max_groups, is_active, expires_at FROM licenses WHERE license_key = $1',
      [licenseKey]
    );
    
    if (licenseRes.rows.length === 0) {
      return { allowed: false, reason: 'Invalid license key' };
    }
    
    const license = licenseRes.rows[0];
    
    // Check if active
    if (!license.is_active) {
      return { allowed: false, reason: 'License is inactive' };
    }
    
    // Check if expired
    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return { allowed: false, reason: 'License has expired' };
    }
    
    // Check server limit
    if (license.max_servers > 0) {
      const serverCount = await pool.query(
        'SELECT COUNT(*) FROM guild_licenses WHERE license_key = $1',
        [licenseKey]
      );
      
      if (parseInt(serverCount.rows[0].count) >= license.max_servers) {
        return { allowed: false, reason: `Server limit reached (${license.max_servers} servers max)` };
      }
    }
    
    return { allowed: true, tier: license.tier, maxGroups: license.max_groups };
  } catch (e) {
    console.error('License check error:', e);
    return { allowed: false, reason: 'Database error' };
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
    { name: 'license', description: 'Check license status', default_member_permissions: '8' },
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
    ]},
    
    // Message as RoNexus
    { name: 'msgr', description: 'Send message as RoNexus', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Channel to send in', type: 7, required: true },
      { name: 'message', description: 'Message content', type: 3, required: true }
    ]},
    { name: 'msgre', description: 'Send embedded message as RoNexus', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Channel to send in', type: 7, required: true },
      { name: 'title', description: 'Embed title', type: 3, required: true },
      { name: 'message', description: 'Embed description', type: 3, required: true },
      { name: 'color', description: 'Hex color (e.g. #FF0000)', type: 3, required: false }
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
    const parts = interaction.customId.split('_');
    const action = parts[0];
    const robloxId = parts[1];
    const page = parseInt(parts[2] || '0');
    
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
        
        const itemsPerPage = 15;
        const totalPages = Math.ceil(userGroups.length / itemsPerPage);
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        
        const groupList = userGroups.slice(start, end).map((g, i) => 
          `${start + i + 1}. **${g.group.name}** (${g.group.id})\n   Role: ${g.role.name} (Rank ${g.role.rank})`
        ).join('\n\n');
        
        const embed = new EmbedBuilder()
          .setColor('#0099ff')
          .setTitle('👥 User Groups')
          .setDescription(`**Roblox ID:** ${robloxId}\n\n${groupList}`)
          .setFooter({ text: `Showing ${start + 1}-${Math.min(end, userGroups.length)} of ${userGroups.length} groups | Page ${page + 1}/${totalPages}` });
        
        const buttons = new ActionRowBuilder();
        if (page > 0) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`groups_${robloxId}_${page - 1}`)
              .setLabel('◀ Back')
              .setStyle(ButtonStyle.Secondary)
          );
        }
        if (end < userGroups.length) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`groups_${robloxId}_${page + 1}`)
              .setLabel('Next ▶')
              .setStyle(ButtonStyle.Primary)
          );
        }
        
        return interaction.editReply({ 
          embeds: [embed], 
          components: buttons.components.length > 0 ? [buttons] : [] 
        });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }
    
    if (action === 'games') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const games = await getUserGames(robloxId);
        
        if (games.length === 0) {
          return interaction.editReply({ content: '📋 User has not created any games!' });
        }
        
        const itemsPerPage = 15;
        const totalPages = Math.ceil(games.length / itemsPerPage);
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        
        const gameList = games.slice(start, end).map((g, i) => 
          `${start + i + 1}. **${g.name}**\n   Place ID: ${g.id} | Visits: ${g.placeVisits || 0}`
        ).join('\n\n');
        
        const embed = new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle('🎮 User Created Games')
          .setDescription(`**Roblox ID:** ${robloxId}\n\n${gameList}`)
          .setFooter({ text: `Showing ${start + 1}-${Math.min(end, games.length)} of ${games.length} games | Page ${page + 1}/${totalPages}` });
        
        const buttons = new ActionRowBuilder();
        if (page > 0) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`games_${robloxId}_${page - 1}`)
              .setLabel('◀ Back')
              .setStyle(ButtonStyle.Secondary)
          );
        }
        if (end < games.length) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`games_${robloxId}_${page + 1}`)
              .setLabel('Next ▶')
              .setStyle(ButtonStyle.Primary)
          );
        }
        
        return interaction.editReply({ 
          embeds: [embed], 
          components: buttons.components.length > 0 ? [buttons] : [] 
        });
      } catch (e) {
        console.error('Games error:', e);
        return interaction.editReply({ content: `❌ Unable to fetch games data` });
      }
    }
    
    if (action === 'gamepasses') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const gamepasses = await getUserGamePasses(robloxId);
        
        if (gamepasses.length === 0) {
          return interaction.editReply({ content: '📋 User has no gamepasses!' });
        }
        
        const itemsPerPage = 15;
        const totalPages = Math.ceil(gamepasses.length / itemsPerPage);
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        
        const gpList = gamepasses.slice(start, end).map((gp, i) => 
          `${start + i + 1}. **${gp.name}**\n   ID: ${gp.assetId || gp.id}`
        ).join('\n\n');
        
        const embed = new EmbedBuilder()
          .setColor('#FF69B4')
          .setTitle('🎫 User GamePasses')
          .setDescription(`**Roblox ID:** ${robloxId}\n\n${gpList}`)
          .setFooter({ text: `Showing ${start + 1}-${Math.min(end, gamepasses.length)} of ${gamepasses.length} gamepasses | Page ${page + 1}/${totalPages}` });
        
        const buttons = new ActionRowBuilder();
        if (page > 0) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`gamepasses_${robloxId}_${page - 1}`)
              .setLabel('◀ Back')
              .setStyle(ButtonStyle.Secondary)
          );
        }
        if (end < gamepasses.length) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`gamepasses_${robloxId}_${page + 1}`)
              .setLabel('Next ▶')
              .setStyle(ButtonStyle.Primary)
          );
        }
        
        return interaction.editReply({ 
          embeds: [embed], 
          components: buttons.components.length > 0 ? [buttons] : [] 
        });
      } catch (e) {
        console.error('GamePasses error:', e);
        return interaction.editReply({ content: `❌ Unable to fetch gamepasses` });
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
        
        const itemsPerPage = 15;
        const totalPages = Math.ceil(allFriends.length / itemsPerPage);
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        
        const friendList = allFriends.slice(start, end).map((f, i) => 
          `${start + i + 1}. **${f.name}** (${f.id})`
        ).join('\n');
        
        const embed = new EmbedBuilder()
          .setColor('#9B59B6')
          .setTitle('👥 Additional Information - Friends')
          .setDescription(`**Roblox ID:** ${robloxId}\n**Total Friends:** ${allFriends.length}\n\n${friendList}`)
          .setFooter({ text: `Showing ${start + 1}-${Math.min(end, allFriends.length)} of ${allFriends.length} friends (Max: 1000) | Page ${page + 1}/${totalPages}` });
        
        const buttons = new ActionRowBuilder();
        if (page > 0) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`friends_${robloxId}_${page - 1}`)
              .setLabel('◀ Back')
              .setStyle(ButtonStyle.Secondary)
          );
        }
        if (end < allFriends.length) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`friends_${robloxId}_${page + 1}`)
              .setLabel('Next ▶')
              .setStyle(ButtonStyle.Primary)
          );
        }
        
        return interaction.editReply({ 
          embeds: [embed], 
          components: buttons.components.length > 0 ? [buttons] : [] 
        });
      } catch (e) {
        return interaction.editReply({ content: `❌ ${e.message}` });
      }
    }
    
    if (action === 'badges') {
      await interaction.deferReply({ ephemeral: true });
      
      try {
        // Get all badges with pagination up to 1,000,000
        let allBadges = [];
        let cursor = '';
        let fetchCount = 0;
        const maxFetch = 10000; // Fetch up to 10k badges max to avoid timeout
        
        while (allBadges.length < maxFetch) {
          const url = cursor 
            ? `https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100&cursor=${cursor}`
            : `https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100`;
          
          try {
            const res = await axios.get(url, { timeout: 5000 });
            const badges = res.data.data || [];
            
            if (badges.length === 0) break;
            
            allBadges = allBadges.concat(badges);
            
            if (!res.data.nextPageCursor) break;
            cursor = res.data.nextPageCursor;
            
            fetchCount++;
            if (fetchCount > 100) break; // Safety limit
          } catch (err) {
            console.error('Badge fetch error:', err.message);
            break;
          }
        }
        
        if (allBadges.length === 0) {
          return interaction.editReply({ content: '📋 User has no badges!' });
        }
        
        const itemsPerPage = 15;
        const totalPages = Math.ceil(allBadges.length / itemsPerPage);
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        
        const badgeList = allBadges.slice(start, end).map((b, i) => 
          `${start + i + 1}. **${b.name}**\n   From: ${b.displayName || 'Unknown Game'}`
        ).join('\n\n');
        
        const embed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('🎖️ User Badges')
          .setDescription(`**Roblox ID:** ${robloxId}\n**Total Badges:** ${allBadges.length}\n\n${badgeList}`)
          .setFooter({ text: `Showing ${start + 1}-${Math.min(end, allBadges.length)} of ${allBadges.length} badges (Fetched up to 10k) | Page ${page + 1}/${totalPages}` });
        
        const buttons = new ActionRowBuilder();
        if (page > 0) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`badges_${robloxId}_${page - 1}`)
              .setLabel('◀ Back')
              .setStyle(ButtonStyle.Secondary)
          );
        }
        if (end < allBadges.length) {
          buttons.addComponents(
            new ButtonBuilder()
              .setCustomId(`badges_${robloxId}_${page + 1}`)
              .setLabel('Next ▶')
              .setStyle(ButtonStyle.Primary)
          );
        }
        
        return interaction.editReply({ 
          embeds: [embed], 
          components: buttons.components.length > 0 ? [buttons] : [] 
        });
      } catch (e) {
        console.error('Badges error:', e);
        return interaction.editReply({ content: `❌ Error fetching badges: ${e.message}` });
      }
    }
    
    return;
  }

  if (!interaction.isCommand()) return;
  
  const { commandName, guildId, user, options } = interaction;

  if (commandName === 'activate') {
    const license = options.getString('license');
    
    try {
      // Check if license exists and get limits
      const limitCheck = await checkLicenseLimits(license, guildId);
      
      if (!limitCheck.allowed) {
        return interaction.reply({ content: `❌ ${limitCheck.reason}`, ephemeral: true });
      }
      
      // Check if guild already activated
      const guildCheck = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (guildCheck.rows.length > 0) {
        return interaction.reply({ content: '✅ This server is already activated!', ephemeral: true });
      }
      
      // Activate the license for this guild
      await pool.query(
        'INSERT INTO guild_licenses (guild_id, license_key) VALUES ($1, $2)',
        [guildId, license]
      );
      
      const tierInfo = await getTierInfo(limitCheck.tier);
      
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ RoNexus Activated!')
        .setDescription(`**License Tier:** ${tierInfo.name}\n**Plan:** ${tierInfo.price}`)
        .addFields(
          { name: '📊 Your Limits', value: `• Servers: ${tierInfo.maxServers === -1 ? 'Unlimited' : `${tierInfo.maxServers}`}\n• Groups: ${tierInfo.maxGroups === -1 ? 'Unlimited' : `${tierInfo.maxGroups}`}`, inline: false },
          { name: '🚀 Next Steps', value: '• `/verify` - Verify Roblox\n• `/addgroup GROUP_ID API_KEY` - Connect Roblox group\n• `/addrank @Role 100 "Member" CD` - Add rank with prefix', inline: false }
        )
      ]});
    } catch (e) { 
      console.error('Activation error:', e);
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); 
    }
  }

  const activated = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
  if (activated.rows.length === 0 && commandName !== 'activate') {
    return interaction.reply({ content: '❌ Not activated! Use `/activate RONEXUS-LICENSE-KEY`', ephemeral: true });
  }

  if (commandName === 'license') {
    try {
      const guildLicense = await pool.query('SELECT license_key FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (guildLicense.rows.length === 0) {
        return interaction.reply({ content: '❌ No license found for this server!', ephemeral: true });
      }
      
      const licenseKey = guildLicense.rows[0].license_key;
      const licenseInfo = await pool.query(
        'SELECT tier, max_servers, max_groups, is_active, expires_at, created_at FROM licenses WHERE license_key = $1',
        [licenseKey]
      );
      
      if (licenseInfo.rows.length === 0) {
        return interaction.reply({ content: '❌ License not found in database!', ephemeral: true });
      }
      
      const license = licenseInfo.rows[0];
      const tierInfo = await getTierInfo(license.tier);
      
      // Count current usage
      const serverCount = await pool.query('SELECT COUNT(*) FROM guild_licenses WHERE license_key = $1', [licenseKey]);
      const groupCount = await pool.query('SELECT COUNT(*) FROM roblox_groups WHERE guild_id = $1', [guildId]);
      
      const serversUsed = parseInt(serverCount.rows[0].count);
      const groupsUsed = parseInt(groupCount.rows[0].count);
      
      const expiresText = license.expires_at 
        ? `Expires: ${new Date(license.expires_at).toLocaleDateString()}`
        : 'No expiration';
      
      const statusEmoji = license.is_active ? '🟢' : '🔴';
      const statusText = license.is_active ? 'Active' : 'Inactive';
      
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(license.is_active ? '#00FF00' : '#FF0000')
        .setTitle('📋 License Status')
        .setDescription(`**Tier:** ${tierInfo.name}\n**Status:** ${statusEmoji} ${statusText}\n**${expiresText}**`)
        .addFields(
          { name: '🖥️ Servers', value: `${serversUsed}/${tierInfo.maxServers === -1 ? '∞' : tierInfo.maxServers}`, inline: true },
          { name: '👥 Groups', value: `${groupsUsed}/${tierInfo.maxGroups === -1 ? '∞' : tierInfo.maxGroups}`, inline: true },
          { name: '🔑 License Key', value: `||${licenseKey}||`, inline: false }
        )
        .setFooter({ text: `Activated: ${new Date(license.created_at).toLocaleDateString()}` })
      ], ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
    }
  }

  if (commandName === 'verify') {
    // Check if user is already verified in this guild
    const alreadyVerified = await pool.query(
      'SELECT roblox_username FROM verified_users WHERE guild_id = $1 AND user_id = $2',
      [guildId, user.id]
    );
    
    if (alreadyVerified.rows.length > 0) {
      return interaction.reply({
        content: `✅ You're already verified as **${alreadyVerified.rows[0].roblox_username}**!\n\nNo need to verify again.`,
        ephemeral: true
      });
    }
    
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
      .setDescription('')
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
    
    try {
      // Get license info
      const guildLicense = await pool.query('SELECT license_key FROM guild_licenses WHERE guild_id = $1', [guildId]);
      const licenseKey = guildLicense.rows[0].license_key;
      const licenseInfo = await pool.query('SELECT tier, max_groups FROM licenses WHERE license_key = $1', [licenseKey]);
      const license = licenseInfo.rows[0];
      
      // Check group limit
      if (license.max_groups > 0) {
        const groupCount = await pool.query('SELECT COUNT(*) FROM roblox_groups WHERE guild_id = $1', [guildId]);
        const currentGroups = parseInt(groupCount.rows[0].count);
        
        if (currentGroups >= license.max_groups) {
          const tierInfo = await getTierInfo(license.tier);
          return interaction.reply({ 
            content: `❌ Group limit reached!\n\n**Your tier:** ${tierInfo.name}\n**Limit:** ${license.max_groups} groups\n**Current:** ${currentGroups} groups\n\nUpgrade your license to add more groups!`, 
            ephemeral: true 
          });
        }
      }
      
      await pool.query(
        'INSERT INTO roblox_groups (guild_id, group_id, api_key, auto_rank_enabled) VALUES ($1, $2, $3, true)', 
        [guildId, groupId, apiKey]
      );
      
      return interaction.reply({ 
        content: `✅ Added group **${groupId}**!\n\n**Next:** Use \`/maprank @Role ROBLOX_RANK_ID\` to sync Discord roles with Roblox ranks`, 
        ephemeral: true 
      });
    } catch (e) {
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
    }
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
      .setDescription(`<@${targetId}> has **${pts}** points\n\n`)
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
      content: `✅ Added **+${amount}** points to <@${targetId}>!\n**Reason:** ${reason}\n**New Total:** ${newPoints.rows[0].points} points\n\n` 
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
    
    return interaction.reply({ content: `✅ Removed **-${amount}** points from <@${targetId}>\n\n` });
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
      .setDescription(`${lb}\n\n`)
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
      
      const [badgeCount, friendsRes, userGroups, isPrivate, previousNames, profilePic] = await Promise.all([
        getAllBadges(robloxId),
        axios.get(`https://friends.roblox.com/v1/users/${robloxId}/friends/count`),
        getUserGroups(robloxId),
        checkIfPrivateProfile(robloxId),
        getPreviousUsernames(robloxId),
        getProfilePicture(robloxId)
      ]);
      
      const friendCount = friendsRes.data.count || 0;
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
      const altCheck = await detectAlts(robloxId, accountAgeDays, badgeCount, friendCount, hasVerifiedBadge, hasPremium, inBlacklistedGroup);
      const riskScore = calculateRiskScore(accountAgeDays, badgeCount, friendCount, hasVerifiedBadge, hasPremium, inBlacklistedGroup);
      const riskLevel = getRiskLevel(riskScore);
      
      await pool.query(
        'INSERT INTO background_checks (guild_id, user_id, roblox_id, roblox_username, risk_score, risk_level, account_age_days, has_premium, total_badges, total_friends) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', 
        [guildId, mention ? mention[1] : 'manual', robloxId, robloxUsername, riskScore, riskLevel, accountAgeDays, hasPremium, badgeCount, friendCount]
      );
      
      const riskColor = riskLevel === 'CRITICAL' ? '#FF0000' : riskLevel === 'HIGH' ? '#FFA500' : riskLevel === 'MEDIUM' ? '#FFFF00' : '#00FF00';
      const altColor = altCheck.altScore >= 60 ? '🚨' : altCheck.altScore >= 40 ? '⚠️' : altCheck.altScore >= 20 ? '⚡' : '✅';
      
      // Handle display name vs username and previous names
      let namesInfo = 'No alternate names found';
      
      if (robloxInfo.displayName && robloxInfo.displayName !== robloxInfo.name) {
        namesInfo = `**Display Name:** ${robloxInfo.displayName}`;
      }
      
      if (previousNames.length > 0) {
        const prevNamesText = previousNames.join(', ');
        if (namesInfo !== 'No alternate names found') {
          namesInfo += `\n**Also known as:** ${prevNamesText}`;
        } else {
          namesInfo = `**Also known as:** ${prevNamesText}`;
        }
      }
      
      const embed = new EmbedBuilder()
        .setColor(riskColor)
        .setTitle('🔍 Background Check')
        .setDescription(`**${robloxUsername}** (ID: ${robloxId})\n🔗 [View Profile](https://www.roblox.com/users/${robloxId}/profile)\n\n`)
        .addFields(
          { name: '⚠️ Risk Level', value: `${riskLevel} (${riskScore}/10)`, inline: true },
          { name: '🔒 Profile', value: isPrivate ? '🔐 Private' : '🌐 Public', inline: true },
          { name: '📅 Account Age', value: `${accountAgeDays} days`, inline: true },
          { name: '🎖️ Badges', value: `${badgeCount}`, inline: true },
          { name: '👥 Friends', value: `${friendCount}`, inline: true },
          { name: '💎 Premium', value: hasPremium ? '✅ Yes' : '❌ No', inline: true },
          { name: '✅ Verified Badge', value: hasVerifiedBadge ? '✅ Yes' : '❌ No', inline: true },
          { name: '📝 Names', value: namesInfo, inline: false },
          { name: '🔄 Alt Detection', value: `${altColor} **${altCheck.confidence}**\n**Score:** ${altCheck.altScore}/100\n**Indicators:** ${altCheck.reason}`, inline: false }
        );
      
      if (profilePic) {
        embed.setThumbnail(profilePic);
      }
      
      if (inBlacklistedGroup) {
        const groupList = blacklistedGroups.map(g => `• **${g.group.name}** (${g.group.id})`).join('\n');
        embed.addFields({ name: '🚨 BLACKLISTED GROUPS DETECTED', value: groupList });
      }
      
      embed.setFooter({ text: 'Click buttons below for more info' });
      
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`xtracker_${robloxId}_0`)
          .setLabel('🔎 XTracker')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`groups_${robloxId}_0`)
          .setLabel('👥 Groups')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`games_${robloxId}_0`)
          .setLabel('🎮 Games')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`gamepasses_${robloxId}_0`)
          .setLabel('🎫 GamePasses')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`badges_${robloxId}_0`)
          .setLabel('🎖️ Badges')
          .setStyle(ButtonStyle.Success)
      );
      
      const buttons2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`friends_${robloxId}_0`)
          .setLabel('👥 Friends')
          .setStyle(ButtonStyle.Secondary)
      );
      
      return interaction.editReply({ embeds: [embed], components: [buttons, buttons2] });
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
      .setColor('#FF0000')
      .setDescription('');
    
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
        .setDescription(`${warnList}\n\n`)
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

  if (commandName === 'msgr') {
    const channel = options.getChannel('channel');
    const message = options.getString('message');
    
    try {
      if (!channel.isTextBased()) {
        return interaction.reply({ content: '❌ Please select a text channel!', ephemeral: true });
      }
      
      await channel.send(message);
      
      return interaction.reply({ 
        content: `✅ Message sent to ${channel}\n\n`, 
        ephemeral: true 
      });
    } catch (e) {
      return interaction.reply({ content: `❌ Failed to send message: ${e.message}`, ephemeral: true });
    }
  }

  if (commandName === 'msgre') {
    const channel = options.getChannel('channel');
    const title = options.getString('title');
    const message = options.getString('message');
    const color = options.getString('color') || '#00a6ff';
    
    try {
      if (!channel.isTextBased()) {
        return interaction.reply({ content: '❌ Please select a text channel!', ephemeral: true });
      }
      
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(message)
        .setColor(color)
        .setFooter({ text: 'RoNexus (C) 2026' })
        .setTimestamp();
      
      await channel.send({ embeds: [embed] });
      
      return interaction.reply({ 
        content: `✅ Embedded message sent to ${channel}\n\n`, 
        ephemeral: true 
      });
    } catch (e) {
      return interaction.reply({ content: `❌ Failed to send embed: ${e.message}`, ephemeral: true });
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
  <title>✅ Verified - RoNexus</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 50%, #0a0a0a 100%);
      animation: gradientShift 15s ease infinite;
      background-size: 400% 400%;
      color: white;
    }
    @keyframes gradientShift {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .container {
      text-align: center;
      padding: 60px 40px;
      max-width: 650px;
    }
    .logo {
      font-size: 72px;
      font-weight: 800;
      margin-bottom: 40px;
      letter-spacing: -2px;
    }
    .logo-ro {
      color: #00a6ff;
      text-shadow: 0 0 20px rgba(0, 166, 255, 0.5);
    }
    .logo-nexus {
      color: transparent;
      -webkit-text-stroke: 2px #e0e0e0;
      text-stroke: 2px #e0e0e0;
    }
    .checkmark {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      background: rgba(67, 181, 129, 0.2);
      border: 3px solid #43b581;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 30px;
      animation: scaleIn 0.5s ease-out;
    }
    @keyframes scaleIn {
      from {
        transform: scale(0);
        opacity: 0;
      }
      to {
        transform: scale(1);
        opacity: 1;
      }
    }
    .checkmark svg {
      width: 60px;
      height: 60px;
      stroke: #43b581;
      stroke-width: 4;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      animation: draw 0.8s ease-out 0.3s forwards;
      stroke-dasharray: 100;
      stroke-dashoffset: 100;
    }
    @keyframes draw {
      to {
        stroke-dashoffset: 0;
      }
    }
    h1 {
      font-size: 48px;
      margin-bottom: 20px;
      font-weight: 700;
      text-shadow: 0 2px 10px rgba(0,0,0,0.5);
      background: linear-gradient(135deg, #43b581 0%, #00a6ff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .success-box {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      padding: 35px;
      border-radius: 20px;
      margin: 30px 0;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .username {
      font-size: 32px;
      font-weight: 600;
      color: #00a6ff;
      margin: 15px 0;
      text-shadow: 0 0 10px rgba(0, 166, 255, 0.3);
    }
    .detail {
      font-size: 16px;
      line-height: 2;
      margin: 12px 0;
      opacity: 0.95;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .detail strong {
      color: #fff;
      font-weight: 600;
    }
    .footer {
      margin-top: 30px;
      font-size: 14px;
      opacity: 0.6;
    }
    .emoji {
      font-size: 24px;
    }
    .glow {
      position: absolute;
      width: 300px;
      height: 300px;
      background: radial-gradient(circle, rgba(0,166,255,0.1) 0%, transparent 70%);
      border-radius: 50%;
      pointer-events: none;
      animation: pulse 3s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 0.3; }
      50% { transform: scale(1.2); opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="glow"></div>
  <div class="container">
    <div class="logo">
      <span class="logo-ro">Ro</span><span class="logo-nexus">Nexus</span>
    </div>
    <div class="checkmark">
      <svg viewBox="0 0 52 52">
        <path d="M14 27l7 7 16-16"/>
      </svg>
    </div>
    <h1>Verification Successful!</h1>
    <div class="success-box">
      <div class="username"><span class="emoji">🎮</span>${robloxUsername}</div>
      <div class="detail"><strong>✅ Discord Nickname Updated</strong></div>
      <div class="detail"><strong>🎭 Verified Role Granted</strong></div>
      <div class="detail"><strong>🔗 Account Linked Successfully</strong></div>
    </div>
    <div class="footer">
      You can now close this page and return to Discord
    </div>
  </div>
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

// WHOP WEBHOOK - Handles license creation/renewal/cancellation
app.post('/whop/webhook', express.json(), async (req, res) => {
  try {
    const event = req.body;
    
    console.log('📨 Whop webhook received:', event.action);
    
    // Verify it's from Whop (optional but recommended)
    const whopSecret = process.env.WHOP_WEBHOOK_SECRET;
    if (whopSecret) {
      const signature = req.headers['x-whop-signature'];
      // Add signature verification here if needed
    }
    
    const action = event.action;
    const membership = event.data;
    
    if (action === 'membership.created' || action === 'membership.renewed') {
      // New membership or renewal
      const planId = membership.plan_id;
      const membershipId = membership.id;
      const userEmail = membership.email;
      
      // Determine tier based on plan_id
      let tier = 'starter';
      let maxServers = 1;
      let maxGroups = 3;
      
      // You'll get these plan IDs from Whop dashboard
      if (planId === process.env.WHOP_PLAN_PROFESSIONAL) {
        tier = 'professional';
        maxServers = 5;
        maxGroups = 10;
      } else if (planId === process.env.WHOP_PLAN_ENTERPRISE) {
        tier = 'enterprise';
        maxServers = -1; // unlimited
        maxGroups = -1; // unlimited
      }
      
      // Calculate expiration (30 days for monthly)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      
      // Generate license key
      const licenseKey = `RONEXUS-${tier.toUpperCase()}-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;
      
      // Insert or update license
      await pool.query(
        `INSERT INTO licenses (license_key, whop_membership_id, tier, max_servers, max_groups, is_active, expires_at) 
         VALUES ($1, $2, $3, $4, $5, true, $6)
         ON CONFLICT (whop_membership_id) 
         DO UPDATE SET is_active = true, expires_at = $6, tier = $3, max_servers = $4, max_groups = $5, updated_at = NOW()`,
        [licenseKey, membershipId, tier, maxServers, maxGroups, expiresAt]
      );
      
      console.log(`✅ License created/renewed: ${licenseKey} (Tier: ${tier})`);
      
      // TODO: Send license key to user via email/Discord
      // You can integrate with Discord webhooks or email service here
      
    } else if (action === 'membership.cancelled' || action === 'membership.expired') {
      // Cancel membership
      const membershipId = membership.id;
      
      await pool.query(
        'UPDATE licenses SET is_active = false, updated_at = NOW() WHERE whop_membership_id = $1',
        [membershipId]
      );
      
      console.log(`❌ License cancelled/expired: ${membershipId}`);
    }
    
    res.status(200).json({ success: true });
  } catch (e) {
    console.error('❌ Whop webhook error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('🤖 RoNexus Bot Online!'));

// ADMIN: Create free Enterprise license (visit this URL once)
app.get('/admin/create-enterprise-license', async (req, res) => {
  try {
    const licenseKey = 'RONEXUS-ENTERPRISE-TEST-FREE';
    
    // Check if already exists
    const existing = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [licenseKey]);
    if (existing.rows.length > 0) {
      return res.send('✅ License already exists! Use: /activate RONEXUS-ENTERPRISE-TEST-FREE');
    }
    
    // Create enterprise license
    await pool.query(
      'INSERT INTO licenses (license_key, tier, max_servers, max_groups, is_active) VALUES ($1, $2, $3, $4, $5)',
      [licenseKey, 'enterprise', -1, -1, true]
    );
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>License Created</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px; background: #1a1a1a; color: white;">
        <h1 style="color: #00a6ff;">✅ Enterprise License Created!</h1>
        <div style="background: #2a2a2a; padding: 30px; border-radius: 10px; margin: 20px auto; max-width: 500px;">
          <h2>Your License Key:</h2>
          <p style="font-size: 20px; color: #00ff00; font-weight: bold;">RONEXUS-ENTERPRISE-TEST-FREE</p>
          <hr style="border-color: #444;">
          <p><strong>Tier:</strong> 🥇 Enterprise</p>
          <p><strong>Servers:</strong> Unlimited</p>
          <p><strong>Groups:</strong> Unlimited</p>
          <hr style="border-color: #444;">
          <p style="color: #ffaa00;">Use this in Discord:</p>
          <code style="background: #000; padding: 10px; display: block; border-radius: 5px;">/activate RONEXUS-ENTERPRISE-TEST-FREE</code>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.send(`❌ Error: ${e.message}`);
  }
});

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// Keep-alive ping
setInterval(() => {
  console.log('🔄 Keep-alive ping');
}, 300000);

client.login(process.env.DISCORD_TOKEN);
