const { chromium }  = require('playwright');
const { MongoClient } = require('mongodb');
const http = require('http');

// ─── CONFIG ──────────────────────────────────────────────────
const TARGET_URL   = 'https://india.melbet.com/en/games/crash';
const MONGO_URI    = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME      = 'crash_db';
const AUTO_RESTART = true;
// ─────────────────────────────────────────────────────────────

let mongo, db, roundsCol, featuresCol;
let totalSaved = 0;

// ── HEALTH CHECK SERVER (Koyeb requires port 8080) ───────────
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ok', saved: totalSaved }));
}).listen(8080, () => console.log('🏥  Health check server on :8080'));

// ── HISTORY BUFFER ────────────────────────────────────────────
const HISTORY     = [];
const HISTORY_MAX = 50;

// ── CONNECT MONGO ─────────────────────────────────────────────
async function connectMongo() {
  mongo      = new MongoClient(MONGO_URI);
  await mongo.connect();
  db          = mongo.db(DB_NAME);
  roundsCol   = db.collection('rounds');
  featuresCol = db.collection('features');

  await roundsCol.createIndex({ round_id: 1 }, { unique: true });
  await roundsCol.createIndex({ crash_dt: 1 });
  await roundsCol.createIndex({ hour_utc: 1 });
  await featuresCol.createIndex({ round_id: 1 }, { unique: true });

  totalSaved = await roundsCol.countDocuments();
  console.log(`✅  MongoDB connected | ${DB_NAME} | ${totalSaved} rounds already stored`);

  const recent = await roundsCol
    .find({}, { projection: { crash_point:1, total_wagered:1, total_payout:1, winners_count:1, total_bets:1 }})
    .sort({ round_id: -1 })
    .limit(50)
    .toArray();

  recent.reverse().forEach(r => {
    HISTORY.push({
      crash: r.crash_point, totalWagered: r.total_wagered,
      totalPayout: r.total_payout, winnersCount: r.winners_count, totalBets: r.total_bets
    });
  });
  console.log(`📋  Seeded ${HISTORY.length} history entries from DB\n`);
}

// ── FEATURE ENGINEERING ───────────────────────────────────────
function mean(a)   { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : null; }
function stddev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length);
}

function buildFeatures(round) {
  const h   = HISTORY;
  const len = h.length;
  const prev = len > 0 ? h[len-1] : null;
  const last = n => h.slice(-n).map(r => r.crash);
  const l3=last(3), l5=last(5), l10=last(10), l20=last(20), l50=last(50);

  let sb2=0, sa2=0, sb15=0;
  for (let i=len-1; i>=0; i--) {
    const c = h[i].crash;
    if (c<2) { if(sa2>0) break; sb2++; if(c<1.5) sb15++; else sb15=0; }
    else     { if(sb2>0) break; sa2++; }
  }

  let rounds_since_big = 0;
  for (let i=len-1; i>=0; i--) {
    if (h[i].crash >= 5) break;
    rounds_since_big++;
  }

  const early_crash_density_20 = l20.length >= 10
    ? l20.filter(c => c < 1.5).length / l20.length : null;

  const dt  = new Date(round.crashTs || Date.now());
  const dow = dt.getUTCDay();
  const w   = round.totalWagered || 0;
  const b   = round.totalBets    || 0;

  return {
    round_id: round.roundId, crash_dt: dt,
    prev_1: len>=1?h[len-1].crash:null, prev_2: len>=2?h[len-2].crash:null,
    prev_3: len>=3?h[len-3].crash:null, prev_4: len>=4?h[len-4].crash:null,
    prev_5: len>=5?h[len-5].crash:null,
    avg_last_3:  l3.length>=3  ? mean(l3)        : null,
    avg_last_5:  l5.length>=5  ? mean(l5)        : null,
    avg_last_10: l10.length>=10? mean(l10)        : null,
    avg_last_20: l20.length>=15? mean(l20)        : null,
    avg_last_50: l50.length>=30? mean(l50)        : null,
    min_last_5:  l5.length>=5  ? Math.min(...l5)  : null,
    max_last_5:  l5.length>=5  ? Math.max(...l5)  : null,
    std_last_5:  l5.length>=5  ? stddev(l5)       : null,
    std_last_10: l10.length>=10? stddev(l10)      : null,
    streak_below2: sb2, streak_above2: sa2, streak_below15: sb15,
    count_above2_last5:  l5.length>=5  ? l5.filter(c=>c>=2).length  : null,
    count_above2_last10: l10.length>=10? l10.filter(c=>c>=2).length : null,
    count_above5_last10: l10.length>=10? l10.filter(c=>c>=5).length : null,
    count_above2_last20: l20.length>=15? l20.filter(c=>c>=2).length : null,
    rounds_since_big, early_crash_density_20,
    prev_wagered:       prev ? prev.totalWagered  : null,
    prev_payout:        prev ? prev.totalPayout   : null,
    prev_payout_ratio:  prev && prev.totalWagered>0 ? prev.totalPayout/prev.totalWagered : null,
    prev_winners:       prev ? prev.winnersCount  : null,
    prev_winners_ratio: prev && prev.totalBets>0  ? prev.winnersCount/prev.totalBets     : null,
    cur_total_bets: b, cur_total_wagered: w, cur_avg_bet_size: b>0 ? w/b : null,
    hour_utc: dt.getUTCHours(), minute_utc: dt.getUTCMinutes(),
    day_of_week: dow, is_weekend: (dow===0||dow===6) ? 1 : 0,
    crash_point: round.crash,
    above_2x: round.crash>=2?1:0, above_3x: round.crash>=3?1:0, above_5x: round.crash>=5?1:0,
  };
}

