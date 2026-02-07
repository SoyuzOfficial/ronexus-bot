const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const axios = require('axios');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Discord bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]
});

// Express server for OAuth2
const app = express();
const PORT = process.env.PORT || 3000;

// OAuth2 Config
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URL || `http://localhost:${PORT}/auth/callback`;

// Store pending verifications
const pendingVerifications = new Map();

// Bot ready
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  
  // Register slash commands
const commands = [
  { name: 'activate', description: 'Activate bot with license', options: [{ name: 'license', description: 'License key', type: 3, required: true }] },
  { name: 'verify', description: 'Verify Roblox account' },
  { name: 'setup', description: 'Setup wizard' },
  { name: 'points', description: 'Check points', options: [{ name: 'user', description: 'User to check', type: 6, required: false }] },
  { name: 'addpoints', description: 'Add points', options: [{ name: 'user', type: 6, required: true }, { name: 'amount', type: 4, required: true }, { name: 'reason', type: 3, required: false }] },
  { name: 'removepoints', description: 'Remove points', options: [{ name: 'user', type: 6, required: true }, { name: 'amount', type: 4, required: true }] },
  { name: 'leaderboard', description: 'Points leaderboard' },
  { name: 'backgroundcheck', description: 'Check user background', options: [{ name: 'user', type: 6, required: true }] },
  { name: 'blacklist-user', description: 'Blacklist Roblox user', options: [{ name: 'roblox_id', type: 4, required: true }, { name: 'reason', type: 3, required: true }] },
  { name: 'blacklist-group', description: 'Blacklist Roblox group', options: [{ name: 'group_id', type: 4, required: true }, { name: 'reason', type: 3, required: true }] },
  { name: 'unblacklist', description: 'Remove from blacklist', options: [{ name: 'roblox_id', type: 4, required: true }] },
  { name: 'viewblacklist', description: 'View blacklist' },
  { name: 'kick', description: 'Kick user', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: false }] },
  { name: 'ban', description: 'Ban user', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: false }] },
  { name: 'warn', description: 'Warn user', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: true }] }
];

  try {
    await client.application.commands.set(commands);
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
});

// Command handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName, guildId, user } = interaction;

  // /activate command
  if (commandName === 'activate') {
    const licenseKey = interaction.options.getString('license');
    
    try {
      // Check if license exists and is valid
      const licenseCheck = await pool.query(
        'SELECT * FROM licenses WHERE license_key = $1 AND is_active = true',
        [licenseKey]
      );

      if (licenseCheck.rows.length === 0) {
        return interaction.reply({ content: '❌ Invalid or inactive license key!', ephemeral: true });
      }

      // Check if server is already activated
      const guildCheck = await pool.query(
        'SELECT * FROM guild_licenses WHERE guild_id = $1',
        [guildId]
      );

      if (guildCheck.rows.length > 0) {
        return interaction.reply({ content: '✅ This server is already activated!', ephemeral: true });
      }

      // Activate server
      await pool.query(
        'INSERT INTO guild_licenses (guild_id, license_key, activated_by) VALUES ($1, $2, $3)',
        [guildId, licenseKey, user.id]
      );

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Bot Activated!')
        .setDescription(`Server activated with license: \`${licenseKey}\``)
        .addFields({ name: 'Next Steps', value: 'Use `/setup` to configure the bot!' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });

    } catch (error) {
      console.error(error);
      return interaction.reply({ content: '❌ Error activating license!', ephemeral: true });
    }
  }

  // /verify command
  if (commandName === 'verify') {
    try {
      // Check if server is activated
      const guildCheck = await pool.query(
        'SELECT * FROM guild_licenses WHERE guild_id = $1',
        [guildId]
      );

      if (guildCheck.rows.length === 0) {
        return interaction.reply({ content: '❌ Bot not activated! Use `/activate` first.', ephemeral: true });
      }

      // Generate OAuth2 URL
      const state = `${guildId}_${user.id}_${Date.now()}`;
      pendingVerifications.set(state, { guildId, userId: user.id });

      const authUrl = `https://apis.roblox.com/oauth/v1/authorize?` +
        `client_id=${ROBLOX_CLIENT_ID}&` +
        `redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&` +
        `scope=openid profile&` +
        `response_type=code&` +
        `state=${state}`;

      const button = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setLabel('🔗 Verify with Roblox')
            .setStyle(ButtonStyle.Link)
            .setURL(authUrl)
        );

      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🔐 Roblox Verification')
        .setDescription('Click the button below to verify your Roblox account!')
        .addFields({ name: '⚠️ Note', value: 'This will open Roblox OAuth - login and authorize the bot.' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], components: [button], ephemeral: true });

    } catch (error) {
      console.error(error);
      return interaction.reply({ content: '❌ Error starting verification!', ephemeral: true });
    }
  }

  // /setup command
  if (commandName === 'setup') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ content: '❌ You need Administrator permission!', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('⚙️ RoNexus Setup Wizard')
      .setDescription('Welcome to RoNexus! Let\'s get your server configured.')
      .addFields(
        { name: '1️⃣ Activate Bot', value: 'Use `/activate YOUR_LICENSE_KEY`' },
        { name: '2️⃣ Verify Yourself', value: 'Use `/verify` to link your Roblox account' },
        { name: '3️⃣ Configure Roles', value: 'Coming soon: Auto-role assignment' },
        { name: '4️⃣ Setup Groups', value: 'Coming soon: Group rank syncing' }
      )
      .setFooter({ text: 'More features coming in Phase 4 & 5!' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // /points command
  if (commandName === 'points') {
    try {
      const result = await pool.query(
        'SELECT points FROM user_points WHERE guild_id = $1 AND user_id = $2',
        [guildId, user.id]
      );

      const points = result.rows.length > 0 ? result.rows[0].points : 0;

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('💰 Your Points')
        .setDescription(`You have **${points}** points!`)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });

    } catch (error) {
      console.error(error);
      return interaction.reply({ content: '❌ Error fetching points!', ephemeral: true });
    }
  }
});

// OAuth2 callback endpoint
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.send('❌ Error: Missing code or state');
  }

  const pending = pendingVerifications.get(state);
  if (!pending) {
    return res.send('❌ Error: Invalid or expired verification request');
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await axios.post('https://apis.roblox.com/oauth/v1/token', {
      client_id: ROBLOX_CLIENT_ID,
      client_secret: ROBLOX_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token } = tokenResponse.data;

    // Get user info
    const userResponse = await axios.get('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    const { sub: robloxId, preferred_username: robloxUsername } = userResponse.data;

    // Save to database
    await pool.query(
      `INSERT INTO verified_users (user_id, guild_id, roblox_id, roblox_username) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (guild_id, user_id) DO UPDATE SET roblox_id = $3, roblox_username = $4`,
      [pending.userId, pending.guildId, robloxId, robloxUsername]
    );

    // Initialize points
    await pool.query(
      `INSERT INTO user_points (guild_id, user_id, points) 
       VALUES ($1, $2, 0) 
       ON CONFLICT (guild_id, user_id) DO NOTHING`,
      [pending.guildId, pending.userId]
    );

    pendingVerifications.delete(state);

    res.send(`✅ Success! You've been verified as **${robloxUsername}**! You can close this window.`);

  } catch (error) {
    console.error('OAuth error:', error);
    res.send('❌ Error during verification. Please try again.');
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('🤖 RoNexus Bot is running!');
});

// Start Express server
app.listen(PORT, () => {
  console.log(`🌐 OAuth server running on port ${PORT}`);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
