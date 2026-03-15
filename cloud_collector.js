/**
 * ============================================================
 *  MELBET CRASH — CLOUD COLLECTOR v7 (Proxy Mode)
 *
 *  Connects to Vercel Mumbai proxy instead of Melbet directly.
 *  Vercel (Indian IP) forwards to india.melbet.com.
 *
 *  ENV VARS (set in Koyeb dashboard):
 *    MONGO_URI      = mongodb+srv://...
 *    PROXY_URL      = wss://your-app.vercel.app
 *    PROXY_SECRET   = crash_secret_123
 * ============================================================
 */

const WebSocket       = require('ws');
const { MongoClient } = require('mongodb');
const http            = require('http');

// ─── CONFIG ──────────────────────────────────────────────────
// Vercel proxy URL — set this after deploying the proxy
const PROXY_URL    = process.env.PROXY_URL    || 'wss://your-proxy.vercel.app';
const PROXY_SECRET = process.env.PROXY_SECRET || 'crash_secret_123';
const MONGO_URI    = process.env.MONGO_URI    || 'mongodb://localhost:27017/crash_db';
const DB_NAME      = 'crash_db';

// Full proxy WS URL with secret
const WS_URL = `${PROXY_URL}?secret=${PROXY_SECRET}`;
// ─────────────────────────────────────────────────────────────

let totalSaved  = 0;
let totalErrors = 0;
let wsConnected = false;
let lastRoundTs = Date.now();
let mongo, db, roundsCol, featuresCol;

