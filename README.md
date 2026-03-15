# Crash Collector — Melbet Crash Data Pipeline

Headless Playwright collector that runs 24/7, capturing every round from Melbet Crash and storing it to MongoDB Atlas.

## Files

| File | Purpose |
|------|---------|
| `cloud_collector.js` | Main collector — runs headless, stores to MongoDB |
| `Dockerfile` | Docker build for Koyeb/Railway/Render deployment |
| `package.json` | Node.js dependencies |

## Local setup

```bash
npm install
npx playwright install chromium --with-deps
MONGO_URI="your_uri_here" node cloud_collector.js
```

## Deploy to Koyeb

1. Push this repo to GitHub
2. Koyeb → New App → GitHub → select this repo
3. Add environment variable: `MONGO_URI=mongodb+srv://...`
4. Deploy

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGO_URI` | Yes | MongoDB Atlas connection string |

## Data collected per round

- `crash_point` — the multiplier at crash
- `crash_dt` — timestamp
- `total_bets`, `total_wagered`, `total_payout`, `winners_count`
- `prev_1..5` — last 5 crash points (lag features)
- `avg_last_3/5/10/20/50` — rolling averages
- `streak_below2`, `streak_above2` — consecutive streaks
- `above_2x`, `above_3x`, `above_5x` — ML labels