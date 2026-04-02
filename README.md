# Studio VC — Deal Flow Platform

Production-grade deal flow management platform for seed-stage venture capital.

## Architecture

```
frontend/          React + Vite (deployed to Vercel)
backend/           Express.js API + PostgreSQL (deployed to Railway)
```

## Features

- **Public submission form** — Founders submit decks + 2-min video pitches
- **Automated screening** — Thesis matching against sector, stage, ARR, growth
- **CRM dashboard** — Pipeline (matched/reviewing/contacted/passed) + Didn't Match tabs
- **Team collaboration** — Internal notes with attribution, activity log
- **Progress tracking** — Monthly check-ins on rejected companies
- **Analytics** — Pipeline funnel, sector breakdown, match rates, submission trends
- **Email notifications** — Auto-notify team on new submissions and status changes
- **Auth** — JWT-based login with role-based access (admin/partner/analyst)

## Quick Start (Local Development)

### Prerequisites
- Node.js 18+
- PostgreSQL 14+

### 1. Database Setup
```bash
createdb studio_vc
```

### 2. Backend
```bash
cd backend
cp .env.example .env
# Edit .env with your DATABASE_URL and JWT_SECRET
npm install
npm run db:migrate
npm run db:seed      # Seeds demo data (optional)
npm run dev
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Demo login: `kieran@studiovc.com` / `demo123`

## Deployment

### Backend → Railway
1. Create a new Railway project
2. Add a PostgreSQL service
3. Add a new service from your Git repo (point to `/backend`)
4. Set environment variables from `.env.example`
5. Railway auto-detects the Dockerfile and deploys
6. Run migrations: `npm run db:migrate && npm run db:seed`

### Frontend → Vercel
1. Import your Git repo in Vercel
2. Set root directory to `frontend`
3. Add env variable: `VITE_API_URL=https://your-railway-url.up.railway.app/api`
4. Update `vercel.json` rewrite URLs to your Railway domain
5. Deploy

### Custom Domain
- In Vercel: Settings → Domains → add `deals.studiovc.com`
- In Railway: Settings → Networking → add custom domain for API

## Screening Configuration

Default thesis criteria (editable in `screening_config` table):
- **Sectors:** Fintech, B2B SaaS, Enterprise AI
- **Stage:** Seed only
- **ARR:** $250K+ minimum
- **YoY Growth:** 100%+ (N/A exempt for pre-revenue)

## Team Roles

| Role | Permissions |
|------|------------|
| Admin | Full access + invite team members |
| Partner | View/edit all submissions, notes, status changes |
| Analyst | View/edit all submissions, notes, status changes |
