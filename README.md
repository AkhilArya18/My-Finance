# Lifetime Finance Tracker — India

A complete self-hosted web application for personal income, expense, investment, liability and annual-plan tracking.

## Included

- Secure account registration and login
- Transaction sheet with add, edit, delete, search and filters
- Indian expense and investment categories: SIPs, EPF/VPF, PPF, NPS, FDs, RDs, SGB, gold, equity, REIT/InvIT, insurance, EMIs, UPI and more
- Annual summary with income, spending, investments, liabilities, savings rate, investment rate and net cash flow
- Monthly and category charts
- Category-level annual budgets and targets
- CSV export and complete JSON backup/restore
- SQLite persistent storage, server-side sessions, CSRF protection, password hashing, security headers, rate limiting and audit logging
- Docker deployment files

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set a strong `SESSION_SECRET`.
3. Install and run:

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Run with Docker

Create a `.env` file:

```env
SESSION_SECRET=generate-a-long-random-secret-of-at-least-32-characters
```

Then:

```bash
docker compose up -d --build
```

The app is available at `http://localhost:3000`.

## Recommended lifetime deployment

- Host it on a private VPS, home server, NAS or cloud VM that you control.
- Put Caddy, Nginx or a managed HTTPS proxy in front of the app.
- Restrict administrative SSH access and enable automatic security updates.
- Use encrypted disks and encrypted off-site backups.
- Download the app's JSON backup monthly in addition to server-level database backups.
- Keep at least three copies: server, encrypted local storage and encrypted off-site storage.
- Never commit `.env`, `data/` or backups to Git.

## Database backup

The application database is stored at `data/finance.db` by default. Stop writes or use SQLite's backup tooling before copying the live database. The in-app JSON export is the most portable backup.

## Important financial note

The dashboard gives simulated personal-finance analysis based only on information entered by the user. It is not investment, tax or legal advice. Tax calculations and live market valuations are intentionally not automated in this version.

## Gemini Finance AI

1. Revoke any API key that has been pasted into chat, email, tickets, or Git history.
2. Create a fresh Gemini API key.
3. Set it only as a server environment variable:

```bash
export GEMINI_API_KEY="your-new-key"
npm start
```

Never add the real key to `.env.example`, source code, frontend JavaScript, screenshots, or Git.

The AI can read the selected year's aggregate/recent transaction context, answer dashboard questions, and add a transaction when the user's message clearly describes one. It does not receive database credentials and cannot directly execute arbitrary database operations.

## Vercel limitation

This version uses a local JSON database and in-memory sessions. Vercel serverless filesystems and process memory are not durable, so do not use this storage layer for a lifetime production deployment on Vercel. Before Vercel deployment, migrate users, sessions, transactions, plans, and audit records to a managed PostgreSQL database such as Neon/Supabase through Vercel Marketplace. Store `GEMINI_API_KEY` and `SESSION_SECRET` in Vercel Project Settings → Environment Variables.
