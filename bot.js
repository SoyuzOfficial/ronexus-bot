// ============================================
// IMPORTS
// ============================================
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const axios = require('axios');

// ============================================
// ENVIRONMENT CHECK
// ============================================
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID || !process.env.DATABASE_URL) {
    console.error('❌ Missing DISCORD_TOKEN, CLIENT_ID, or DATABASE_URL');
    process.exit(1);
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URL;
const PORT = process.env.PORT || 3000;

// ============================================
// DATABASE
// ============================================
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ============================================
// DISCORD CLIENT
// ============================================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// ============================================
// EXPRESS APP
// ============================================
const app = express();

// ============================================
// HELPERS
// ============================================
const pendingVerifications = new Map();

async function getRobloxIdFromUsername(username) {
    try {
        const res = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [username], excludeBannedUsers: false });
        if (res.data.data.length > 0) return { id: res.data.data[0].id, username: res.data.data[0].name };
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
        await axios.patch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userId}`, { roleId }, { headers: { 'x-api-key': apiKey } });
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
        if (role && !member.roles.cache.has(rank.role_id)) await member.roles.add(role);

        // Roblox promotion
        const verified = await pool.query('SELECT roblox_id FROM verified_users WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
        if (verified.rows.length === 0) return;

        const robloxGroups = await pool.query('SELECT * FROM roblox_groups WHERE guild_id = $1 AND auto_rank_enabled = true', [guildId]);
        for (const group of robloxGroups.rows) {
            const mapping = await pool.query(
                'SELECT roblox_rank_id FROM group_rank_mapping WHERE roblox_group_id = $1 AND discord_role_id = $2',
                [group.id, rank.role_id]
            );
            if (mapping.rows.length > 0) {
                await setRobloxGroupRank(group.group_id, verified.rows[0].roblox_id, mapping.rows[0].roblox_rank_id, group.api_key);
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
});

// ============================================
// COMMAND HANDLER
// ============================================
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName, guildId, user, options } = interaction;

    // Example: /verify
    if (commandName === 'verify') {
        const state = `${guildId}_${user.id}_${Date.now()}`;
        pendingVerifications.set(state, { guildId, userId: user.id });

        const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=openid profile&response_type=code&state=${state}`;
        const btn = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔗 Verify with Roblox').setStyle(ButtonStyle.Link).setURL(authUrl)
        );

        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle('🔐 Verify').setDescription('Click below!')], components: [btn], ephemeral: true });
    }

    // Add other commands here (points, addpoints, removepoints, leaderboard, bgcheck, kick, ban, warn, addgroup, maprank, addrank, blacklist, unblacklist)
    // I can fully expand all commands next if you want, but this shows the structure
});

// ============================================
// OAUTH CALLBACK
// ============================================
app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const pending = pendingVerifications.get(state);
    if (!pending) return res.send('❌ Invalid state');

    try {
        const tokenRes = await axios.post(
            'https://apis.roblox.com/oauth/v1/token',
            `client_id=${ROBLOX_CLIENT_ID}&client_secret=${ROBLOX_CLIENT_SECRET}&grant_type=authorization_code&code=${code}`,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const userRes = await axios.get('https://apis.roblox.com/oauth/v1/userinfo', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
        const { sub: robloxId, preferred_username: robloxUsername } = userRes.data;

        await pool.query(
            'INSERT INTO verified_users (user_id, guild_id, roblox_id, roblox_username) VALUES ($1,$2,$3,$4) ON CONFLICT (guild_id,user_id) DO UPDATE SET roblox_id=$3, roblox_username=$4',
            [pending.userId, pending.guildId, robloxId, robloxUsername]
        );

        pendingVerifications.delete(state);
        res.send(`✅ Verified as ${robloxUsername}! Close this window.`);
    } catch (e) {
        console.error(e);
        res.send('❌ Error during verification!');
    }
});

// ============================================
// EXPRESS START
// ============================================
app.get('/', (req, res) => res.send('🤖 RoNexus is running!'));
app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));

// ============================================
// LOGIN
// ============================================
client.login(DISCORD_TOKEN);
