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

// Send AI deal memo to team when analysis completes and recommendation isn't a hard pass
async function notifyDealMemo(submission, analysis) {
  if (!analysis || analysis.recommendation === 'pass') return;

  const { rows: users } = await db.query(
    `SELECT email, full_name FROM users WHERE is_active = true`
  );
  if (!users.length) return;

  const rec = analysis.recommendation;
  const recLabel = rec === 'strong_interest' ? '⚡ Strong Interest' : '🔍 Explore';
  const recColor = rec === 'strong_interest' ? '#16A34A' : '#D97706';
  const confLabel = (analysis.confidence || 'medium').charAt(0).toUpperCase() + (analysis.confidence || 'medium').slice(1);

  const strengthsHtml = (analysis.strengths || [])
    .map((s) => `<li style="margin-bottom:6px;">${s}</li>`).join('');
  const risksHtml = (analysis.risks || [])
    .map((r) => `<li style="margin-bottom:6px;">${r}</li>`).join('');
  const diligenceHtml = (analysis.diligence_questions || [])
    .map((q, i) => `<li style="margin-bottom:6px;"><strong>Q${i + 1}:</strong> ${q}</li>`).join('');
  const competitorsHtml = (analysis.competitors || []).join(', ') || 'N/A';

  const traction = analysis.traction || {};
  const tractionRows = [
    ['ARR', traction.arr], ['MRR', traction.mrr],
    ['YoY Growth', traction.growth], ['Customers', traction.customers],
  ].filter(([, v]) => v && v !== 'Not disclosed')
   .map(([k, v]) => `<tr><td style="padding:5px 10px;font-weight:600;color:#555;width:140px;">${k}</td><td style="padding:5px 10px;">${v}</td></tr>`)
   .join('');

  const subject = `[Studio VC Deal Memo] ${submission.company_name} — ${recLabel} (${confLabel} Confidence)`;

  const body = `
<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;">

  <!-- Header -->
  <div style="background:#1D3557;padding:28px 32px;border-radius:8px 8px 0 0;">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#A8DADC;margin-bottom:6px;">Studio VC · AI Deal Memo</div>
    <div style="font-size:26px;font-weight:700;color:#fff;">${submission.company_name}</div>
    <div style="font-size:14px;color:#A8DADC;margin-top:4px;">${submission.one_liner || ''}</div>
  </div>

  <!-- Recommendation banner -->
  <div style="background:${recColor};padding:14px 32px;display:flex;align-items:center;justify-content:space-between;">
    <span style="font-size:16px;font-weight:700;color:#fff;">${recLabel}</span>
    <span style="font-size:12px;color:rgba(255,255,255,0.85);">Confidence: ${confLabel} · ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
  </div>

  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:28px 32px;border-radius:0 0 8px 8px;">

    <!-- Summary -->
    <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Summary</h3>
    <p style="margin:0 0 24px;line-height:1.7;color:#444;">${analysis.summary || ''}</p>

    <!-- Problem / Solution -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="width:50%;vertical-align:top;padding-right:16px;">
          <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Problem</h3>
          <p style="margin:0;line-height:1.7;color:#444;font-size:14px;">${analysis.problem || 'N/A'}</p>
        </td>
        <td style="width:50%;vertical-align:top;padding-left:16px;border-left:1px solid #e5e7eb;">
          <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Solution</h3>
          <p style="margin:0;line-height:1.7;color:#444;font-size:14px;">${analysis.solution || 'N/A'}</p>
        </td>
      </tr>
    </table>

    <!-- Traction metrics -->
    ${tractionRows ? `
    <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Traction</h3>
    <table style="border-collapse:collapse;background:#f8fafc;border-radius:6px;overflow:hidden;margin-bottom:24px;width:100%;">
      ${tractionRows}
      ${traction.other ? `<tr><td style="padding:5px 10px;font-weight:600;color:#555;">Other</td><td style="padding:5px 10px;">${traction.other}</td></tr>` : ''}
    </table>` : ''}

    <!-- Market + Business Model -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="width:50%;vertical-align:top;padding-right:16px;">
          <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Market</h3>
          <p style="margin:0;line-height:1.7;color:#444;font-size:14px;">${analysis.market || 'Not disclosed'}</p>
        </td>
        <td style="width:50%;vertical-align:top;padding-left:16px;border-left:1px solid #e5e7eb;">
          <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Business Model</h3>
          <p style="margin:0;line-height:1.7;color:#444;font-size:14px;">${analysis.business_model || 'N/A'}</p>
        </td>
      </tr>
    </table>

    <!-- Team -->
    <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Team</h3>
    <p style="margin:0 0 24px;line-height:1.7;color:#444;">${analysis.team || 'N/A'}</p>

    <!-- Differentiation + Competitors -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="width:60%;vertical-align:top;padding-right:16px;">
          <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Differentiation</h3>
          <p style="margin:0;line-height:1.7;color:#444;font-size:14px;">${analysis.differentiation || 'N/A'}</p>
        </td>
        <td style="width:40%;vertical-align:top;padding-left:16px;border-left:1px solid #e5e7eb;">
          <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Competitors</h3>
          <p style="margin:0;line-height:1.7;color:#444;font-size:14px;">${competitorsHtml}</p>
        </td>
      </tr>
    </table>

    <!-- Strengths + Risks -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="width:50%;vertical-align:top;padding-right:16px;">
          <h3 style="color:#16A34A;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Strengths</h3>
          <ul style="margin:0;padding-left:18px;color:#444;font-size:14px;">${strengthsHtml}</ul>
        </td>
        <td style="width:50%;vertical-align:top;padding-left:16px;border-left:1px solid #e5e7eb;">
          <h3 style="color:#DC2626;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Risks</h3>
          <ul style="margin:0;padding-left:18px;color:#444;font-size:14px;">${risksHtml}</ul>
        </td>
      </tr>
    </table>

    <!-- Ask -->
    <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">The Ask</h3>
    <p style="margin:0 0 24px;line-height:1.7;color:#444;">${analysis.ask || submission.fundraising_amount || 'Not disclosed'}</p>

    <!-- Recommendation rationale -->
    <div style="background:#f0f4f8;border-left:4px solid ${recColor};padding:16px 20px;border-radius:0 6px 6px 0;margin-bottom:24px;">
      <div style="font-size:12px;font-weight:700;color:${recColor};letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Recommendation Rationale</div>
      <p style="margin:0;line-height:1.7;color:#333;font-size:14px;">${analysis.recommendation_rationale || ''}</p>
    </div>

    <!-- Diligence questions -->
    <h3 style="color:#1D3557;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 8px;">Diligence Questions</h3>
    <ol style="margin:0 0 28px;padding-left:18px;color:#444;font-size:14px;">${diligenceHtml}</ol>

    <!-- CTA -->
    <div style="text-align:center;padding-top:8px;border-top:1px solid #e5e7eb;">
      <a href="${process.env.FRONTEND_URL || 'https://studio-vc-platform.vercel.app'}/crm"
         style="display:inline-block;background:#1D3557;color:#fff;text-decoration:none;padding:12px 28px;border-radius:50px;font-weight:700;font-size:13px;letter-spacing:1px;text-transform:uppercase;">
        View in CRM →
      </a>
      <p style="margin:12px 0 0;font-size:11px;color:#999;">
        Generated by Studio VC AI · ${analysis._meta?.model || 'claude-sonnet-4-6'} ·
        ${analysis._meta?.had_deck_text ? 'Deck text extracted' : 'Form data only'}
      </p>
    </div>

  </div>
</div>`;

  for (const user of users) {
    await queueEmail(user.email, subject, body);
  }
}

module.exports = {
  queueEmail,
  processEmailQueue,
  notifyNewSubmission,
  notifyStatusChange,
  notifyDealMemo,
};
