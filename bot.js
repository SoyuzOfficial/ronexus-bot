const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags, ActivityType } = require('discord.js');
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
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='licenses' AND column_name='whop_membership_id') THEN
          ALTER TABLE licenses ADD COLUMN whop_membership_id VARCHAR(100) UNIQUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='licenses' AND column_name='tier') THEN
          ALTER TABLE licenses ADD COLUMN tier VARCHAR(20) NOT NULL DEFAULT 'starter';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='licenses' AND column_name='max_servers') THEN
          ALTER TABLE licenses ADD COLUMN max_servers INT DEFAULT 1;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='licenses' AND column_name='max_groups') THEN
          ALTER TABLE licenses ADD COLUMN max_groups INT DEFAULT 3;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='licenses' AND column_name='expires_at') THEN
          ALTER TABLE licenses ADD COLUMN expires_at TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='licenses' AND column_name='created_at') THEN
          ALTER TABLE licenses ADD COLUMN created_at TIMESTAMP DEFAULT NOW();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='licenses' AND column_name='updated_at') THEN
          ALTER TABLE licenses ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
        END IF;
      END $$;
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
        rank_abbreviation VARCHAR(10),
        welcome_channel_id VARCHAR(20),
        welcome_message TEXT,
        log_channel_id VARCHAR(20),
        unverified_role_id VARCHAR(20)
      );
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guild_config' AND column_name='verified_role_id') THEN
          ALTER TABLE guild_config ADD COLUMN verified_role_id VARCHAR(20);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guild_config' AND column_name='rank_abbreviation') THEN
          ALTER TABLE guild_config ADD COLUMN rank_abbreviation VARCHAR(10);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guild_config' AND column_name='welcome_channel_id') THEN
          ALTER TABLE guild_config ADD COLUMN welcome_channel_id VARCHAR(20);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guild_config' AND column_name='welcome_message') THEN
          ALTER TABLE guild_config ADD COLUMN welcome_message TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guild_config' AND column_name='log_channel_id') THEN
          ALTER TABLE guild_config ADD COLUMN log_channel_id VARCHAR(20);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guild_config' AND column_name='unverified_role_id') THEN
          ALTER TABLE guild_config ADD COLUMN unverified_role_id VARCHAR(20);
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS sticky_messages (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        message_content TEXT NOT NULL,
        last_message_id VARCHAR(20),
        UNIQUE(guild_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS activation_attempts (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        attempt_time TIMESTAMP DEFAULT NOW(),
        success BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_activation_attempts ON activation_attempts(guild_id, user_id, attempt_time);
      CREATE TABLE IF NOT EXISTS verified_users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20) NOT NULL,
        guild_id VARCHAR(20) NOT NULL,
        roblox_id VARCHAR(20) NOT NULL,
        roblox_username VARCHAR(50) NOT NULL,
        verified_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(guild_id, user_id)
      );
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='verified_at') THEN
          ALTER TABLE verified_users ADD COLUMN verified_at TIMESTAMP DEFAULT NOW();
        END IF;
      END $$;
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
      CREATE TABLE IF NOT EXISTS command_permissions (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        role_id VARCHAR(20) NOT NULL,
        command_name VARCHAR(50) NOT NULL,
        allowed BOOLEAN DEFAULT TRUE,
        UNIQUE(guild_id, role_id, command_name)
      );
    `);
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
  } catch (e) { return null; }
}
async function getRobloxUserInfo(userId) {
  try {
    const res = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
    return res.data;
  } catch (e) { return null; }
}
async function getUserGroups(userId) {
  try {
    const res = await axios.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
    return res.data.data || [];
  } catch (e) { return []; }
}
async function checkIfPrivateProfile(userId) {
  try {
    const res = await axios.get(`https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`);
    return res.data.canView === false;
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 403) return true;
    return false;
  }
}
async function getPreviousUsernames(userId) {
  try {
    const names = [];
    // Get current user info for display name check
    const userRes = await axios.get(`https://users.roblox.com/v1/users/${userId}`, { timeout: 5000 });
    const currentName = userRes.data.name;
    const displayName = userRes.data.displayName;

    // Username history - Roblox API
    try {
      const histRes = await axios.get(
        `https://users.roblox.com/v1/users/${userId}/username-history?limit=50&sortOrder=Desc`,
        { timeout: 5000 }
      );
      if (histRes.data?.data?.length > 0) {
        histRes.data.data.forEach(entry => {
          if (entry.name && entry.name !== currentName) names.push(entry.name);
        });
      }
    } catch (e) { /* API may be restricted */ }

    return { currentName, displayName, previousNames: names };
  } catch (e) { return { currentName: null, displayName: null, previousNames: [] }; }
}
async function getProfilePicture(userId) {
  try {
    const res = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`);
    if (res.data.data && res.data.data.length > 0) return res.data.data[0].imageUrl;
    return null;
  } catch (e) { return null; }
}
async function logActivity(guildId, eventType, message) {
  try {
    const config = await pool.query('SELECT log_channel_id FROM guild_config WHERE guild_id = $1', [guildId]);
    if (config.rows.length === 0 || !config.rows[0].log_channel_id) return;
    const channel = client.channels.cache.get(config.rows[0].log_channel_id);
    if (!channel) return;
    const colors = {
      'verification': '#00FF00', 'rank_change': '#FFA500',
      'points_added': '#00a6ff', 'points_removed': '#FF6B6B',
      'warning': '#FFA500', 'kick': '#FF0000', 'ban': '#8B0000',
      'dm_sent': '#9B59B6', 'config_change': '#667eea'
    };
    const embed = new EmbedBuilder()
      .setColor(colors[eventType] || '#00a6ff')
      .setDescription(message)
      .setFooter({ text: eventType.replace('_', ' ').toUpperCase() })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Log activity error:', e); }
}
async function getUserGames(userId) {
  try {
    const res = await axios.get(`https://games.roblox.com/v2/users/${userId}/games?limit=50&sortOrder=Desc`);
    return res.data.data || [];
  } catch (e) { return []; }
}
async function getUserGamePasses(userId) {
  try {
    let allPasses = [], cursor = '';
    // Try catalog API first (more reliable, works on public profiles)
    while (allPasses.length < 200) {
      const url = cursor
        ? `https://catalog.roblox.com/v1/search/items?category=GamePass&creatorType=User&creatorTargetId=${userId}&limit=30&cursor=${cursor}`
        : `https://catalog.roblox.com/v1/search/items?category=GamePass&creatorType=User&creatorTargetId=${userId}&limit=30`;
      try {
        const res = await axios.get(url, { timeout: 8000 });
        const passes = res.data.data || [];
        allPasses = allPasses.concat(passes);
        if (!res.data.nextPageCursor || passes.length === 0) break;
        cursor = res.data.nextPageCursor;
      } catch (e) { break; }
    }
    // If catalog returned nothing, try inventory API as fallback
    if (allPasses.length === 0) {
      cursor = '';
      while (allPasses.length < 200) {
        const url = cursor
          ? `https://inventory.roblox.com/v1/users/${userId}/items/GamePass?limit=100&cursor=${cursor}`
          : `https://inventory.roblox.com/v1/users/${userId}/items/GamePass?limit=100`;
        try {
          const res = await axios.get(url, { timeout: 8000 });
          const passes = res.data.data || [];
          allPasses = allPasses.concat(passes);
          if (!res.data.nextPageCursor || passes.length === 0) break;
          cursor = res.data.nextPageCursor;
        } catch (e) { break; }
      }
    }
    return allPasses;
  } catch (e) { console.error('GamePasses error:', e.message); return []; }
}
async function getAllBadges(userId) {
  try {
    let allBadges = [], cursor = '', fetchCount = 0;
    while (allBadges.length < 10000 && fetchCount < 100) {
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
        if (err.response?.status === 403 || err.response?.status === 401 || err.response?.status === 429) return -1;
        if (fetchCount === 0) return -1;
        break;
      }
    }
    return allBadges.length;
  } catch (e) { return -1; }
}
async function checkPremium(userId) {
  try {
    const res = await axios.get(`https://premiumfeatures.roblox.com/v1/users/${userId}/validate-membership`);
    return res.data === true;
  } catch (e) { return false; }
}
async function detectAlts(userId, accountAgeDays, badges, friends, hasVerifiedBadge, hasPremium, inBlacklistedGroup) {
  let altScore = 0, reasons = [];
  if (accountAgeDays < 1) { altScore += 40; reasons.push('Brand new account (<1 day)'); }
  else if (accountAgeDays < 7) { altScore += 30; reasons.push('Very new account (<7 days)'); }
  else if (accountAgeDays < 30) { altScore += 20; reasons.push('New account (<30 days)'); }
  else if (accountAgeDays < 90) { altScore += 10; reasons.push('Relatively new (<90 days)'); }
  if (friends === 0) { altScore += 25; reasons.push('No friends'); }
  else if (friends < 3) { altScore += 20; reasons.push('Very few friends'); }
  else if (friends < 10) { altScore += 10; reasons.push('Low friend count'); }
  if (badges === 0) { altScore += 20; reasons.push('No badges earned'); }
  else if (badges < 5) { altScore += 15; reasons.push('Very few badges'); }
  else if (badges < 20) { altScore += 8; reasons.push('Low badge count'); }
  if (inBlacklistedGroup) { altScore += 50; reasons.push('IN BLACKLISTED GROUP'); }
  if (hasVerifiedBadge) { altScore -= 20; reasons.push('Has verified badge (legit)'); }
  if (hasPremium) { altScore -= 15; reasons.push('Has premium (legit)'); }
  altScore = Math.max(0, Math.min(100, altScore));
  let confidence, isLikelyAlt;
  if (altScore >= 80) { confidence = 'CRITICAL - Almost certainly an alt'; isLikelyAlt = true; }
  else if (altScore >= 60) { confidence = 'HIGH - Very likely an alt'; isLikelyAlt = true; }
  else if (altScore >= 40) { confidence = 'MEDIUM - Possibly an alt'; isLikelyAlt = true; }
  else if (altScore >= 20) { confidence = 'LOW - Some alt indicators'; isLikelyAlt = false; }
  else { confidence = 'CLEAN - Unlikely to be alt'; isLikelyAlt = false; }
  return { isLikelyAlt, altScore, confidence, reason: reasons.length > 0 ? reasons.join(', ') : 'Normal account activity', factors: { accountAgeDays, friends, badges, hasVerifiedBadge, hasPremium, inBlacklistedGroup } };
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
  if (!XTRACKER_API_KEY) return { flagged: false, confidence: 'no-api-key', reason: 'XTracker API key not set', ownership: [] };
  try {
    let isFlagged = false, cheats = [], reason = 'Clean - Not in XTracker database';
    try {
      const registryRes = await axios.get(`https://api.xtracker.xyz/api/registry/user?id=${robloxId}`, { headers: { 'Authorization': XTRACKER_API_KEY }, timeout: 5000 });
      if (registryRes.data && registryRes.data.evidence && registryRes.data.evidence.length > 0) {
        isFlagged = true;
        reason = `Flagged in XTracker registry - Evidence: ${registryRes.data.evidence.map(e => e.reason).join(', ')}`;
      }
    } catch (regError) { if (regError.response && regError.response.status !== 404) console.error('XTracker registry:', regError.message); }
    try {
      const ownershipRes = await axios.get(`https://api.xtracker.xyz/api/ownership/user?id=${robloxId}`, { headers: { 'Authorization': XTRACKER_API_KEY }, timeout: 5000 });
      if (ownershipRes.data && ownershipRes.data.owns_cheats) {
        isFlagged = true; cheats = ownershipRes.data.cheats || [];
        reason = `Owns exploits: ${cheats.join(', ')}`;
      }
    } catch (ownError) { if (ownError.response && ownError.response.status !== 404) console.error('XTracker ownership:', ownError.message); }
    return { flagged: isFlagged, confidence: isFlagged ? 'high' : 'clean', reason, ownership: cheats };
  } catch (e) { return { flagged: false, confidence: 'error', reason: `API error: ${e.message}`, ownership: [] }; }
}
async function setRobloxGroupRank(groupId, robloxUserId, roleId, apiKey) {
  try {
    await axios.patch(
      `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${robloxUserId}`,
      { role: `groups/${groupId}/roles/${roleId}` },
      { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch (e) { console.error('❌ Roblox rank error:', e.response?.data || e.message); return false; }
}
async function updateNickname(guild, userId, robloxUsername, abbreviation = null) {
  try {
    const member = await guild.members.fetch(userId);
    const nickname = abbreviation ? `[${abbreviation}] ${robloxUsername}` : robloxUsername;
    await member.setNickname(nickname);
    return true;
  } catch (e) { return false; }
}
async function giveVerifiedRole(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    
    // Check for configured verified role first
    const config = await pool.query('SELECT verified_role_id, unverified_role_id FROM guild_config WHERE guild_id = $1', [guild.id]);
    let verifiedRole = null;

    if (config.rows.length > 0 && config.rows[0].verified_role_id) {
      // Use the configured verified role
      verifiedRole = guild.roles.cache.get(config.rows[0].verified_role_id);
    }

    // Fallback: find or create a "Verified" role
    if (!verifiedRole) {
      verifiedRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'verified');
      if (!verifiedRole) {
        verifiedRole = await guild.roles.create({ name: 'Verified', color: '#00FF00', reason: 'Auto-created by RoNexus' });
      }
    }

    await member.roles.add(verifiedRole);

    // Remove unverified role if configured
    if (config.rows.length > 0 && config.rows[0].unverified_role_id) {
      const unverifiedRole = guild.roles.cache.get(config.rows[0].unverified_role_id);
      if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
        await member.roles.remove(unverifiedRole);
      }
    }
    return true;
  } catch (e) { console.error('❌ Verified role error:', e.message); return false; }
}
async function getTierInfo(tier) {
  const tiers = {
    'starter': { name: '🥉 Starter', maxServers: 1, maxGroups: 3, price: '$3/month' },
    'professional': { name: '🥈 Professional', maxServers: 5, maxGroups: 10, price: '$12/month' },
    'enterprise': { name: '🥇 Enterprise', maxServers: -1, maxGroups: -1, price: '$35/month' }
  };
  return tiers[tier] || tiers['starter'];
}
async function checkLicenseLimits(licenseKey, guildId) {
  try {
    const licenseRes = await pool.query('SELECT tier, max_servers, max_groups, is_active, expires_at FROM licenses WHERE license_key = $1', [licenseKey]);
    if (licenseRes.rows.length === 0) return { allowed: false, reason: 'Invalid license key' };
    const license = licenseRes.rows[0];
    if (!license.is_active) return { allowed: false, reason: 'License is inactive' };
    if (license.expires_at && new Date(license.expires_at) < new Date()) return { allowed: false, reason: 'License has expired' };
    if (license.max_servers > 0) {
      const serverCount = await pool.query('SELECT COUNT(*) FROM guild_licenses WHERE license_key = $1', [licenseKey]);
      if (parseInt(serverCount.rows[0].count) >= license.max_servers) return { allowed: false, reason: `Server limit reached (${license.max_servers} servers max)` };
    }
    return { allowed: true, tier: license.tier, maxGroups: license.max_groups };
  } catch (e) { return { allowed: false, reason: 'Database error' }; }
}
async function checkAndPromote(guildId, userId, points) {
  try {
    const ranks = await pool.query('SELECT * FROM ranks WHERE guild_id = $1 AND points_required <= $2 ORDER BY points_required DESC LIMIT 1', [guildId, points]);
    if (ranks.rows.length > 0) {
      const rank = ranks.rows[0];
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      const member = await guild.members.fetch(userId);
      const role = guild.roles.cache.get(rank.role_id);
      if (role && !member.roles.cache.has(rank.role_id)) {
        await member.roles.add(role);
        const verified = await pool.query('SELECT roblox_id FROM verified_users WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
        if (verified.rows.length > 0) {
          const robloxGroups = await pool.query('SELECT * FROM roblox_groups WHERE guild_id = $1 AND auto_rank_enabled = true', [guildId]);
          for (const group of robloxGroups.rows) {
            const mapping = await pool.query('SELECT roblox_rank_id FROM group_rank_mapping WHERE roblox_group_id = $1 AND discord_role_id = $2', [group.id, rank.role_id]);
            if (mapping.rows.length > 0) {
              await setRobloxGroupRank(group.group_id, verified.rows[0].roblox_id, mapping.rows[0].roblox_rank_id, group.api_key);
            }
          }
        }
      }
    }
  } catch (e) { console.error('❌ Auto-promote error:', e.message); }
}
// ============================================
// BOT READY
// ============================================
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  await ensureTablesExist();

  // ============================================
  // BOT STATUS - Change activity type and message here
  // Types: ActivityType.Playing | ActivityType.Watching | ActivityType.Listening | ActivityType.Competing
  // ============================================
  client.user.setPresence({
    activities: [{
      name: 'ronexus.org | /help',
      type: ActivityType.Watching
    }],
    status: 'online' // online | idle | dnd | invisible
  });

  const commands = [
    { name: 'activate', description: 'Activate bot', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
    { name: 'license', description: 'Check license status', default_member_permissions: '8' },
    { name: 'verify', description: 'Verify Roblox account' },
    { name: 'update', description: 'Refresh roles and nickname' },
    { name: 'profile', description: 'View user profile', options: [{ name: 'user', description: '@user or username', type: 3, required: false }] },
    { name: 'setup', description: 'Interactive server setup', default_member_permissions: '8' },
    { name: 'help', description: 'View all commands and examples' },
    { name: 'stats', description: 'View server statistics', default_member_permissions: '8' },
    { name: 'insights', description: 'View server insights', default_member_permissions: '8' },
    // Configuration
    { name: 'setverified', description: 'Set the verified role given after verification', default_member_permissions: '8', options: [
      { name: 'role', description: 'Role to give when a user verifies', type: 8, required: true }
    ]},
    { name: 'setpermissions', description: 'Set role permissions for specific command', default_member_permissions: '8', options: [
      { name: 'role', description: 'Role to give permissions', type: 8, required: true },
      { name: 'command', description: 'Command name (e.g. addpoints, ban)', type: 3, required: true },
      { name: 'allow', description: 'Allow or deny', type: 5, required: true }
    ]},
    { name: 'setwelcome', description: 'Set welcome message', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Welcome channel', type: 7, required: true },
      { name: 'message', description: 'Welcome message ({user} = mention, {server} = server name)', type: 3, required: true }
    ]},
    { name: 'setlog', description: 'Set activity log channel', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Log channel', type: 7, required: true }
    ]},
    { name: 'setunverified', description: 'Set unverified role', default_member_permissions: '8', options: [
      { name: 'role', description: 'Role for unverified users', type: 8, required: true }
    ]},
    { name: 'sticky', description: 'Create sticky message', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Channel for sticky', type: 7, required: true },
      { name: 'message', description: 'Sticky message', type: 3, required: true }
    ]},
    { name: 'addgroup', description: 'Add Roblox group', default_member_permissions: '8', options: [
      { name: 'group_id', description: 'Roblox group ID', type: 4, required: true },
      { name: 'api_key', description: 'Open Cloud API key', type: 3, required: true }
    ]},
    { name: 'removegroup', description: 'Remove Roblox group', default_member_permissions: '8', options: [
      { name: 'group_id', description: 'Roblox group ID', type: 4, required: true }
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
      { name: 'amount', description: 'Amount', type: 4, required: true },
      { name: 'reason', description: 'Reason for removal', type: 3, required: true }
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
    { name: 'viewblacklists', description: 'View server blacklists' },
    // Moderation
    { name: 'viewwarns', description: 'View warnings', options: [{ name: 'user', description: '@user', type: 6, required: true }] },
    { name: 'removewarn', description: 'Remove a warning from a user', default_member_permissions: '8', options: [
      { name: 'user', description: '@user', type: 6, required: true },
      { name: 'warn_number', description: 'Warning number to remove (from /viewwarns)', type: 4, required: true }
    ]},
    { name: 'cat', description: 'Get a random cat picture 🐱' },
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
    // Messaging
    { name: 'announce', description: 'Post announcement in channel', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Channel to post in', type: 7, required: true },
      { name: 'message', description: 'Announcement message', type: 3, required: true }
    ]},
    { name: 'postembed', description: 'Post embedded announcement', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Channel to post in', type: 7, required: true },
      { name: 'title', description: 'Embed title', type: 3, required: true },
      { name: 'message', description: 'Embed description', type: 3, required: true },
      { name: 'color', description: 'Hex color (e.g. #FF0000)', type: 3, required: false }
    ]},
    { name: 'dm', description: 'Send DM to user', default_member_permissions: '8', options: [
      { name: 'user', description: '@user to DM', type: 6, required: true },
      { name: 'message', description: 'Message to send', type: 3, required: true },
      { name: 'embed', description: 'Send as embed?', type: 5, required: false },
      { name: 'title', description: 'Embed title (if embed=true)', type: 3, required: false },
      { name: 'color', description: 'Embed color (if embed=true)', type: 3, required: false }
    ]},
    { name: 'removesticky', description: 'Remove sticky message', default_member_permissions: '8', options: [
      { name: 'channel', description: 'Channel with sticky', type: 7, required: true }
    ]},
    // Data Export
    { name: 'export', description: 'Export server data', default_member_permissions: '8', options: [
      { name: 'type', description: 'Data type to export', type: 3, required: true, choices: [
        { name: 'Points', value: 'points' },
        { name: 'Verifications', value: 'verifications' },
        { name: 'Warnings', value: 'warnings' },
        { name: 'Blacklists', value: 'blacklists' }
      ]}
    ]}
  ];
  await client.application.commands.set(commands);
  console.log('✅ Commands registered!');
});
// ============================================
// MEMBER JOIN EVENT
// ============================================
client.on('guildMemberAdd', async (member) => {
  try {
    const guildId = member.guild.id;
    const config = await pool.query('SELECT unverified_role_id, welcome_channel_id, welcome_message FROM guild_config WHERE guild_id = $1', [guildId]);
    if (config.rows.length > 0) {
      const { unverified_role_id, welcome_channel_id, welcome_message } = config.rows[0];
      if (unverified_role_id) {
        try {
          const role = member.guild.roles.cache.get(unverified_role_id);
          if (role) await member.roles.add(role);
        } catch (e) { console.error('Failed to give unverified role:', e.message); }
      }
      if (welcome_channel_id && welcome_message) {
        try {
          const channel = member.guild.channels.cache.get(welcome_channel_id);
          if (channel && channel.isTextBased()) {
            const formattedMessage = welcome_message.replace(/{user}/g, `<@${member.id}>`).replace(/{server}/g, member.guild.name);
            await channel.send(formattedMessage);
          }
        } catch (e) { console.error('Failed to send welcome message:', e.message); }
      }
    }
  } catch (e) { console.error('Member join event error:', e); }
});
// ============================================
// STICKY MESSAGES HANDLER
// ============================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  try {
    const sticky = await pool.query('SELECT message_content, last_message_id FROM sticky_messages WHERE guild_id = $1 AND channel_id = $2', [message.guild.id, message.channel.id]);
    if (sticky.rows.length > 0) {
      const { message_content, last_message_id } = sticky.rows[0];
      if (last_message_id) {
        try { const oldMsg = await message.channel.messages.fetch(last_message_id); await oldMsg.delete(); } catch (e) {}
      }
      const newSticky = await message.channel.send(message_content);
      await pool.query('UPDATE sticky_messages SET last_message_id = $1 WHERE guild_id = $2 AND channel_id = $3', [newSticky.id, message.guild.id, message.channel.id]);
    }
  } catch (e) {}
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
        await pool.query('INSERT INTO xtracker_cache (roblox_user_id, is_flagged, exploit_data) VALUES ($1, $2, $3) ON CONFLICT (roblox_user_id) DO UPDATE SET is_flagged = $2, exploit_data = $3, last_checked = NOW()', [robloxId, result.flagged, JSON.stringify(result)]);
        const embed = new EmbedBuilder().setColor(result.flagged ? '#FF0000' : '#00FF00').setTitle('🔎 XTracker Check').setDescription(`**Roblox ID:** ${robloxId}`).addFields({ name: 'Status', value: result.flagged ? '🚨 **FLAGGED**' : '✅ **CLEAN**', inline: true }, { name: 'Confidence', value: result.confidence, inline: true }, { name: 'Details', value: result.reason, inline: false });
        if (result.ownership && result.ownership.length > 0) embed.addFields({ name: 'Owned Exploits', value: result.ownership.join(', '), inline: false });
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
    }
    if (action === 'groups') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const userGroups = await getUserGroups(robloxId);
        if (userGroups.length === 0) return interaction.editReply({ content: '📋 User is not in any groups!' });
        const itemsPerPage = 15, totalPages = Math.ceil(userGroups.length / itemsPerPage), start = page * itemsPerPage, end = start + itemsPerPage;
        const groupList = userGroups.slice(start, end).map((g, i) => `${start + i + 1}. **${g.group.name}** (${g.group.id})\n   Role: ${g.role.name} (Rank ${g.role.rank})`).join('\n\n');
        const embed = new EmbedBuilder().setColor('#0099ff').setTitle('👥 User Groups').setDescription(`**Roblox ID:** ${robloxId}\n\n${groupList}`).setFooter({ text: `Showing ${start + 1}-${Math.min(end, userGroups.length)} of ${userGroups.length} groups | Page ${page + 1}/${totalPages}` });
        const buttons = new ActionRowBuilder();
        if (page > 0) buttons.addComponents(new ButtonBuilder().setCustomId(`groups_${robloxId}_${page - 1}`).setLabel('◀ Back').setStyle(ButtonStyle.Secondary));
        if (end < userGroups.length) buttons.addComponents(new ButtonBuilder().setCustomId(`groups_${robloxId}_${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary));
        return interaction.editReply({ embeds: [embed], components: buttons.components.length > 0 ? [buttons] : [] });
      } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
    }
    if (action === 'games') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const games = await getUserGames(robloxId);
        if (games.length === 0) return interaction.editReply({ content: '📋 User has not created any games!' });
        const itemsPerPage = 15, totalPages = Math.ceil(games.length / itemsPerPage), start = page * itemsPerPage, end = start + itemsPerPage;
        const gameList = games.slice(start, end).map((g, i) => `${start + i + 1}. **${g.name}**\n   Place ID: ${g.id} | Visits: ${g.placeVisits || 0}`).join('\n\n');
        const embed = new EmbedBuilder().setColor('#FFA500').setTitle('🎮 User Created Games').setDescription(`**Roblox ID:** ${robloxId}\n\n${gameList}`).setFooter({ text: `Showing ${start + 1}-${Math.min(end, games.length)} of ${games.length} games | Page ${page + 1}/${totalPages}` });
        const buttons = new ActionRowBuilder();
        if (page > 0) buttons.addComponents(new ButtonBuilder().setCustomId(`games_${robloxId}_${page - 1}`).setLabel('◀ Back').setStyle(ButtonStyle.Secondary));
        if (end < games.length) buttons.addComponents(new ButtonBuilder().setCustomId(`games_${robloxId}_${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary));
        return interaction.editReply({ embeds: [embed], components: buttons.components.length > 0 ? [buttons] : [] });
      } catch (e) { return interaction.editReply({ content: `❌ Unable to fetch games data` }); }
    }
    if (action === 'gamepasses') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const gamepasses = await getUserGamePasses(robloxId);
        if (gamepasses.length === 0) return interaction.editReply({ content: '📋 User has no gamepasses!' });
        const itemsPerPage = 15, totalPages = Math.ceil(gamepasses.length / itemsPerPage), start = page * itemsPerPage, end = start + itemsPerPage;
        const gpList = gamepasses.slice(start, end).map((gp, i) => `${start + i + 1}. **${gp.name}**\n   ID: ${gp.assetId || gp.id}`).join('\n\n');
        const embed = new EmbedBuilder().setColor('#FF69B4').setTitle('🎫 User GamePasses').setDescription(`**Roblox ID:** ${robloxId}\n\n${gpList}`).setFooter({ text: `Showing ${start + 1}-${Math.min(end, gamepasses.length)} of ${gamepasses.length} gamepasses | Page ${page + 1}/${totalPages}` });
        const buttons = new ActionRowBuilder();
        if (page > 0) buttons.addComponents(new ButtonBuilder().setCustomId(`gamepasses_${robloxId}_${page - 1}`).setLabel('◀ Back').setStyle(ButtonStyle.Secondary));
        if (end < gamepasses.length) buttons.addComponents(new ButtonBuilder().setCustomId(`gamepasses_${robloxId}_${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary));
        return interaction.editReply({ embeds: [embed], components: buttons.components.length > 0 ? [buttons] : [] });
      } catch (e) { return interaction.editReply({ content: `❌ Unable to fetch gamepasses` }); }
    }
    if (action === 'friends') {
      await interaction.deferReply({ ephemeral: true });
      try {
        let allFriends = [], cursor = '';
        while (allFriends.length < 1000) {
          const url = cursor ? `https://friends.roblox.com/v1/users/${robloxId}/friends?cursor=${cursor}` : `https://friends.roblox.com/v1/users/${robloxId}/friends`;
          const friendsRes = await axios.get(url);
          const friends = friendsRes.data.data || [];
          allFriends = allFriends.concat(friends);
          if (!friendsRes.data.nextPageCursor || friends.length === 0) break;
          cursor = friendsRes.data.nextPageCursor;
        }
        if (allFriends.length === 0) return interaction.editReply({ content: '📋 User has no friends!' });
        const itemsPerPage = 15, totalPages = Math.ceil(allFriends.length / itemsPerPage), start = page * itemsPerPage, end = start + itemsPerPage;
        const friendList = allFriends.slice(start, end).map((f, i) => 
          `${start + i + 1}. **${f.displayName || f.name}** · \`${f.name}\` · ID: \`${f.id}\``
        ).join('\n');
        const embed = new EmbedBuilder().setColor('#9B59B6').setTitle('👥 Additional Information - Friends').setDescription(`**Roblox ID:** ${robloxId}\n**Total Friends:** ${allFriends.length}\n\n${friendList}`).setFooter({ text: `Showing ${start + 1}-${Math.min(end, allFriends.length)} of ${allFriends.length} friends | Page ${page + 1}/${totalPages}` });
        const buttons = new ActionRowBuilder();
        if (page > 0) buttons.addComponents(new ButtonBuilder().setCustomId(`friends_${robloxId}_${page - 1}`).setLabel('◀ Back').setStyle(ButtonStyle.Secondary));
        if (end < allFriends.length) buttons.addComponents(new ButtonBuilder().setCustomId(`friends_${robloxId}_${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary));
        return interaction.editReply({ embeds: [embed], components: buttons.components.length > 0 ? [buttons] : [] });
      } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
    }
    if (action === 'badges') {
      await interaction.deferReply({ ephemeral: true });
      try {
        let allBadges = [], cursor = '', fetchCount = 0;
        while (allBadges.length < 10000) {
          const url = cursor ? `https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100&cursor=${cursor}` : `https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100`;
          try {
            const res = await axios.get(url, { timeout: 5000 });
            const badges = res.data.data || [];
            if (badges.length === 0) break;
            allBadges = allBadges.concat(badges);
            if (!res.data.nextPageCursor) break;
            cursor = res.data.nextPageCursor;
            fetchCount++;
            if (fetchCount > 100) break;
          } catch (err) { break; }
        }
        if (allBadges.length === 0) return interaction.editReply({ content: '📋 User has no badges!' });
        const itemsPerPage = 15, totalPages = Math.ceil(allBadges.length / itemsPerPage), start = page * itemsPerPage, end = start + itemsPerPage;
        const badgeList = allBadges.slice(start, end).map((b, i) => `${start + i + 1}. **${b.name}**\n   From: ${b.displayName || 'Unknown Game'}`).join('\n\n');
        const embed = new EmbedBuilder().setColor('#FFD700').setTitle('🎖️ User Badges').setDescription(`**Roblox ID:** ${robloxId}\n**Total Badges:** ${allBadges.length}\n\n${badgeList}`).setFooter({ text: `Showing ${start + 1}-${Math.min(end, allBadges.length)} of ${allBadges.length} badges | Page ${page + 1}/${totalPages}` });
        const buttons = new ActionRowBuilder();
        if (page > 0) buttons.addComponents(new ButtonBuilder().setCustomId(`badges_${robloxId}_${page - 1}`).setLabel('◀ Back').setStyle(ButtonStyle.Secondary));
        if (end < allBadges.length) buttons.addComponents(new ButtonBuilder().setCustomId(`badges_${robloxId}_${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary));
        return interaction.editReply({ embeds: [embed], components: buttons.components.length > 0 ? [buttons] : [] });
      } catch (e) { return interaction.editReply({ content: `❌ Error fetching badges: ${e.message}` }); }
    }
    return;
  }
  if (!interaction.isCommand()) return;
  const { commandName, guildId, user, options } = interaction;
  const noActivationRequired = ['activate', 'license'];
  if (!noActivationRequired.includes(commandName)) {
    const activated = await pool.query('SELECT license_key FROM guild_licenses WHERE guild_id = $1', [guildId]);
    if (activated.rows.length === 0) {
      return interaction.reply({ content: '❌ **Bot Not Activated**\n\nThis server needs a license to use RoNexus.\n\nUse `/activate YOUR-LICENSE-KEY` to activate.', ephemeral: true });
    }
  }
  // ============================================
  // ACTIVATE
  // ============================================
  if (commandName === 'activate') {
    const license = options.getString('license');
    try {
      const attempts = await pool.query('SELECT COUNT(*) FROM activation_attempts WHERE guild_id = $1 AND user_id = $2 AND attempt_time > NOW() - INTERVAL \'1 hour\'', [guildId, user.id]);
      if (parseInt(attempts.rows[0].count) >= 5) return interaction.reply({ content: '❌ Too many activation attempts. Please wait 1 hour.', flags: [MessageFlags.Ephemeral] });
      await pool.query('INSERT INTO activation_attempts (guild_id, user_id, success) VALUES ($1, $2, $3)', [guildId, user.id, false]);
      const limitCheck = await checkLicenseLimits(license, guildId);
      if (!limitCheck.allowed) return interaction.reply({ content: `❌ ${limitCheck.reason}`, flags: [MessageFlags.Ephemeral] });
      const guildCheck = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (guildCheck.rows.length > 0) return interaction.reply({ content: '✅ This server is already activated!', flags: [MessageFlags.Ephemeral] });
      await pool.query('INSERT INTO guild_licenses (guild_id, license_key) VALUES ($1, $2)', [guildId, license]);
      await pool.query('UPDATE activation_attempts SET success = true WHERE guild_id = $1 AND user_id = $2 AND attempt_time = (SELECT MAX(attempt_time) FROM activation_attempts WHERE guild_id = $1 AND user_id = $2)', [guildId, user.id]);
      const tierInfo = await getTierInfo(limitCheck.tier);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00FF00').setTitle('✅ RoNexus Activated!').setDescription(`**License Tier:** ${tierInfo.name}\n**Plan:** ${tierInfo.price}`).addFields({ name: '📊 Your Limits', value: `• Servers: ${tierInfo.maxServers === -1 ? 'Unlimited' : tierInfo.maxServers}\n• Groups: ${tierInfo.maxGroups === -1 ? 'Unlimited' : tierInfo.maxGroups}`, inline: false }, { name: '🚀 Next Steps', value: '• `/setverified @Role` - Set verified role\n• `/verify` - Verify Roblox\n• `/addgroup GROUP_ID API_KEY` - Connect Roblox group', inline: false })] });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, flags: [MessageFlags.Ephemeral] }); }
  }
  // ============================================
  // LICENSE
  // ============================================
  if (commandName === 'license') {
    try {
      const guildLicense = await pool.query('SELECT license_key FROM guild_licenses WHERE guild_id = $1', [guildId]);
      if (guildLicense.rows.length === 0) return interaction.reply({ content: '❌ No license found!', ephemeral: true });
      const licenseKey = guildLicense.rows[0].license_key;
      const licenseInfo = await pool.query('SELECT tier, max_servers, max_groups, is_active, expires_at, created_at FROM licenses WHERE license_key = $1', [licenseKey]);
      if (licenseInfo.rows.length === 0) return interaction.reply({ content: '❌ License not found!', ephemeral: true });
      const license = licenseInfo.rows[0];
      const tierInfo = await getTierInfo(license.tier);
      const serverCount = await pool.query('SELECT COUNT(*) FROM guild_licenses WHERE license_key = $1', [licenseKey]);
      const groupCount = await pool.query('SELECT COUNT(*) FROM roblox_groups WHERE guild_id = $1', [guildId]);
      const statusEmoji = license.is_active ? '🟢' : '🔴';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(license.is_active ? '#00FF00' : '#FF0000').setTitle('📋 License Status').setDescription(`**Tier:** ${tierInfo.name}\n**Status:** ${statusEmoji} ${license.is_active ? 'Active' : 'Inactive'}`).addFields({ name: '🖥️ Servers', value: `${serverCount.rows[0].count}/${tierInfo.maxServers === -1 ? '∞' : tierInfo.maxServers}`, inline: true }, { name: '👥 Groups', value: `${groupCount.rows[0].count}/${tierInfo.maxGroups === -1 ? '∞' : tierInfo.maxGroups}`, inline: true }, { name: '🔑 License Key', value: `||${licenseKey}||`, inline: false }).setFooter({ text: `Activated: ${new Date(license.created_at).toLocaleDateString()}` })], ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // SET VERIFIED ROLE
  // ============================================
  if (commandName === 'setverified') {
    const role = options.getRole('role');
    try {
      await pool.query(
        'INSERT INTO guild_config (guild_id, verified_role_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET verified_role_id = $2',
        [guildId, role.id]
      );
      await logActivity(guildId, 'config_change', `⚙️ <@${user.id}> set the verified role to ${role}`);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Verified Role Set')
          .setDescription(`Members will now receive ${role} when they verify their Roblox account.`)
          .addFields({ name: '💡 Tip', value: 'Use `/setunverified @Role` to set the role removed after verification.' })
        ],
        ephemeral: true
      });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // VERIFY
  // ============================================
  if (commandName === 'verify') {
    const alreadyVerified = await pool.query('SELECT roblox_username FROM verified_users WHERE guild_id = $1 AND user_id = $2', [guildId, user.id]);
    if (alreadyVerified.rows.length > 0) return interaction.reply({ content: `✅ You're already verified as **${alreadyVerified.rows[0].roblox_username}**!`, ephemeral: true });
    const state = `${guildId}_${user.id}_${Date.now()}`;
    pendingVerifications.set(state, { guildId, userId: user.id });
    const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=openid%20profile&response_type=code&state=${state}`;
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🔗 Verify with Roblox').setStyle(ButtonStyle.Link).setURL(authUrl));
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle('🔐 Verify Your Account').setDescription('Click the button below to verify with Roblox!')], components: [btn], ephemeral: true });
  }
  // ============================================
  // PROFILE
  // ============================================
  if (commandName === 'profile') {
    await interaction.deferReply();
    const input = options.getString('user');
    let targetUser = user;
    if (input) {
      const mention = input.match(/<@!?(\d+)>/);
      if (mention) {
        try { targetUser = await interaction.guild.members.fetch(mention[1]); } catch (e) { return interaction.editReply('❌ User not found!'); }
      }
    }
    const verified = await pool.query('SELECT roblox_id, roblox_username FROM verified_users WHERE guild_id = $1 AND user_id = $2', [guildId, targetUser.id]);
    if (verified.rows.length === 0) return interaction.editReply(`❌ **${targetUser.user?.tag || targetUser.tag}** is not verified!`);
    const robloxId = verified.rows[0].roblox_id, robloxUsername = verified.rows[0].roblox_username;
    try {
      const [robloxInfo, profilePic, userPoints] = await Promise.all([getRobloxUserInfo(robloxId), getProfilePicture(robloxId), pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetUser.id])]);
      if (!robloxInfo) return interaction.editReply('❌ Failed to fetch Roblox profile!');
      const accountAgeDays = Math.floor((Date.now() - new Date(robloxInfo.created).getTime()) / (1000 * 60 * 60 * 24));
      const points = userPoints.rows.length > 0 ? userPoints.rows[0].points : 0;
      const embed = new EmbedBuilder().setColor('#00a6ff').setTitle(`👤 Profile: ${robloxUsername}`).setDescription(`🔗 [View on Roblox](https://www.roblox.com/users/${robloxId}/profile)`).addFields({ name: '✅ Verified', value: '🟢 Yes', inline: true }, { name: '🆔 Roblox ID', value: robloxId, inline: true }, { name: '💰 Points', value: `${points}`, inline: true }, { name: '📅 Account Age', value: `${accountAgeDays} days`, inline: true }, { name: '💎 Premium', value: robloxInfo.hasVerifiedBadge ? '✅ Yes' : '❌ No', inline: true }, { name: '📱 Discord', value: `<@${targetUser.id}>`, inline: true }).setTimestamp();
      if (profilePic) embed.setThumbnail(profilePic);
      if (robloxInfo.displayName && robloxInfo.displayName !== robloxInfo.name) embed.addFields({ name: '📝 Display Name', value: robloxInfo.displayName, inline: false });
      return interaction.editReply({ embeds: [embed] });
    } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
  }
  // ============================================
  // UPDATE
  // ============================================
  if (commandName === 'update') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    try {
      const verified = await pool.query('SELECT roblox_id, roblox_username FROM verified_users WHERE guild_id = $1 AND user_id = $2', [guildId, user.id]);
      if (verified.rows.length === 0) return interaction.editReply('❌ You need to verify first! Use `/verify`');
      const { roblox_id, roblox_username } = verified.rows[0];
      const configRes = await pool.query('SELECT rank_abbreviation FROM guild_config WHERE guild_id = $1', [guildId]);
      const abbreviation = configRes.rows.length > 0 ? configRes.rows[0].rank_abbreviation : null;
      await updateNickname(interaction.guild, user.id, roblox_username, abbreviation);
      await giveVerifiedRole(interaction.guild, user.id);
      const groups = await pool.query('SELECT group_id, api_key FROM roblox_groups WHERE guild_id = $1', [guildId]);
      return interaction.editReply(`✅ Profile updated!\n\n• Nickname refreshed\n• Verified role added\n• ${groups.rows.length} group rank(s) synced`);
    } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
  }
  // ============================================
  // HELP
  // ============================================
  if (commandName === 'help') {
    const embed = new EmbedBuilder().setColor('#00a6ff').setTitle('📚 RoNexus Commands').setDescription('Complete command list').addFields(
      { name: '🔐 Verification', value: '`/verify` - Link Roblox\n`/profile @user` - View profile\n`/bgcheck username` - Background check\n`/update` - Refresh roles' },
      { name: '⚙️ Setup', value: '`/activate KEY` - Activate bot\n`/setverified @Role` - Set verified role\n`/setunverified @Role` - Set unverified role\n`/addgroup ID KEY` - Add Roblox group\n`/maprank @Role RANK_ID` - Map rank\n`/setlog #channel` - Set log channel\n`/setwelcome #channel msg` - Welcome message' },
      { name: '💰 Points', value: '`/points @user` - Check points\n`/addpoints @user 50` - Award points\n`/removepoints @user 25` - Remove points\n`/leaderboard` - Top members\n`/addrank @Role 100 "Member"` - Add rank' },
      { name: '🛡️ Moderation', value: '`/warn @user reason` - Warn\n`/viewwarns @user` - View warnings\n`/removewarn @user 1` - Remove warning #1\n`/kick @user` - Kick\n`/ban @user` - Ban' },
      { name: '🐱 Fun', value: '`/cat` - Random cat picture' },
      { name: '📢 Messaging', value: '`/announce #ch message` - Announce\n`/postembed #ch title message` - Embed\n`/dm @user message` - DM user\n`/sticky #ch message` - Sticky message' },
      { name: '📊 Data', value: '`/stats` - Server stats\n`/insights` - Detailed analytics\n`/export points` - Export CSV\n`/license` - License info' }
    ).setFooter({ text: 'ronexus.org' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  // ============================================
  // STATS
  // ============================================
  if (commandName === 'stats') {
    await interaction.deferReply();
    try {
      const [verifiedCount, pointsData, groupCount, warnCount] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM verified_users WHERE guild_id = $1', [guildId]),
        pool.query('SELECT COUNT(*), SUM(points), AVG(points) FROM user_points WHERE guild_id = $1', [guildId]),
        pool.query('SELECT COUNT(*) FROM roblox_groups WHERE guild_id = $1', [guildId]),
        pool.query('SELECT COUNT(*) FROM warnings WHERE guild_id = $1', [guildId])
      ]);
      const verified = parseInt(verifiedCount.rows[0].count);
      const totalUsers = interaction.guild.memberCount;
      const verificationRate = totalUsers > 0 ? ((verified / totalUsers) * 100).toFixed(1) : 0;
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#00a6ff').setTitle('📊 Server Statistics').addFields({ name: '👥 Members', value: `Total: ${totalUsers}\nVerified: ${verified}\nRate: ${verificationRate}%`, inline: true }, { name: '💰 Points', value: `Total: ${parseInt(pointsData.rows[0].sum || 0)}\nAverage: ${Math.round(parseFloat(pointsData.rows[0].avg || 0))}`, inline: true }, { name: '🎮 Integration', value: `Groups: ${groupCount.rows[0].count}\nWarnings: ${warnCount.rows[0].count}`, inline: true }).setTimestamp()] });
    } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
  }
  // ============================================
  // INSIGHTS
  // ============================================
  if (commandName === 'insights') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const [recentVerifications, topMembers, groupData, activityData] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM verified_users WHERE guild_id = $1 AND verified_at > NOW() - INTERVAL \'7 days\'', [guildId]),
        pool.query('SELECT user_id, points FROM user_points WHERE guild_id = $1 ORDER BY points DESC LIMIT 5', [guildId]),
        pool.query('SELECT COUNT(*) FROM roblox_groups WHERE guild_id = $1', [guildId]),
        pool.query('SELECT COUNT(*) FROM warnings WHERE guild_id = $1 AND timestamp > NOW() - INTERVAL \'30 days\'', [guildId])
      ]);
      const topMembersList = topMembers.rows.length > 0 ? topMembers.rows.map((m, i) => `**${i + 1}.** <@${m.user_id}> - ${m.points} points`).join('\n') : '📋 No data yet';
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#667eea').setTitle('📈 Server Insights').addFields({ name: '📅 This Week', value: `New Verifications: ${recentVerifications.rows[0].count}`, inline: false }, { name: '🏆 Top Members', value: topMembersList, inline: false }, { name: '🔗 Groups', value: `${groupData.rows[0].count} connected`, inline: true }, { name: '⚠️ Warnings (30d)', value: `${activityData.rows[0].count}`, inline: true }).setTimestamp()] });
    } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
  }
  // ============================================
  // SETPERMISSIONS
  // ============================================
  if (commandName === 'setpermissions') {
    const role = options.getRole('role');
    const command = options.getString('command');
    const allow = options.getBoolean('allow');
    try {
      if (allow) {
        await pool.query('INSERT INTO command_permissions (guild_id, role_id, command_name, allowed) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, role_id, command_name) DO UPDATE SET allowed = $4', [guildId, role.id, command, allow]);
      } else {
        await pool.query('DELETE FROM command_permissions WHERE guild_id = $1 AND role_id = $2 AND command_name = $3', [guildId, role.id, command]);
      }
      await logActivity(guildId, 'config_change', `⚙️ <@${user.id}> ${allow ? 'allowed' : 'denied'} ${role} to use \`/${command}\``);
      return interaction.reply({ content: `✅ ${role} ${allow ? 'can now' : 'can no longer'} use \`/${command}\``, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // SETWELCOME
  // ============================================
  if (commandName === 'setwelcome') {
    const channel = options.getChannel('channel');
    const message = options.getString('message');
    try {
      await pool.query('INSERT INTO guild_config (guild_id, welcome_channel_id, welcome_message) VALUES ($1, $2, $3) ON CONFLICT (guild_id) DO UPDATE SET welcome_channel_id = $2, welcome_message = $3', [guildId, channel.id, message]);
      return interaction.reply({ content: `✅ Welcome message set for ${channel}\n\n**Preview:**\n${message.replace(/{user}/g, `<@${user.id}>`).replace(/{server}/g, interaction.guild.name)}`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // SETLOG
  // ============================================
  if (commandName === 'setlog') {
    const channel = options.getChannel('channel');
    try {
      await pool.query('INSERT INTO guild_config (guild_id, log_channel_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET log_channel_id = $2', [guildId, channel.id]);
      await channel.send({ embeds: [new EmbedBuilder().setColor('#00FF00').setTitle('📋 Activity Logging Enabled').setDescription('This channel will now receive activity logs.').setTimestamp()] });
      return interaction.reply({ content: `✅ Activity logs will be posted in ${channel}`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // SETUNVERIFIED
  // ============================================
  if (commandName === 'setunverified') {
    const role = options.getRole('role');
    try {
      await pool.query('INSERT INTO guild_config (guild_id, unverified_role_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET unverified_role_id = $2', [guildId, role.id]);
      return interaction.reply({ content: `✅ Unverified role set to ${role}\n\nNew members will automatically receive this role until they verify.`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // SETUP
  // ============================================
  if (commandName === 'setup') {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setTitle('⚙️ Setup Guide').addFields(
      { name: '1️⃣ Set Verified Role', value: '`/setverified @YourVerifiedRole`' },
      { name: '2️⃣ Set Unverified Role (optional)', value: '`/setunverified @YourUnverifiedRole`' },
      { name: '3️⃣ Get Roblox API Key', value: 'Go to https://create.roblox.com/credentials → Create Open Cloud API key' },
      { name: '4️⃣ Add Your Group', value: '`/addgroup GROUP_ID YOUR_API_KEY`' },
      { name: '5️⃣ Map Ranks', value: '`/maprank @DiscordRole ROBLOX_RANK_ID`' },
      { name: '6️⃣ Add Point Ranks', value: '`/addrank @Role 100 "Member" CD`' },
      { name: '7️⃣ Verify Members', value: '`/verify` - Members verify Roblox' }
    )] });
  }
  // ============================================
  // ADDRANK
  // ============================================
  if (commandName === 'addrank') {
    const role = options.getRole('role');
    const points = options.getInteger('points');
    const name = options.getString('name');
    const abbreviation = options.getString('abbreviation');
    const order = await pool.query('SELECT COUNT(*) FROM ranks WHERE guild_id = $1', [guildId]);
    await pool.query('INSERT INTO ranks (guild_id, rank_name, role_id, points_required, rank_order) VALUES ($1, $2, $3, $4, $5)', [guildId, name, role.id, points, parseInt(order.rows[0].count) + 1]);
    if (abbreviation) {
      const abbr = abbreviation.toUpperCase().substring(0, 10);
      await pool.query('INSERT INTO guild_config (guild_id, rank_abbreviation) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET rank_abbreviation = $2', [guildId, abbr]);
      return interaction.reply({ content: `✅ **${name}** (${points} pts) → ${role}\n✅ Prefix set to **[${abbr}]**`, ephemeral: true });
    }
    return interaction.reply({ content: `✅ **${name}** (${points} pts) → ${role}`, ephemeral: true });
  }
  // ============================================
  // REMOVEABBREVIATION
  // ============================================
  if (commandName === 'removeabbreviation') {
    await pool.query('UPDATE guild_config SET rank_abbreviation = NULL WHERE guild_id = $1', [guildId]);
    return interaction.reply({ content: '✅ Prefix removed', ephemeral: true });
  }
  // ============================================
  // ADDGROUP
  // ============================================
  if (commandName === 'addgroup') {
    const groupId = options.getInteger('group_id');
    const apiKey = options.getString('api_key');
    try {
      const guildLicense = await pool.query('SELECT license_key FROM guild_licenses WHERE guild_id = $1', [guildId]);
      const licenseKey = guildLicense.rows[0].license_key;
      const licenseInfo = await pool.query('SELECT tier, max_groups FROM licenses WHERE license_key = $1', [licenseKey]);
      const license = licenseInfo.rows[0];
      if (license.max_groups > 0) {
        const groupCount = await pool.query('SELECT COUNT(*) FROM roblox_groups WHERE guild_id = $1', [guildId]);
        if (parseInt(groupCount.rows[0].count) >= license.max_groups) {
          const tierInfo = await getTierInfo(license.tier);
          return interaction.reply({ content: `❌ Group limit reached! (${license.max_groups} max on ${tierInfo.name})`, ephemeral: true });
        }
      }
      await pool.query('INSERT INTO roblox_groups (guild_id, group_id, api_key, auto_rank_enabled) VALUES ($1, $2, $3, true)', [guildId, groupId, apiKey]);
      return interaction.reply({ content: `✅ Added group **${groupId}**!\n\nUse \`/maprank @Role ROBLOX_RANK_ID\` to sync roles.`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // REMOVEGROUP
  // ============================================
  if (commandName === 'removegroup') {
    const groupId = options.getInteger('group_id');
    try {
      const result = await pool.query('DELETE FROM roblox_groups WHERE guild_id = $1 AND group_id = $2 RETURNING group_id', [guildId, groupId]);
      if (result.rows.length === 0) return interaction.reply({ content: `❌ Group **${groupId}** not found!`, ephemeral: true });
      await pool.query('DELETE FROM rank_mappings WHERE guild_id = $1', [guildId]);
      await logActivity(guildId, 'config_change', `🗑️ <@${user.id}> removed Roblox group **${groupId}**`);
      return interaction.reply({ content: `✅ Removed group **${groupId}**!`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // MAPRANK
  // ============================================
  if (commandName === 'maprank') {
    const role = options.getRole('discord_role');
    const robloxRankId = options.getInteger('roblox_rank_id');
    const group = await pool.query('SELECT id FROM roblox_groups WHERE guild_id = $1 LIMIT 1', [guildId]);
    if (group.rows.length === 0) return interaction.reply({ content: '❌ No Roblox groups added! Use `/addgroup` first.', ephemeral: true });
    await pool.query('INSERT INTO group_rank_mapping (roblox_group_id, discord_role_id, roblox_rank_id) VALUES ($1, $2, $3)', [group.rows[0].id, role.id, robloxRankId]);
    return interaction.reply({ content: `✅ Mapped ${role} ↔️ Roblox rank **${robloxRankId}**`, ephemeral: true });
  }
  // ============================================
  // POINTS
  // ============================================
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
  // ============================================
  // ADDPOINTS
  // ============================================
  if (commandName === 'addpoints') {
    const input = options.getString('user');
    const amount = options.getInteger('amount');
    const reason = options.getString('reason') || 'No reason provided';
    if (amount <= 0) return interaction.reply({ content: '❌ Amount must be positive!', ephemeral: true });
    let targetId = null;
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) targetId = mention[1];
    else {
      const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', [guildId, input]);
      if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
    }
    if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    const oldRes = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    const oldPoints = oldRes.rows.length > 0 ? oldRes.rows[0].points : 0;
    await pool.query('INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO UPDATE SET points = user_points.points + $3', [guildId, targetId, amount]);
    const newRes = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    await checkAndPromote(guildId, targetId, newRes.rows[0].points);
    await logActivity(guildId, 'points_added', `💰 <@${user.id}> awarded **${amount}** points to <@${targetId}>\n**Reason:** ${reason}\n**Balance:** ${oldPoints} → ${newRes.rows[0].points}`);
    return interaction.reply({ content: `✅ Awarded **${amount}** points to <@${targetId}>\n**Reason:** ${reason}\n**Balance:** ${oldPoints} → ${newRes.rows[0].points}` });
  }
  // ============================================
  // REMOVEPOINTS
  // ============================================
  if (commandName === 'removepoints') {
    const input = options.getString('user');
    const amount = options.getInteger('amount');
    const reason = options.getString('reason');
    if (amount <= 0) return interaction.reply({ content: '❌ Amount must be positive!', ephemeral: true });
    let targetId = null;
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) targetId = mention[1];
    else {
      const verified = await pool.query('SELECT user_id FROM verified_users WHERE guild_id = $1 AND roblox_username ILIKE $2', [guildId, input]);
      if (verified.rows.length > 0) targetId = verified.rows[0].user_id;
    }
    if (!targetId) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    const oldRes = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    const oldPoints = oldRes.rows.length > 0 ? oldRes.rows[0].points : 0;
    await pool.query('UPDATE user_points SET points = GREATEST(0, points - $1) WHERE guild_id = $2 AND user_id = $3', [amount, guildId, targetId]);
    const newRes = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, targetId]);
    const newPoints = newRes.rows.length > 0 ? newRes.rows[0].points : 0;
    await logActivity(guildId, 'points_removed', `💸 <@${user.id}> removed **${oldPoints - newPoints}** points from <@${targetId}>\n**Reason:** ${reason}\n**Balance:** ${oldPoints} → ${newPoints}`);
    return interaction.reply({ content: `✅ Removed **${oldPoints - newPoints}** points from <@${targetId}>\n**Reason:** ${reason}\n**Balance:** ${oldPoints} → ${newPoints}` });
  }
  // ============================================
  // LEADERBOARD
  // ============================================
  if (commandName === 'leaderboard') {
    const res = await pool.query('SELECT user_id, points FROM user_points WHERE guild_id = $1 ORDER BY points DESC LIMIT 10', [guildId]);
    if (res.rows.length === 0) return interaction.reply('📋 No points data yet!');
    const lb = res.rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> - **${r.points}** points`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Points Leaderboard').setDescription(lb)] });
  }
  // ============================================
  // BGCHECK
  // ============================================
  if (commandName === 'bgcheck') {
    await interaction.deferReply();
    const input = options.getString('username');
    let robloxId = null, robloxUsername = null;
    const mention = input.match(/<@!?(\d+)>/);
    if (mention) {
      const verified = await pool.query('SELECT roblox_id, roblox_username FROM verified_users WHERE guild_id = $1 AND user_id = $2', [guildId, mention[1]]);
      if (verified.rows.length === 0) return interaction.editReply('❌ User not verified!');
      robloxId = verified.rows[0].roblox_id; robloxUsername = verified.rows[0].roblox_username;
    } else {
      const lookup = await getRobloxIdFromUsername(input);
      if (!lookup) return interaction.editReply('❌ Roblox user not found!');
      robloxId = lookup.id; robloxUsername = lookup.username;
    }
    try {
      const robloxInfo = await getRobloxUserInfo(robloxId);
      if (!robloxInfo) return interaction.editReply('❌ Failed to fetch user info!');
      const [badgeCount, friendsRes, userGroups, isPrivate, nameData, profilePic] = await Promise.all([getAllBadges(robloxId), axios.get(`https://friends.roblox.com/v1/users/${robloxId}/friends/count`), getUserGroups(robloxId), checkIfPrivateProfile(robloxId), getPreviousUsernames(robloxId), getProfilePicture(robloxId)]);
      const friendCount = friendsRes.data.count || 0;
      const groupIds = userGroups.map(g => g.group.id);
      const allBlacklistedGroups = [...AUTO_BLACKLIST_GROUPS];
      const manualBlacklist = await pool.query('SELECT group_id FROM blacklisted_groups WHERE guild_id = $1', [guildId]);
      manualBlacklist.rows.forEach(r => allBlacklistedGroups.push(parseInt(r.group_id)));
      const inBlacklistedGroup = groupIds.some(id => allBlacklistedGroups.includes(id));
      const blacklistedGroups = userGroups.filter(g => allBlacklistedGroups.includes(g.group.id));
      const accountAgeDays = Math.floor((Date.now() - new Date(robloxInfo.created).getTime()) / (1000 * 60 * 60 * 24));
      const hasPremium = await checkPremium(robloxId);
      const hasVerifiedBadge = robloxInfo.hasVerifiedBadge || false;
      const badgeDisplay = badgeCount === -1 ? 'N/A (Private)' : `${badgeCount}`;
      const effectiveBadgeCount = badgeCount === -1 ? 0 : badgeCount;
      const altCheck = await detectAlts(robloxId, accountAgeDays, effectiveBadgeCount, friendCount, hasVerifiedBadge, hasPremium, inBlacklistedGroup);
      const riskScore = calculateRiskScore(accountAgeDays, effectiveBadgeCount, friendCount, hasVerifiedBadge, hasPremium, inBlacklistedGroup);
      const riskLevel = getRiskLevel(riskScore);
      await pool.query('INSERT INTO background_checks (guild_id, user_id, roblox_id, roblox_username, risk_score, risk_level, account_age_days, has_premium, total_badges, total_friends) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [guildId, mention ? mention[1] : 'manual', robloxId, robloxUsername, riskScore, riskLevel, accountAgeDays, hasPremium, effectiveBadgeCount, friendCount]);
      const riskColor = riskLevel === 'CRITICAL' ? '#FF0000' : riskLevel === 'HIGH' ? '#FFA500' : riskLevel === 'MEDIUM' ? '#FFFF00' : '#00FF00';
      const altColor = altCheck.altScore >= 60 ? '🚨' : altCheck.altScore >= 40 ? '⚠️' : altCheck.altScore >= 20 ? '⚡' : '✅';
      const { previousNames, displayName: robloxDisplayName } = nameData;
      let namesInfo = '`None found`';
      const nameParts = [];
      if (robloxDisplayName && robloxDisplayName !== robloxUsername) {
        nameParts.push(`**Display Name:** ${robloxDisplayName}`);
      }
      if (previousNames.length > 0) {
        nameParts.push(`**Past Usernames:** ${previousNames.map(n => `\`${n}\``).join(', ')}`);
      }
      if (nameParts.length > 0) namesInfo = nameParts.join('\n');
      const embed = new EmbedBuilder().setColor(riskColor).setTitle('🔍 Background Check').setDescription(`**${robloxUsername}** (ID: ${robloxId})\n🔗 [View Profile](https://www.roblox.com/users/${robloxId}/profile)`).addFields(
        { name: '⚠️ Risk Level', value: `${riskLevel} (${riskScore}/10)`, inline: true },
        { name: '🔒 Profile', value: isPrivate ? '🔐 Private' : '🌐 Public', inline: true },
        { name: '📅 Account Age', value: `${accountAgeDays} days`, inline: true },
        { name: '🎖️ Badges', value: badgeDisplay, inline: true },
        { name: '👥 Friends', value: `${friendCount}`, inline: true },
        { name: '💎 Premium', value: hasPremium ? '✅ Yes' : '❌ No', inline: true },
        { name: '✅ Verified Badge', value: hasVerifiedBadge ? '✅ Yes' : '❌ No', inline: true },
        { name: '📝 Names', value: namesInfo, inline: false },
        { name: '🔄 Alt Detection', value: `${altColor} **${altCheck.confidence}**\n**Score:** ${altCheck.altScore}/100\n**Indicators:** ${altCheck.reason}`, inline: false }
      );
      if (profilePic) embed.setThumbnail(profilePic);
      if (inBlacklistedGroup) embed.addFields({ name: '🚨 BLACKLISTED GROUPS', value: blacklistedGroups.map(g => `• **${g.group.name}** (${g.group.id})`).join('\n') });
      embed.setFooter({ text: 'Click buttons below for more info' });
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`xtracker_${robloxId}_0`).setLabel('🔎 XTracker').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`groups_${robloxId}_0`).setLabel('👥 Groups').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`games_${robloxId}_0`).setLabel('🎮 Games').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gamepasses_${robloxId}_0`).setLabel('🎫 GamePasses').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`badges_${robloxId}_0`).setLabel('🎖️ Badges').setStyle(ButtonStyle.Success)
      );
      const buttons2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`friends_${robloxId}_0`).setLabel('👥 Friends').setStyle(ButtonStyle.Secondary));
      return interaction.editReply({ embeds: [embed], components: [buttons, buttons2] });
    } catch (e) { return interaction.editReply(`❌ Error: ${e.message}`); }
  }
  // ============================================
  // BLACKLIST COMMANDS
  // ============================================
  if (commandName === 'blacklist-user') {
    const username = options.getString('roblox_username'), reason = options.getString('reason');
    const lookup = await getRobloxIdFromUsername(username);
    if (!lookup) return interaction.reply({ content: '❌ User not found!', ephemeral: true });
    await pool.query('INSERT INTO blacklisted_users (guild_id, roblox_user_id, roblox_username, reason) VALUES ($1, $2, $3, $4)', [guildId, lookup.id, lookup.username, reason]);
    return interaction.reply({ content: `🚫 Blacklisted **${lookup.username}**\n**Reason:** ${reason}` });
  }
  if (commandName === 'blacklist-group') {
    const groupId = options.getInteger('group_id'), reason = options.getString('reason');
    try {
      const groupInfo = await axios.get(`https://groups.roblox.com/v1/groups/${groupId}`);
      await pool.query('INSERT INTO blacklisted_groups (guild_id, group_id, group_name, reason) VALUES ($1, $2, $3, $4)', [guildId, groupId, groupInfo.data.name, reason]);
      return interaction.reply({ content: `🚫 Blacklisted **${groupInfo.data.name}** (${groupId})\n**Reason:** ${reason}` });
    } catch (e) { return interaction.reply({ content: '❌ Invalid group ID!', ephemeral: true }); }
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
  if (commandName === 'viewblacklists') {
    const users = await pool.query('SELECT roblox_username, reason FROM blacklisted_users WHERE guild_id = $1 LIMIT 10', [guildId]);
    const groups = await pool.query('SELECT group_name, group_id, reason FROM blacklisted_groups WHERE guild_id = $1 LIMIT 10', [guildId]);
    if (users.rows.length === 0 && groups.rows.length === 0) return interaction.reply('📋 No blacklists in this server.');
    const embed = new EmbedBuilder().setTitle('🚫 Server Blacklists').setColor('#FF0000');
    if (users.rows.length > 0) embed.addFields({ name: 'Blacklisted Users', value: users.rows.map(r => `• **${r.roblox_username}** - ${r.reason}`).join('\n') });
    if (groups.rows.length > 0) embed.addFields({ name: 'Blacklisted Groups', value: groups.rows.map(r => `• **${r.group_name}** (${r.group_id}) - ${r.reason}`).join('\n') });
    embed.addFields({ name: 'Auto-Blacklisted Groups', value: '• Log4Shell (35367142)\n• qlz (35447047)\n• Chosen Twenty (35163259)\n• C20Ware (35361192)\n• Chosen 20 (14000981)\n• Chosen 20 uniforms (14680340)' });
    return interaction.reply({ embeds: [embed] });
  }
  // ============================================
  // MODERATION
  // ============================================
  if (commandName === 'viewwarns') {
    const target = options.getUser('user');
    const warns = await pool.query('SELECT id, reason, moderator_id, timestamp FROM warnings WHERE guild_id = $1 AND user_id = $2 ORDER BY timestamp DESC LIMIT 10', [guildId, target.id]);
    if (warns.rows.length === 0) return interaction.reply({ content: `📋 ${target.username} has no warnings.`, ephemeral: true });
    const embed = new EmbedBuilder().setColor('#FFA500').setTitle(`⚠️ Warnings for ${target.username}`).setDescription(warns.rows.map((w, i) => `**${i + 1}.** ${w.reason}\n• By: <@${w.moderator_id}> • ${new Date(w.timestamp).toLocaleDateString()}`).join('\n\n')).setFooter({ text: `Total: ${warns.rows.length} | Use /removewarn to remove one` });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  // ============================================
  // REMOVEWARN
  // ============================================
  if (commandName === 'removewarn') {
    const target = options.getUser('user');
    const warnNumber = options.getInteger('warn_number');
    try {
      // Get warnings in same order as viewwarns
      const warns = await pool.query(
        'SELECT id, reason FROM warnings WHERE guild_id = $1 AND user_id = $2 ORDER BY timestamp DESC LIMIT 10',
        [guildId, target.id]
      );
      if (warns.rows.length === 0) return interaction.reply({ content: `📋 ${target.username} has no warnings.`, ephemeral: true });
      if (warnNumber < 1 || warnNumber > warns.rows.length) {
        return interaction.reply({ content: `❌ Invalid warning number. ${target.username} has **${warns.rows.length}** warning(s). Use \`/viewwarns\` to see them.`, ephemeral: true });
      }
      const warnToRemove = warns.rows[warnNumber - 1];
      await pool.query('DELETE FROM warnings WHERE id = $1', [warnToRemove.id]);
      await logActivity(guildId, 'warning', `🗑️ <@${user.id}> removed warning #${warnNumber} from <@${target.id}>\n**Removed Warning:** ${warnToRemove.reason}`);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Warning Removed')
          .setDescription(`Removed warning **#${warnNumber}** from ${target}`)
          .addFields({ name: '📝 Warning was', value: warnToRemove.reason })
          .setFooter({ text: `${warns.rows.length - 1} warning(s) remaining` })
        ]
      });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // CAT
  // ============================================
  if (commandName === 'cat') {
    await interaction.deferReply();
    try {
      const res = await axios.get('https://api.thecatapi.com/v1/images/search', { timeout: 5000 });
      const cat = res.data[0];
      const embed = new EmbedBuilder()
        .setColor('#FFB347')
        .setTitle('🐱 Random Cat!')
        .setImage(cat.url)
        .setFooter({ text: 'Powered by TheCatAPI • Use /cat again for another!' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      return interaction.editReply({ content: '❌ Couldn\'t fetch a cat right now. Try again!' });
    }
  }
  if (commandName === 'kick') {
    const target = options.getUser('user'), reason = options.getString('reason') || 'No reason provided';
    if (target.id === user.id) return interaction.reply({ content: '❌ You cannot kick yourself!', flags: [MessageFlags.Ephemeral] });
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
      await logActivity(guildId, 'kick', `👢 ${target} kicked by <@${user.id}>\n**Reason:** ${reason}`);
      return interaction.reply({ content: `👢 Kicked ${target}\n**Reason:** ${reason}` });
    } catch (e) { return interaction.reply({ content: '❌ Cannot kick this user!', flags: [MessageFlags.Ephemeral] }); }
  }
  if (commandName === 'ban') {
    const target = options.getUser('user'), reason = options.getString('reason') || 'No reason provided';
    if (target.id === user.id) return interaction.reply({ content: '❌ You cannot ban yourself!', flags: [MessageFlags.Ephemeral] });
    try {
      await interaction.guild.members.ban(target, { reason });
      await logActivity(guildId, 'ban', `🔨 ${target} banned by <@${user.id}>\n**Reason:** ${reason}`);
      return interaction.reply({ content: `🔨 Banned ${target}\n**Reason:** ${reason}` });
    } catch (e) { return interaction.reply({ content: '❌ Cannot ban this user!', ephemeral: true }); }
  }
  if (commandName === 'warn') {
    const target = options.getUser('user'), reason = options.getString('reason');
    try {
      await pool.query('INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES ($1, $2, $3, $4)', [guildId, target.id, user.id, reason]);
      await logActivity(guildId, 'warning', `⚠️ ${target} warned by <@${user.id}>\n**Reason:** ${reason}`);
      return interaction.reply({ content: `⚠️ Warned ${target}\n**Reason:** ${reason}` });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // MESSAGING
  // ============================================
  if (commandName === 'announce') {
    const channel = options.getChannel('channel'), message = options.getString('message');
    try {
      if (!channel.isTextBased()) return interaction.reply({ content: '❌ Please select a text channel.', ephemeral: true });
      await channel.send(message);
      await logActivity(guildId, 'config_change', `📢 <@${user.id}> posted announcement in ${channel}`);
      return interaction.reply({ content: `✅ Announcement posted in ${channel}`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  if (commandName === 'postembed') {
    const channel = options.getChannel('channel'), title = options.getString('title'), message = options.getString('message'), color = options.getString('color') || '#00a6ff';
    try {
      if (!channel.isTextBased()) return interaction.reply({ content: '❌ Please select a text channel.', ephemeral: true });
      await channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(message).setColor(color).setTimestamp()] });
      await logActivity(guildId, 'config_change', `📢 <@${user.id}> posted embed in ${channel}\n**Title:** ${title}`);
      return interaction.reply({ content: `✅ Embed posted in ${channel}`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  if (commandName === 'dm') {
    const target = options.getUser('user'), message = options.getString('message'), useEmbed = options.getBoolean('embed') || false, title = options.getString('title'), color = options.getString('color') || '#00a6ff';
    try {
      if (useEmbed) {
        const embedMsg = new EmbedBuilder().setColor(color).setDescription(message).setFooter({ text: `From ${interaction.guild.name} Staff` }).setTimestamp();
        if (title) embedMsg.setTitle(title);
        await target.send({ embeds: [embedMsg] });
      } else {
        await target.send(`**📩 Message from ${interaction.guild.name} Staff:**\n\n${message}`);
      }
      await logActivity(guildId, 'dm_sent', `📧 <@${user.id}> sent DM to **${target.tag}**\n**Message:** ${message.substring(0, 150)}`);
      return interaction.reply({ content: `✅ DM sent to ${target.username}`, ephemeral: true });
    } catch (e) {
      if (e.code === 50007) return interaction.reply({ content: `❌ Cannot DM ${target.username} — DMs may be disabled.`, ephemeral: true });
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
    }
  }
  // ============================================
  // STICKY
  // ============================================
  if (commandName === 'sticky') {
    const channel = options.getChannel('channel'), message = options.getString('message');
    try {
      const msg = await channel.send(message);
      await pool.query('INSERT INTO sticky_messages (guild_id, channel_id, message_content, last_message_id) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, channel_id) DO UPDATE SET message_content = $3, last_message_id = $4', [guildId, channel.id, message, msg.id]);
      await logActivity(guildId, 'config_change', `📌 <@${user.id}> created sticky in ${channel}`);
      return interaction.reply({ content: `✅ Sticky message created in ${channel}`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  if (commandName === 'removesticky') {
    const channel = options.getChannel('channel');
    try {
      const result = await pool.query('DELETE FROM sticky_messages WHERE guild_id = $1 AND channel_id = $2 RETURNING last_message_id', [guildId, channel.id]);
      if (result.rows.length === 0) return interaction.reply({ content: `❌ No sticky in ${channel}`, ephemeral: true });
      try { const lastMsg = await channel.messages.fetch(result.rows[0].last_message_id); await lastMsg.delete(); } catch (e) {}
      return interaction.reply({ content: `✅ Sticky removed from ${channel}`, ephemeral: true });
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }
  }
  // ============================================
  // EXPORT
  // ============================================
  if (commandName === 'export') {
    const type = options.getString('type');
    await interaction.deferReply({ ephemeral: true });
    try {
      let data = '', filename = '';
      if (type === 'points') {
        const result = await pool.query('SELECT user_id, points FROM user_points WHERE guild_id = $1 ORDER BY points DESC', [guildId]);
        data = 'User ID,Points\n' + result.rows.map(r => `${r.user_id},${r.points}`).join('\n');
        filename = `points_${guildId}_${Date.now()}.csv`;
      } else if (type === 'verifications') {
        const result = await pool.query('SELECT user_id, roblox_id, roblox_username, verified_at FROM verified_users WHERE guild_id = $1 ORDER BY verified_at DESC', [guildId]);
        data = 'Discord ID,Roblox ID,Roblox Username,Verified At\n' + result.rows.map(r => `${r.user_id},${r.roblox_id},${r.roblox_username},${r.verified_at}`).join('\n');
        filename = `verifications_${guildId}_${Date.now()}.csv`;
      } else if (type === 'warnings') {
        const result = await pool.query('SELECT user_id, reason, moderator_id, timestamp FROM warnings WHERE guild_id = $1 ORDER BY timestamp DESC', [guildId]);
        data = 'User ID,Reason,Moderator ID,Timestamp\n' + result.rows.map(r => `${r.user_id},"${r.reason}",${r.moderator_id},${r.timestamp}`).join('\n');
        filename = `warnings_${guildId}_${Date.now()}.csv`;
      } else if (type === 'blacklists') {
        const users = await pool.query('SELECT roblox_username, reason FROM blacklisted_users WHERE guild_id = $1', [guildId]);
        const groups = await pool.query('SELECT group_name, group_id, reason FROM blacklisted_groups WHERE guild_id = $1', [guildId]);
        data = 'Type,Name/ID,Reason\n' + users.rows.map(r => `User,${r.roblox_username},"${r.reason}"`).join('\n') + '\n' + groups.rows.map(r => `Group,"${r.group_name} (${r.group_id})","${r.reason}"`).join('\n');
        filename = `blacklists_${guildId}_${Date.now()}.csv`;
      }
      const { AttachmentBuilder } = require('discord.js');
      const buffer = Buffer.from(data, 'utf-8');
      const attachment = new AttachmentBuilder(buffer, { name: filename });
      return interaction.editReply({ content: `✅ Exported successfully`, files: [attachment] });
    } catch (e) { return interaction.editReply({ content: `❌ Export failed: ${e.message}` }); }
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
    const tokenRes = await axios.post('https://apis.roblox.com/oauth/v1/token', `client_id=${ROBLOX_CLIENT_ID}&client_secret=${ROBLOX_CLIENT_SECRET}&grant_type=authorization_code&code=${code}`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const userRes = await axios.get('https://apis.roblox.com/oauth/v1/userinfo', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const { sub: robloxId, preferred_username: robloxUsername } = userRes.data;
    await pool.query('INSERT INTO verified_users (user_id, guild_id, roblox_id, roblox_username) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO UPDATE SET roblox_id = $3, roblox_username = $4', [pending.userId, pending.guildId, robloxId, robloxUsername]);
    await pool.query('INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [pending.guildId, pending.userId]);
    const guild = client.guilds.cache.get(pending.guildId);
    if (guild) {
      await pool.query('INSERT INTO guild_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [pending.guildId]);
      const configRes = await pool.query('SELECT rank_abbreviation, unverified_role_id FROM guild_config WHERE guild_id = $1', [pending.guildId]);
      const abbreviation = configRes.rows.length > 0 ? configRes.rows[0].rank_abbreviation : null;
      await updateNickname(guild, pending.userId, robloxUsername, abbreviation);
      await giveVerifiedRole(guild, pending.userId);
      await logActivity(pending.guildId, 'verification', `✅ <@${pending.userId}> verified as **${robloxUsername}** (ID: ${robloxId})`);
    }
    pendingVerifications.delete(state);
    res.send(`<!DOCTYPE html><html><head><title>✅ Verified - RoNexus</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#030712 0%,#0b1120 100%);color:white}.container{text-align:center;padding:60px 40px;max-width:500px}.logo{font-size:48px;font-weight:800;margin-bottom:40px;letter-spacing:-1px}.logo-ro{color:#0ea5e9}.checkmark{width:80px;height:80px;border-radius:50%;background:rgba(34,197,94,0.15);border:2px solid #22c55e;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;animation:scaleIn 0.5s ease-out}@keyframes scaleIn{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}.checkmark svg{width:48px;height:48px;stroke:#22c55e;stroke-width:4;fill:none;stroke-linecap:round;stroke-linejoin:round;animation:draw 0.8s ease-out 0.3s forwards;stroke-dasharray:100;stroke-dashoffset:100}@keyframes draw{to{stroke-dashoffset:0}}h1{font-size:36px;margin-bottom:16px;color:#22c55e}.box{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:28px;border-radius:16px;margin:24px 0}.username{font-size:28px;font-weight:700;color:#0ea5e9;margin-bottom:16px}.detail{font-size:14px;color:#94a3b8;margin:8px 0}.footer{margin-top:24px;font-size:13px;color:#475569}</style></head><body><div class="container"><div class="logo"><span class="logo-ro">Ro</span>Nexus</div><div class="checkmark"><svg viewBox="0 0 52 52"><path d="M14 27l7 7 16-16"/></svg></div><h1>Verified!</h1><div class="box"><div class="username">🎮 ${robloxUsername}</div><div class="detail">✅ Discord Nickname Updated</div><div class="detail">🎭 Verified Role Granted</div><div class="detail">🔗 Account Linked</div></div><div class="footer">You can close this page and return to Discord</div></div></body></html>`);
  } catch (e) { res.send(`<h1>❌ Verification Failed</h1><p>${e.message}</p>`); }
});
// ============================================
// WHOP WEBHOOK
// ============================================
app.post('/whop/webhook', express.json(), async (req, res) => {
  try {
    const event = req.body;
    const action = event.action;
    const membership = event.data;
    if (action === 'membership.created' || action === 'membership.renewed') {
      const planId = membership.plan_id;
      const membershipId = membership.id;
      let tier = 'starter', maxServers = 1, maxGroups = 3;
      if (planId === process.env.WHOP_PLAN_PROFESSIONAL) { tier = 'professional'; maxServers = 5; maxGroups = 10; }
      else if (planId === process.env.WHOP_PLAN_ENTERPRISE) { tier = 'enterprise'; maxServers = -1; maxGroups = -1; }
      const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 30);
      const licenseKey = `RONEXUS-${tier.toUpperCase()}-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;
      await pool.query(`INSERT INTO licenses (license_key, whop_membership_id, tier, max_servers, max_groups, is_active, expires_at) VALUES ($1, $2, $3, $4, $5, true, $6) ON CONFLICT (whop_membership_id) DO UPDATE SET is_active = true, expires_at = $6, tier = $3, max_servers = $4, max_groups = $5, updated_at = NOW()`, [licenseKey, membershipId, tier, maxServers, maxGroups, expiresAt]);
      console.log(`✅ License created: ${licenseKey}`);
    } else if (action === 'membership.cancelled' || action === 'membership.expired') {
      await pool.query('UPDATE licenses SET is_active = false, updated_at = NOW() WHERE whop_membership_id = $1', [membership.id]);
    }
    res.status(200).json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ============================================
// WEB SERVER
// ============================================
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/RoNexus.png', (req, res) => res.sendFile(__dirname + '/RoNexus.png'));
app.get('/seb.webp', (req, res) => res.sendFile(__dirname + '/seb.webp'));
app.get('/admin/create-enterprise-license', async (req, res) => {
  try {
    const licenseKey = 'RONEXUS-ENTERPRISE-TEST-FREE';
    const existing = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [licenseKey]);
    if (existing.rows.length > 0) return res.send('✅ License already exists! Use: /activate RONEXUS-ENTERPRISE-TEST-FREE');
    await pool.query('INSERT INTO licenses (license_key, tier, max_servers, max_groups, is_active) VALUES ($1, $2, $3, $4, $5)', [licenseKey, 'enterprise', -1, -1, true]);
    res.send(`<h1>✅ Enterprise License Created!</h1><p>Key: <strong>RONEXUS-ENTERPRISE-TEST-FREE</strong></p><p>Use /activate RONEXUS-ENTERPRISE-TEST-FREE in Discord</p>`);
  } catch (e) { res.send(`❌ Error: ${e.message}`); }
});
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));
setInterval(() => console.log('🔄 Keep-alive'), 300000);
client.login(process.env.DISCORD_TOKEN);
