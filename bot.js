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

client.once('clientReady', async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  
  const commands = [
    { name: 'activate', description: 'Activate bot with license', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
    { name: 'verify', description: 'Verify Roblox account' },
    { name: 'setup', description: 'Server setup wizard', default_member_permissions: '8' },
    { name: 'points', description: 'Check points', options: [{ name: 'user', description: 'Target user', type: 6 }] },
    { name: 'addpoints', description: 'Add points', default_member_permissions: '8', options: [{ name: 'user', description: 'Target user', type: 6, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'removepoints', description: 'Remove points', default_member_permissions: '8', options: [{ name: 'user', description: 'Target user', type: 6, required: true }, { name: 'amount', description: 'Amount', type: 4, required: true }] },
    { name: 'leaderboard', description: 'Points leaderboard' },
    { name: 'backgroundcheck', description: 'Check user', options: [{ name: 'user', description: 'Target user', type: 6, required: true }] },
    { name: 'blacklist', description: 'Blacklist user', default_member_permissions: '8', options: [{ name: 'roblox_id', description: 'Roblox ID', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] },
    { name: 'unblacklist', description: 'Remove blacklist', default_member_permissions: '8', options: [{ name: 'roblox_id', description: 'Roblox ID', type: 4, required: true }] },
    { name: 'viewblacklist', description: 'View blacklist' },
    { name: 'kick', description: 'Kick user', default_member_permissions: '2', options: [{ name: 'user', description: 'Target user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'ban', description: 'Ban user', default_member_permissions: '4', options: [{ name: 'user', description: 'Target user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3 }] },
    { name: 'warn', description: 'Warn user', default_member_permissions: '8', options: [{ name: 'user', description: 'Target user', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] }
  ];

  await client.application.commands.set(commands);
  console.log('✅ Commands registered!');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const { commandName, guildId, user, options } = interaction;

  if (commandName === 'activate') {
  const license = options.getString('license');
  try {
    // Check license exists
    const licCheck = await pool.query('SELECT * FROM licenses WHERE license_key = $1 AND is_active = true', [license]);
    if (licCheck.rows.length === 0) {
      return interaction.reply({ content: '❌ Invalid license key!', ephemeral: true });
    }

    // Check if already activated
    const guildCheck = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
    if (guildCheck.rows.length > 0) {
      return interaction.reply({ content: '✅ Server already activated!', ephemeral: true });
    }

    // Activate server
    await pool.query(
      'INSERT INTO guild_licenses (guild_id, license_key, activated_by) VALUES ($1, $2, $3)', 
      [guildId, license, user.id]
    );

    // Create guild config (if doesn't exist)
    await pool.query(
  'INSERT INTO guild_licenses (guild_id, license_key) VALUES ($1, $2)', 
  [guildId, license]
);

    return interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Bot Activated!')
        .setDescription(`Server successfully activated!\n\nUse \`/verify\` to link your Roblox account.`)
      ] 
    });

  } catch (e) { 
    console.error('Activation error:', e); 
    return interaction.reply({ 
      content: `❌ Activation error: ${e.message}`, 
      ephemeral: true 
    }); 
  }
}

  const activated = await pool.query('SELECT * FROM guild_licenses WHERE guild_id = $1', [guildId]);
  if (activated.rows.length === 0 && commandName !== 'activate') {
    return interaction.reply({ content: '❌ Not activated! Use `/activate` with your license key.', ephemeral: true });
  }

  if (commandName === 'verify') {
    const state = `${guildId}_${user.id}_${Date.now()}`;
    pendingVerifications.set(state, { guildId, userId: user.id });
    const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=openid profile&response_type=code&state=${state}`;
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Verify with Roblox').setStyle(ButtonStyle.Link).setURL(authUrl));
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle('🔐 Verification').setDescription('Click to verify!')], components: [btn], ephemeral: true });
  }

  if (commandName === 'setup') {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setTitle('⚙️ Setup').addFields({ name: '1️⃣', value: 'Use `/activate` with license' }, { name: '2️⃣', value: 'Use `/verify` to link Roblox' })] });
  }

  if (commandName === 'points') {
    const target = options.getUser('user') || user;
    const res = await pool.query('SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2', [guildId, target.id]);
    const pts = res.rows.length > 0 ? res.rows[0].points : 0;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('💰 Points').setDescription(`${target} has **${pts}** points`)] });
  }

  if (commandName === 'addpoints') {
    const target = options.getUser('user');
    const amount = options.getInteger('amount');
    const reason = options.getString('reason') || 'None';
    await pool.query('INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO UPDATE SET points = user_points.points + $3', [guildId, target.id, amount]);
    return interaction.reply({ content: `✅ +${amount} points to ${target}` });
  }

  if (commandName === 'removepoints') {
    const target = options.getUser('user');
    const amount = options.getInteger('amount');
    await pool.query('UPDATE user_points SET points = GREATEST(0, points - $1) WHERE guild_id = $2 AND user_id = $3', [amount, guildId, target.id]);
    return interaction.reply({ content: `✅ -${amount} points from ${target}` });
  }

  if (commandName === 'leaderboard') {
    const res = await pool.query('SELECT user_id, points FROM user_points WHERE guild_id = $1 ORDER BY points DESC LIMIT 10', [guildId]);
    if (res.rows.length === 0) return interaction.reply('📋 No data yet!');
    const lb = res.rows.map((r, i) => `${i + 1}. <@${r.user_id}> - ${r.points} pts`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Leaderboard').setDescription(lb)] });
  }

  if (commandName === 'backgroundcheck') {
    return interaction.reply({ content: '🔍 Coming in Phase 4!', ephemeral: true });
  }

  if (commandName === 'blacklist') {
    const rid = options.getInteger('roblox_id');
    const reason = options.getString('reason');
    await pool.query('INSERT INTO blacklisted_users (guild_id, roblox_user_id, reason) VALUES ($1, $2, $3)', [guildId, rid, reason]);
    return interaction.reply({ content: `🚫 Blacklisted ${rid}` });
  }

  if (commandName === 'unblacklist') {
    const rid = options.getInteger('roblox_id');
    await pool.query('DELETE FROM blacklisted_users WHERE guild_id = $1 AND roblox_user_id = $2', [guildId, rid]);
    return interaction.reply({ content: `✅ Removed ${rid}` });
  }

  if (commandName === 'viewblacklist') {
    const res = await pool.query('SELECT roblox_user_id, reason FROM blacklisted_users WHERE guild_id = $1 LIMIT 10', [guildId]);
    if (res.rows.length === 0) return interaction.reply('📋 Empty!');
    const list = res.rows.map(r => `${r.roblox_user_id}: ${r.reason}`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🚫 Blacklist').setDescription(list)] });
  }

  if (commandName === 'kick') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'None';
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
      return interaction.reply({ content: `👢 Kicked ${target}` });
    } catch (e) { return interaction.reply({ content: '❌ Cannot kick!', ephemeral: true }); }
  }

  if (commandName === 'ban') {
    const target = options.getUser('user');
    const reason = options.getString('reason') || 'None';
    try {
      await interaction.guild.members.ban(target, { reason });
      return interaction.reply({ content: `🔨 Banned ${target}` });
    } catch (e) { return interaction.reply({ content: '❌ Cannot ban!', ephemeral: true }); }
  }

  if (commandName === 'warn') {
    const target = options.getUser('user');
    const reason = options.getString('reason');
    await pool.query('INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES ($1, $2, $3, $4)', [guildId, target.id, user.id, reason]);
    return interaction.reply({ content: `⚠️ Warned ${target}` });
  }
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const pending = pendingVerifications.get(state);
  if (!pending) return res.send('❌ Invalid request');
  try {
    const tokenRes = await axios.post('https://apis.roblox.com/oauth/v1/token', `client_id=${ROBLOX_CLIENT_ID}&client_secret=${ROBLOX_CLIENT_SECRET}&grant_type=authorization_code&code=${code}`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const userRes = await axios.get('https://apis.roblox.com/oauth/v1/userinfo', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const { sub: robloxId, preferred_username: robloxUsername } = userRes.data;
    await pool.query('INSERT INTO verified_users (user_id, guild_id, roblox_id, roblox_username) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO UPDATE SET roblox_id = $3, roblox_username = $4', [pending.userId, pending.guildId, robloxId, robloxUsername]);
    await pool.query('INSERT INTO user_points (guild_id, user_id, points) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [pending.guildId, pending.userId]);
    pendingVerifications.delete(state);
    res.send(`✅ Verified as ${robloxUsername}! Close this window.`);
  } catch (e) { console.error(e); res.send('❌ Error!'); }
});

app.get('/', (req, res) => res.send('🤖 RoNexus running!'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

setInterval(() => console.log('🔄 Alive'), 300000);

client.login(process.env.DISCORD_TOKEN);
