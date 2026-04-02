require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEMO_USERS = [
  { email: 'kieran@studiovc.com', name: 'Kieran Corbett', role: 'admin' },
  { email: 'analyst@studiovc.com', name: 'Demo Analyst', role: 'analyst' },
];

const DEMO_SUBMISSIONS = [
  // Pipeline companies (matched/reviewing/contacted)
  {
    founder_name: 'Marcus Chen', founder_email: 'marcus@payvault.io',
    company_name: 'PayVault', one_liner: 'Embedded payment orchestration for vertical SaaS platforms',
    sector: 'fintech', stage: 'seed', arr: '500k_1m', yoy_growth: '200_plus',
    status: 'matched', days_ago: 3,
  },
  {
    founder_name: 'Priya Sharma', founder_email: 'priya@arcana-ai.com',
    company_name: 'Arcana AI', one_liner: 'AI-powered contract analysis for enterprise legal teams',
    sector: 'enterprise_ai', stage: 'seed', arr: '1m_5m', yoy_growth: '100_200',
    status: 'reviewing', days_ago: 7,
  },
  {
    founder_name: 'Jake Williams', founder_email: 'jake@ledgerloop.com',
    company_name: 'LedgerLoop', one_liner: 'Real-time treasury management for mid-market companies',
    sector: 'fintech', stage: 'seed', arr: '250k_500k', yoy_growth: '200_plus',
    status: 'reviewing', days_ago: 12,
  },
  {
    founder_name: 'Amara Osei', founder_email: 'amara@complianceiq.io',
    company_name: 'ComplianceIQ', one_liner: 'Automated regulatory compliance monitoring for fintechs',
    sector: 'fintech', stage: 'seed', arr: '500k_1m', yoy_growth: '100_200',
    status: 'contacted', days_ago: 18,
  },
  {
    founder_name: 'Rachel Torres', founder_email: 'rachel@signalhq.com',
    company_name: 'SignalHQ', one_liner: 'Intent-based lead scoring for B2B sales teams',
    sector: 'b2b_saas', stage: 'seed', arr: '1m_5m', yoy_growth: '200_plus',
    status: 'contacted', days_ago: 22,
  },
  {
    founder_name: 'David Park', founder_email: 'david@closedloop.ai',
    company_name: 'ClosedLoop', one_liner: 'Predictive analytics for healthcare revenue cycle management',
    sector: 'enterprise_ai', stage: 'seed', arr: '500k_1m', yoy_growth: '100_200',
    status: 'matched', days_ago: 1,
  },

  // Rejected companies
  {
    founder_name: 'Emma Liu', founder_email: 'emma@fitpulse.com',
    company_name: 'FitPulse', one_liner: 'AI fitness coaching app for consumers',
    sector: 'consumer', stage: 'seed', arr: 'under_250k', yoy_growth: '50_100',
    status: 'rejected', days_ago: 45,
  },
  {
    founder_name: 'Tom Nguyen', founder_email: 'tom@educraft.io',
    company_name: 'EduCraft', one_liner: 'Gamified coding education platform for K-12',
    sector: 'edtech', stage: 'pre_seed', arr: 'under_250k', yoy_growth: 'na',
    status: 'rejected', days_ago: 38,
  },
  {
    founder_name: 'Sara Ahmed', founder_email: 'sara@carbonstack.io',
    company_name: 'CarbonStack', one_liner: 'Carbon credit marketplace for SMBs',
    sector: 'climate', stage: 'seed', arr: '250k_500k', yoy_growth: '50_100',
    status: 'rejected', days_ago: 30,
  },
  {
    founder_name: 'Michael Brown', founder_email: 'michael@healthbridge.ai',
    company_name: 'HealthBridge AI', one_liner: 'Clinical decision support for rural hospitals',
    sector: 'healthtech', stage: 'series_a', arr: '5m_plus', yoy_growth: '100_200',
    status: 'rejected', days_ago: 55,
  },
  {
    founder_name: 'Lisa Wang', founder_email: 'lisa@shopflow.co',
    company_name: 'ShopFlow', one_liner: 'Social commerce toolkit for Instagram sellers',
    sector: 'consumer', stage: 'seed', arr: 'under_250k', yoy_growth: '200_plus',
    status: 'rejected', days_ago: 25,
  },
];

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Seeding demo data...');
    await client.query('BEGIN');

    // Create users
    const passwordHash = await bcrypt.hash('demo123', 10);
    const userIds = [];
    for (const u of DEMO_USERS) {
      const id = uuid();
      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, role)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET full_name=$4 RETURNING id`,
        [id, u.email, passwordHash, u.name, u.role]
      );
      userIds.push(id);
    }
    const adminId = userIds[0];

    // Create submissions
    for (const s of DEMO_SUBMISSIONS) {
      const subId = uuid();
      const submittedAt = new Date(Date.now() - s.days_ago * 86400000).toISOString();
      await client.query(
        `INSERT INTO submissions
         (id, founder_name, founder_email, company_name, one_liner, sector, stage, arr, yoy_growth, status, submitted_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [subId, s.founder_name, s.founder_email, s.company_name, s.one_liner,
         s.sector, s.stage, s.arr, s.yoy_growth, s.status, submittedAt]
      );

      // Add activity log entry
      await client.query(
        `INSERT INTO activity_log (submission_id, action, details, created_at)
         VALUES ($1, 'submitted', $2, $3)`,
        [subId, JSON.stringify({ company: s.company_name }), submittedAt]
      );

      // Add a note for some companies
      if (['reviewing', 'contacted'].includes(s.status)) {
        await client.query(
          `INSERT INTO notes (submission_id, user_id, content, created_at)
           VALUES ($1, $2, $3, $4)`,
          [subId, adminId, `Initial review — ${s.one_liner}. Worth a deeper look.`, submittedAt]
        );
      }

      // Add progress checks for some rejected companies
      if (s.company_name === 'FitPulse') {
        await client.query(
          `INSERT INTO progress_checks (submission_id, checked_by, summary, sources, checked_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [subId, adminId, 'Raised $1.2M from angel investors. Pivoting to B2B corporate wellness.',
           JSON.stringify([
             { label: 'LinkedIn', url: 'https://linkedin.com/company/fitpulse' },
             { label: 'Crunchbase', url: 'https://crunchbase.com/organization/fitpulse' }
           ]),
           new Date(Date.now() - 15 * 86400000).toISOString()]
        );
      }
      if (s.company_name === 'HealthBridge AI') {
        await client.query(
          `INSERT INTO progress_checks (submission_id, checked_by, summary, sources, checked_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [subId, adminId, 'Secured partnership with HCA Healthcare. Revenue growing faster than expected.',
           JSON.stringify([
             { label: 'Google News', url: 'https://google.com/search?q=HealthBridge+AI' },
             { label: 'LinkedIn', url: 'https://linkedin.com/company/healthbridge-ai' }
           ]),
           new Date(Date.now() - 10 * 86400000).toISOString()]
        );
      }
    }

    await client.query('COMMIT');
    console.log('Seed complete. Demo login: kieran@studiovc.com / demo123');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
