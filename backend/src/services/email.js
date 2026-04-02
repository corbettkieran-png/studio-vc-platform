const nodemailer = require('nodemailer');
const db = require('../config/db');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

// Queue an email for sending
async function queueEmail(to, subject, body) {
  await db.query(
    'INSERT INTO email_queue (to_email, subject, body) VALUES ($1, $2, $3)',
    [to, subject, body]
  );
}

// Process pending emails
async function processEmailQueue() {
  const t = getTransporter();
  if (!t) return;

  const { rows } = await db.query(
    `SELECT * FROM email_queue WHERE status = 'pending' AND attempts < 3 ORDER BY created_at LIMIT 10`
  );

  for (const email of rows) {
    try {
      await t.sendMail({
        from: process.env.EMAIL_FROM || 'deals@studiovc.com',
        to: email.to_email,
        subject: email.subject,
        html: email.body,
      });
      await db.query(
        `UPDATE email_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [email.id]
      );
    } catch (err) {
      console.error(`Email send failed for ${email.id}:`, err.message);
      await db.query(
        `UPDATE email_queue SET attempts = attempts + 1, status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'pending' END WHERE id = $1`,
        [email.id]
      );
    }
  }
}

// Notify team of new submission
async function notifyNewSubmission(submission, screenResult) {
  const { rows: users } = await db.query(
    `SELECT email, full_name FROM users WHERE is_active = true`
  );

  const statusLabel = screenResult.matched ? 'MATCHED — Pipeline' : 'Did Not Match';
  const subject = `[Studio VC] New Submission: ${submission.company_name} (${statusLabel})`;

  const checksHtml = screenResult.checks
    .map((c) => `<li>${c.criterion}: ${c.pass ? '✓' : '✗'} (${c.value})</li>`)
    .join('');

  const body = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <h2 style="color: #003B76;">New Deal Submission</h2>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 6px 12px; font-weight: bold;">Company</td><td style="padding: 6px 12px;">${submission.company_name}</td></tr>
        <tr><td style="padding: 6px 12px; font-weight: bold;">Founder</td><td style="padding: 6px 12px;">${submission.founder_name}</td></tr>
        <tr><td style="padding: 6px 12px; font-weight: bold;">Sector</td><td style="padding: 6px 12px;">${submission.sector}</td></tr>
        <tr><td style="padding: 6px 12px; font-weight: bold;">Stage</td><td style="padding: 6px 12px;">${submission.stage}</td></tr>
        <tr><td style="padding: 6px 12px; font-weight: bold;">ARR</td><td style="padding: 6px 12px;">${submission.arr || 'N/A'}</td></tr>
        <tr><td style="padding: 6px 12px; font-weight: bold;">Status</td><td style="padding: 6px 12px; color: ${screenResult.matched ? '#16A34A' : '#DC2626'};">${statusLabel}</td></tr>
      </table>
      <h3 style="color: #003B76; margin-top: 20px;">Screening Results</h3>
      <ul>${checksHtml}</ul>
      <p style="margin-top: 20px;"><a href="${process.env.FRONTEND_URL}/crm" style="color: #003B76;">View in CRM →</a></p>
    </div>
  `;

  for (const user of users) {
    await queueEmail(user.email, subject, body);
  }
}

// Notify team of status change
async function notifyStatusChange(submission, oldStatus, newStatus, changedBy) {
  const { rows: users } = await db.query(
    `SELECT email FROM users WHERE is_active = true AND id != $1`, [changedBy]
  );

  const subject = `[Studio VC] ${submission.company_name}: ${oldStatus} → ${newStatus}`;
  const body = `
    <div style="font-family: Arial, sans-serif;">
      <p><strong>${submission.company_name}</strong> status changed from <em>${oldStatus}</em> to <em>${newStatus}</em>.</p>
      <p><a href="${process.env.FRONTEND_URL}/crm" style="color: #003B76;">View in CRM →</a></p>
    </div>
  `;

  for (const user of users) {
    await queueEmail(user.email, subject, body);
  }
}

module.exports = {
  queueEmail,
  processEmailQueue,
  notifyNewSubmission,
  notifyStatusChange,
};