// ── SAVE TO MONGO ─────────────────────────────────────────────
async function saveRound(round) {
  if (!round || round.crash===null || round._flushed) return;
  round._flushed = true;

  const dt  = new Date(round.crashTs || Date.now());
  const dow = dt.getUTCDay();
  const w   = round.totalWagered || 0;
  const b   = round.totalBets    || 0;
  const p   = round.totalPayout  || 0;
  const win = round.winnersCount || 0;
  const dur = round.bettingOpenTs ? round.crashTs - round.bettingOpenTs : null;

  const roundDoc = {
    round_id: round.roundId, crash_point: round.crash,
    crash_ts: round.crashTs, crash_dt: dt,
    hour_utc: dt.getUTCHours(), minute_utc: dt.getUTCMinutes(), day_of_week: dow,
    betting_open_ts: round.bettingOpenTs || null, betting_duration_ms: dur,
    total_bets: b, total_players: round.totalPlayers || 0,
    total_wagered: w, avg_bet_size: b>0 ? w/b : 0,
    total_payout: p, winners_count: win,
    payout_ratio: w>0 ? p/w : 0, winners_ratio: b>0 ? win/b : 0,
    above_2x: round.crash>=2?1:0, above_3x: round.crash>=3?1:0, above_5x: round.crash>=5?1:0,
    collected_at: new Date(),
  };

  try {
    await Promise.all([
      roundsCol.updateOne({ round_id: round.roundId }, { $set: roundDoc }, { upsert: true }),
      featuresCol.updateOne({ round_id: round.roundId }, { $set: buildFeatures(round) }, { upsert: true }),
    ]);
    totalSaved++;
  } catch (e) {
    console.error(`❌ Mongo write error: ${e.message}`);
    return;
  }

  HISTORY.push({ crash:round.crash, totalWagered:w, totalPayout:p, winnersCount:win, totalBets:b });
  if (HISTORY.length > HISTORY_MAX) HISTORY.shift();
  roundBuffer.delete(round.roundId);

  const f = round.crash;
  const col = f>=10?'\x1b[36m':f>=5?'\x1b[32m':f>=2?'\x1b[33m':'\x1b[31m';
  console.log(
    `${f>=2?'\x1b[32m✅':'\x1b[31m❌'}\x1b[0m ${col}${f.toFixed(2)}x\x1b[0m` +
    `  round=${round.roundId}  bets=${b}  wagered=₹${Math.round(w)}  payout=₹${Math.round(p)}` +
    `  \x1b[90m[mongo:${totalSaved}]\x1b[0m`
  );
}

// ── ROUND BUFFER ──────────────────────────────────────────────
const roundBuffer = new Map();
let flyingRoundId = null;

function getRound(roundId) {
  if (!roundBuffer.has(roundId)) {
    roundBuffer.set(roundId, {
      roundId, crash:null, crashTs:null, bettingOpenTs:null,
      totalBets:0, totalPlayers:0, totalWagered:0,
      totalPayout:0, winnersCount:0, _flushed:false,
    });
  }
  return roundBuffer.get(roundId);
}

