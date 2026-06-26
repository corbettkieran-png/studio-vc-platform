require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const migration = `
-- LP Commitment Pipeline Tracker
-- Adds commitment_amount (integer dollars) to lp_targets and extends
-- outreach_status to include the soft_circled stage.

ALTER TABLE lp_targets
  ADD COLUMN IF NOT EXISTS commitment_amount NUMERIC(12,0) DEFAULT NULL;

-- Drop old CHECK constraint (cannot ALTER it in-place; must recreate).
ALTER TABLE lp_targets
  DROP CONSTRAINT IF EXISTS lp_targets_outreach_status_check;

-- Recreate with soft_circled inserted between in_discussions and committed.
ALTER TABLE lp_targets
  ADD CONSTRAINT lp_targets_outreach_status_check
  CHECK (outreach_status IN (
    'not_started','identified','intro_requested','intro_made',
    'meeting_scheduled','in_discussions','soft_circled','committed','passed','not_now'
  ));

-- Index for fast pipeline aggregation queries
CREATE INDEX IF NOT EXISTS idx_lp_targets_pipeline
  ON lp_targets(outreach_status, commitment_amount)
  WHERE commitment_amount IS NOT NULL;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running commitment pipeline migration...');
    await client.query(migration);
    console.log('Commitment pipeline migration complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