// ── HEALTH CHECK on port 8080 ─────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:             wsConnected ? 'collecting' : 'connecting',
    rounds_saved:       totalSaved,
    errors:             totalErrors,
    ws_connected:       wsConnected,
    last_round_ago_sec: Math.round((Date.now() - lastRoundTs) / 1000),
    uptime_min:         Math.round(process.uptime() / 60),
    proxy_url:          PROXY_URL,
  }, null, 2));
}).listen(8080, () => log('SYS', 'Health check on port 8080'));

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag.padEnd(5)}] ${msg}`);
}

// ── HISTORY BUFFER ────────────────────────────────────────────
const HISTORY     = [];
const HISTORY_MAX = 50;

// ── MONGO ─────────────────────────────────────────────────────
async function connectMongo() {
  log('DB', `Connecting... ${MONGO_URI.replace(/:[^:@]+@/, ':****@')}`);
  mongo       = new MongoClient(MONGO_URI);
  await mongo.connect();
  db           = mongo.db(DB_NAME);
  roundsCol    = db.collection('rounds');
  featuresCol  = db.collection('features');
  await roundsCol.createIndex({ round_id: 1 }, { unique: true });
  await featuresCol.createIndex({ round_id: 1 }, { unique: true });
  totalSaved = await roundsCol.countDocuments();
  log('DB', `✅ Connected | existing=${totalSaved} rounds`);

  const recent = await roundsCol
    .find({}, { projection:{ crash_point:1,total_wagered:1,total_payout:1,winners_count:1,total_bets:1 }})
    .sort({ round_id:-1 }).limit(50).toArray();
  recent.reverse().forEach(r => HISTORY.push({
    crash:r.crash_point, totalWagered:r.total_wagered||0,
    totalPayout:r.total_payout||0, winnersCount:r.winners_count||0, totalBets:r.total_bets||0
  }));
  log('DB', `Seeded ${HISTORY.length} history entries`);
}

// ── FEATURES ──────────────────────────────────────────────────
function mean(a)   { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : null; }
function stddev(a) {
  if (a.length<2) return null;
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length);
}
function buildFeatures(round) {
  const h=HISTORY, len=h.length, prev=len>0?h[len-1]:null;
  const last=n=>h.slice(-n).map(r=>r.crash);
  const l3=last(3),l5=last(5),l10=last(10),l20=last(20),l50=last(50);
  let sb2=0,sa2=0,sb15=0;
  for(let i=len-1;i>=0;i--){
    const c=h[i].crash;
    if(c<2){if(sa2>0)break;sb2++;if(c<1.5)sb15++;else sb15=0;}
    else{if(sb2>0)break;sa2++;}
  }
  let rsbig=0;
  for(let i=len-1;i>=0;i--){if(h[i].crash>=5)break;rsbig++;}
  const dt=new Date(round.crashTs||Date.now());
  const dow=dt.getUTCDay();
  const w=round.totalWagered||0, b=round.totalBets||0;
  return {
    round_id:round.roundId, crash_dt:dt,
    prev_1:len>=1?h[len-1].crash:null, prev_2:len>=2?h[len-2].crash:null,
    prev_3:len>=3?h[len-3].crash:null, prev_4:len>=4?h[len-4].crash:null,
    prev_5:len>=5?h[len-5].crash:null,
    avg_last_3:l3.length>=3?mean(l3):null, avg_last_5:l5.length>=5?mean(l5):null,
    avg_last_10:l10.length>=10?mean(l10):null, avg_last_20:l20.length>=15?mean(l20):null,
    avg_last_50:l50.length>=30?mean(l50):null,
    min_last_5:l5.length>=5?Math.min(...l5):null, max_last_5:l5.length>=5?Math.max(...l5):null,
    std_last_5:l5.length>=5?stddev(l5):null, std_last_10:l10.length>=10?stddev(l10):null,
    streak_below2:sb2, streak_above2:sa2, streak_below15:sb15,
    count_above2_last5:l5.length>=5?l5.filter(c=>c>=2).length:null,
    count_above2_last10:l10.length>=10?l10.filter(c=>c>=2).length:null,
    count_above5_last10:l10.length>=10?l10.filter(c=>c>=5).length:null,
    count_above2_last20:l20.length>=15?l20.filter(c=>c>=2).length:null,
    rounds_since_big:rsbig,
    early_crash_density_20:l20.length>=10?l20.filter(c=>c<1.5).length/l20.length:null,
    prev_wagered:prev?prev.totalWagered:null, prev_payout:prev?prev.totalPayout:null,
    prev_payout_ratio:prev&&prev.totalWagered>0?prev.totalPayout/prev.totalWagered:null,
    prev_winners:prev?prev.winnersCount:null,
    prev_winners_ratio:prev&&prev.totalBets>0?prev.winnersCount/prev.totalBets:null,
    cur_total_bets:b, cur_total_wagered:w, cur_avg_bet_size:b>0?w/b:null,
    hour_utc:dt.getUTCHours(), minute_utc:dt.getUTCMinutes(),
    day_of_week:dow, is_weekend:(dow===0||dow===6)?1:0,
    crash_point:round.crash,
    above_2x:round.crash>=2?1:0, above_3x:round.crash>=3?1:0, above_5x:round.crash>=5?1:0,
  };
}

// ── SAVE ──────────────────────────────────────────────────────
async function saveRound(round) {
  if (!round||round.crash===null||round._flushed) return;
  round._flushed=true;
  const dt=new Date(round.crashTs||Date.now());
  const dow=dt.getUTCDay();
  const w=round.totalWagered||0, b=round.totalBets||0;
  const p=round.totalPayout||0,  win=round.winnersCount||0;
  const dur=round.bettingOpenTs?round.crashTs-round.bettingOpenTs:null;
  try {
    await Promise.all([
      roundsCol.updateOne({round_id:round.roundId},{$set:{
        round_id:round.roundId, crash_point:round.crash,
        crash_ts:round.crashTs, crash_dt:dt,
        hour_utc:dt.getUTCHours(), minute_utc:dt.getUTCMinutes(), day_of_week:dow,
        betting_open_ts:round.bettingOpenTs||null, betting_duration_ms:dur,
        total_bets:b, total_players:round.totalPlayers||0,
        total_wagered:w, avg_bet_size:b>0?w/b:0,
        total_payout:p, winners_count:win,
        payout_ratio:w>0?p/w:0, winners_ratio:b>0?win/b:0,
        above_2x:round.crash>=2?1:0, above_3x:round.crash>=3?1:0, above_5x:round.crash>=5?1:0,
        collected_at:new Date(),
      }},{upsert:true}),
      featuresCol.updateOne({round_id:round.roundId},{$set:buildFeatures(round)},{upsert:true}),
    ]);
    totalSaved++;
    lastRoundTs=Date.now();
    const f=round.crash;
    const tag=f>=5?'HIGH ':f>=2?'MED  ':'LOW  ';
    log('SAVE',`[${tag}] ${f.toFixed(2)}x | round=${round.roundId} | bets=${b} | wagered=₹${Math.round(w)} | total=${totalSaved}`);
  } catch(e) {
    totalErrors++;
    log('ERR', `Save failed: ${e.message}`);
  }
  HISTORY.push({crash:round.crash,totalWagered:w,totalPayout:p,winnersCount:win,totalBets:b});
  if(HISTORY.length>HISTORY_MAX) HISTORY.shift();
  roundBuffer.delete(round.roundId);
}

// ── ROUND BUFFER ──────────────────────────────────────────────
const roundBuffer=new Map();
let flyingRoundId=null;
function getRound(roundId) {
  if(!roundBuffer.has(roundId)) roundBuffer.set(roundId,{
    roundId,crash:null,crashTs:null,bettingOpenTs:null,
    totalBets:0,totalPlayers:0,totalWagered:0,totalPayout:0,winnersCount:0,_flushed:false
  });
  return roundBuffer.get(roundId);
}

// ── FRAME HANDLER ─────────────────────────────────────────────
function handleFrame(raw) {
  let msg;
  try { msg=JSON.parse(raw); } catch { return; }
  if(msg.type!==1||!msg.target) return;
  const args=msg.arguments?.[0];
  if(!args) return;
  const roundId=args.l;

  log('WS', `[${msg.target}] round=${roundId}`);

  switch(msg.target) {
    case 'OnRegistration': {
      const hist=(args.fs||[]).slice().reverse();
      hist.forEach(h=>{
        if(HISTORY.length<HISTORY_MAX)
          HISTORY.push({crash:h.f,totalWagered:0,totalPayout:0,winnersCount:0,totalBets:0});
      });
      log('REG', `History: ${hist.map(h=>h.f+'x').join(' ')} | last_crash=${args.p}x`);
      break;
    }
    case 'OnStage': {
      log('RND', `━━ NEW ROUND ${roundId} | next=${args.ln} ━━`);
      if(flyingRoundId&&roundBuffer.has(flyingRoundId)){
        const prev=roundBuffer.get(flyingRoundId);
        if(prev.crash!==null) saveRound(prev);
      }
      flyingRoundId=roundId;
      getRound(roundId).bettingOpenTs=args.ts;
      break;
    }
    case 'OnBetting': {
      log('BET', `Betting open | round=${roundId} | window=${args.a}ms`);
      const r=getRound(roundId);
      if(!r.bettingOpenTs) r.bettingOpenTs=args.ts;
      break;
    }
    case 'OnBets': {
      const r=getRound(roundId);
      if((args.bid||0)>r.totalWagered) r.totalWagered=args.bid;
      if((args.n  ||0)>r.totalBets)    r.totalBets=args.n;
      log('BET', `Update | bets=${r.totalBets} | wagered=₹${Math.round(r.totalWagered)}`);
      break;
    }
    case 'OnStart': {
      log('FLY', `✈️  Flying | round=${roundId}`);
      break;
    }
    case 'OnCrash': {
      const r=getRound(roundId);
      r.crash=args.f; r.crashTs=args.ts;
      flyingRoundId=roundId;
      log('CRSH',`💥 ${args.f.toFixed(2)}x | round=${roundId}`);
      const ref=r;
      setTimeout(()=>{ if(roundBuffer.has(roundId)) saveRound(ref); },30000);
      break;
    }
    case 'OnCashouts': {
      const r=roundBuffer.get(roundId); if(!r) return;
      if((args.won||0)>r.totalPayout)  r.totalPayout=args.won;
      if((args.d  ||0)>r.winnersCount) r.winnersCount=args.d;
      if((args.n  ||0)>r.totalPlayers) r.totalPlayers=args.n;
      log('CASH',`won=₹${Math.round(args.won||0)} winners=${args.d||0}`);
      break;
    }
  }
}

// ── WS CONNECTION (direct WebSocket, no Playwright needed) ────
function connectWS() {
  log('WS', `Connecting to proxy: ${PROXY_URL}?secret=****`);

  const ws = new WebSocket(WS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CrashCollector/1.0)',
    }
  });

  ws.on('open', () => {
    wsConnected = true;
    log('WS', `✅ Proxy connected`);

    // Send SignalR handshake
    ws.send(JSON.stringify({ protocol:'json', version:1 }) + '\x1e');

    // Send guest registration after 500ms
    setTimeout(() => {
      ws.send(JSON.stringify({
        arguments: [{ activity:30, currency:99 }],
        invocationId: '0',
        target: 'Guest',
        type: 1
      }) + '\x1e');
      log('WS', `Sent Guest registration`);
    }, 500);
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    raw.split('\x1e').filter(Boolean).forEach(handleFrame);
  });

  ws.on('close', (code) => {
    wsConnected = false;
    log('WS', `❌ Disconnected (${code}) — reconnecting in 10s...`);
    setTimeout(connectWS, 10000);
  });

  ws.on('error', (err) => {
    wsConnected = false;
    log('ERR', `WS error: ${err.message}`);
  });

  // Ping every 30s to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
}

// ── STATS ─────────────────────────────────────────────────────
async function printStats() {
  try {
    const total=await roundsCol.countDocuments();
    const agg=await roundsCol.aggregate([{$group:{_id:null,avg:{$avg:'$crash_point'},a2:{$sum:'$above_2x'},a5:{$sum:'$above_5x'}}}]).toArray();
    const s=agg[0]||{};
    log('STAT',`total=${total} | avg=${s.avg?.toFixed(2)}x | above2x=${((s.a2||0)/Math.max(total,1)*100).toFixed(1)}% | above5x=${((s.a5||0)/Math.max(total,1)*100).toFixed(1)}%`);
  } catch(e) { log('ERR',`Stats: ${e.message}`); }
}
setInterval(printStats, 30*60*1000);

// ── MAIN ──────────────────────────────────────────────────────
(async () => {
  process.on('unhandledRejection', err => log('ERR', `Unhandled: ${err?.message}`));
  process.on('uncaughtException',  err => log('ERR', `Uncaught: ${err?.message}`));

  await connectMongo();

  log('SYS', '══════════════════════════════════════════');
  log('SYS', '  MELBET CRASH COLLECTOR v7 (Proxy Mode)');
  log('SYS', '══════════════════════════════════════════');
  log('SYS', `Proxy: ${PROXY_URL}`);
  log('SYS', `Mongo: ${MONGO_URI.replace(/:[^:@]+@/,':****@')}`);
  log('SYS', '══════════════════════════════════════════');

  // No Playwright needed — direct WebSocket connection to proxy
  connectWS();

  // Heartbeat
  await new Promise(() => {
    setInterval(() => {
      log('HB', `alive | saved=${totalSaved} | ws=${wsConnected} | uptime=${Math.round(process.uptime()/60)}min`);
    }, 5*60*1000);
  });
})();