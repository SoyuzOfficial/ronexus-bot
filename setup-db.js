const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  console.log('🚀 Setting up database...');
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (license_key VARCHAR(64) PRIMARY KEY, tier VARCHAR(50) DEFAULT 'starter', max_guilds INTEGER DEFAULT 1, is_active BOOLEAN DEFAULT TRUE);
    CREATE TABLE IF NOT EXISTS guild_licenses (guild_id VARCHAR(20) PRIMARY KEY, license_key VARCHAR(64));
    CREATE TABLE IF NOT EXISTS verified_users (user_id VARCHAR(20), guild_id VARCHAR(20), roblox_id BIGINT, roblox_username VARCHAR(100), PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS user_points (guild_id VARCHAR(20), user_id VARCHAR(20), points INTEGER DEFAULT 0, PRIMARY KEY (guild_id, user_id));
    INSERT INTO licenses (license_key, tier, max_guilds, is_active) VALUES ('RNEX-FREE-2024', 'starter', 1, TRUE) ON CONFLICT DO NOTHING;
  `);
  
  console.log('✅ Done! License: RNEX-FREE-2024');
  await pool.end();
}

setup().catch(console.error);
