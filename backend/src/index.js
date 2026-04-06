require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const submissionRoutes = require('./routes/submissions');
const activityRoutes = require('./routes/activity');
const lpOutreachRoutes = require('./routes/lp-outreach');
const { processEmailQueue } = require('./services/email');
const db = require('./config/db');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'https://app.clay.com',
    'https://studio-vc-platform.vercel.app',
  ],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static file serving for uploads (authenticated)
app.use('/uploads', express.static(path.resolve(uploadDir)));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/lp', lpOutreachRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auto-seed if users table is empty
async function autoSeed() {
  try {
    const { rows } = await db.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      console.log('No users found — running auto-seed...');
      const passwordHash = await bcrypt.hash('demo123', 10);
      const users = [
        { email: 'kieran@studiovc.com', name: 'Kieran Corbett', role: 'admin' },
        { email: 'analyst@studiovc.com', name: 'Demo Analyst', role: 'analyst' },
      ];
      for (const u of users) {
        await db.query(
          `INSERT INTO users (id, email, password_hash, full_name, role)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
          [uuid(), u.email, passwordHash, u.name, u.role]
        );
      }
      console.log('Auto-seed complete. Login: kieran@studiovc.com / demo123');
    }
  } catch (err) {
    console.error('Auto-seed error:', err.message);
  }
}
autoSeed();

// Process email queue every 30 seconds
setInterval(processEmailQueue, 30000);

// Error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Studio VC API running on port ${PORT}`);
});

module.exports = app;
