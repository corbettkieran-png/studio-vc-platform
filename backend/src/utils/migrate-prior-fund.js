require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const migration = `
-- Prior Fund LP Tracking
-- Records whether an LP previously invested in Fund I, Fund II, or both.

ALTER TABLE lp_targets
  ADD COLUMN IF NOT EXISTS prior_fund TEXT DEFAULT NULL;

-- Only enforce valid values if the constraint doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lp_targets_prior_fund_check'
  ) THEN
    ALTER TABLE lp_targets
      ADD CONSTRAINT lp_targets_prior_fund_check
      CHECK (prior_fund IN ('fund_i', 'fund_ii', 'both'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lp_targets_prior_fund
  ON lp_targets(prior_fund)
  WHERE prior_fund IS NOT NULL;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running prior fund migration...');
    await client.query(migration);
    console.log('Prior fund migration complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