// ── WS HANDLER ────────────────────────────────────────────────
function handleFrame(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type!==1 || !msg.target) return;
  const args = msg.arguments?.[0];
  if (!args) return;
  const roundId = args.l;

  switch (msg.target) {
    case 'OnRegistration': {
      const hist = (args.fs||[]).slice().reverse();
      hist.forEach(h => {
        if (HISTORY.length < HISTORY_MAX)
          HISTORY.push({ crash:h.f, totalWagered:0, totalPayout:0, winnersCount:0, totalBets:0 });
      });
      console.log(`📋  Server history: ${hist.map(h=>h.f+'x').join('  ')}\n`);
      break;
    }
    case 'OnStage': {
      if (flyingRoundId && roundBuffer.has(flyingRoundId)) {
        const prev = roundBuffer.get(flyingRoundId);
        if (prev.crash !== null) saveRound(prev);
      }
      flyingRoundId = roundId;
      getRound(roundId).bettingOpenTs = args.ts;
      console.log(`\x1b[90m🆕  Round ${roundId}\x1b[0m`);
      break;
    }
    case 'OnBetting': {
      const r = getRound(roundId);
      if (!r.bettingOpenTs) r.bettingOpenTs = args.ts;
      break;
    }
    case 'OnBets': {
      const r = getRound(roundId);
      if ((args.bid||0) > r.totalWagered) r.totalWagered = args.bid;
      if ((args.n  ||0) > r.totalBets)    r.totalBets    = args.n;
      break;
    }
    case 'OnCrash': {
      const r = getRound(roundId);
      r.crash = args.f; r.crashTs = args.ts;
      flyingRoundId = roundId;
      const ref = r;
      setTimeout(() => { if (roundBuffer.has(roundId)) saveRound(ref); }, 30000);
      break;
    }
    case 'OnCashouts': {
      const r = roundBuffer.get(roundId);
      if (!r) return;
      if ((args.won||0) > r.totalPayout)  r.totalPayout  = args.won;
      if ((args.d  ||0) > r.winnersCount) r.winnersCount = args.d;
      if ((args.n  ||0) > r.totalPlayers) r.totalPlayers = args.n;
      break;
    }
  }
}

// ── STATS EVERY 30 MIN ────────────────────────────────────────
async function printStats() {
  const total = await roundsCol.countDocuments();
  const agg   = await roundsCol.aggregate([{$group:{
    _id:null, avg:{$avg:'$crash_point'}, a2:{$sum:'$above_2x'}, a5:{$sum:'$above_5x'}
  }}]).toArray();
  const s = agg[0] || {};
  console.log(`\n📊  Total: ${total} | avg=${s.avg?.toFixed(2)}x | above2x=${((s.a2||0)/total*100).toFixed(1)}% | above5x=${((s.a5||0)/total*100).toFixed(1)}%\n`);
}

setInterval(printStats, 30 * 60 * 1000);

// ── BROWSER LOOP — restarts automatically on crash ────────────
async function runBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  const context = await browser.newContext();
  const page    = await context.newPage();

  function attachWS(p) {
    p.on('websocket', ws => {
      if (!ws.url().includes('sockets/crash')) return;
      console.log(`🔌  Socket connected\n${'─'.repeat(55)}`);
      ws.on('framereceived', frame =>
        String(frame.payload).split('\x1e').filter(Boolean).forEach(handleFrame)
      );
      ws.on('close', async () => {
        console.log('\x1b[33m⚠️  Socket closed — reloading page in 10s\x1b[0m');
        if (AUTO_RESTART) {
          await new Promise(r => setTimeout(r, 10000));
          try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch {}
        }
      });
    });
  }

  attachWS(page);
  context.on('page', attachWS);

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('⏳  Running headless — collecting forever...\n');

  // Keep alive by polling — no waitForTimeout needed
  await new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        await page.evaluate(() => document.title); // lightweight liveness check
      } catch {
        clearInterval(interval);
        resolve(); // browser died — outer loop will restart it
      }
    }, 5000);
  });

  try { await browser.close(); } catch {}
}

// ── MAIN ──────────────────────────────────────────────────────
(async () => {
  await connectMongo();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   MELBET CRASH — CLOUD COLLECTOR (MongoDB)       ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`🌐  Target: ${TARGET_URL}`);
  console.log(`🍃  Mongo:  ${MONGO_URI.replace(/:[^:@]+@/, ':****@')}\n`);

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled error:', err.message);
  });

  // Restart browser loop forever
  while (true) {
    try {
      await runBrowser();
    } catch (e) {
      console.error('Browser crashed:', e.message);
    }
    console.log('🔄  Restarting browser in 15s...');
    await new Promise(r => setTimeout(r, 15000));
  }
})();