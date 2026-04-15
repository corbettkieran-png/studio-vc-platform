require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migration = `
-- LP Research Intelligence Brief
-- Stores Claude-synthesised research cached per LP target

ALTER TABLE lp_targets
  ADD COLUMN IF NOT EXISTS research_data JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS researched_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_lp_targets_researched ON lp_targets(researched_at DESC NULLS LAST);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running research migration...');
    await client.query(migration);
    console.log('Research migration complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
