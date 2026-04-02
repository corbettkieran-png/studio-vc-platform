const db = require('../config/db');

// Load screening config from database
async function getConfig() {
  const { rows } = await db.query('SELECT key, value FROM screening_config');
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

// ARR string to numeric value
const ARR_MAP = {
  under_250k: 125000,
  '250k_500k': 375000,
  '500k_1m': 750000,
  '1m_5m': 3000000,
  '5m_plus': 7500000,
};

// Growth string to numeric percentage
const GROWTH_MAP = {
  negative: -50,
  '0_50': 25,
  '50_100': 75,
  '100_200': 150,
  '200_plus': 300,
  na: null,
};

function screenSubmission(submission, config) {
  const checks = [];

  // 1. Stage check
  const stages = config.stages || ['seed'];
  const stagePass = stages.includes(submission.stage);
  checks.push({ criterion: 'Stage', value: submission.stage, pass: stagePass });

  // 2. Sector check
  const sectors = config.sectors || ['fintech', 'b2b_saas', 'enterprise_ai'];
  const sectorPass = sectors.includes(submission.sector);
  checks.push({ criterion: 'Sector', value: submission.sector, pass: sectorPass });

  // 3. ARR check
  const arrNumeric = ARR_MAP[submission.arr] || 0;
  const minArr = parseInt(config.min_arr) || 250000;
  const arrPass = arrNumeric >= minArr;
  checks.push({ criterion: 'ARR', value: submission.arr, pass: arrPass });

  // 4. Growth check
  const growthVal = GROWTH_MAP[submission.yoy_growth];
  const minGrowth = parseInt(config.min_yoy_growth) || 100;
  const growthNaExempt = config.growth_na_exempt === true || config.growth_na_exempt === 'true';
  const growthPass = growthVal === null ? growthNaExempt : growthVal >= minGrowth;
  checks.push({
    criterion: 'YoY Growth',
    value: submission.yoy_growth,
    pass: growthPass,
    exempt: growthVal === null && growthNaExempt,
  });

  const matched = checks.every((c) => c.pass);
  const rejectionReasons = checks.filter((c) => !c.pass).map((c) => c.criterion);

  return {
    matched,
    checks,
    rejectionReasons,
    status: matched ? 'matched' : 'rejected',
  };
}

module.exports = { getConfig, screenSubmission };
