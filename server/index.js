// uOHM ($uOHM) — OHM-style (3,3) staking + bonding + treasury protocol.
// The unicorn reserve — launching via pools.trade (Uniswap's launchpad) on Robinhood Chain.
// Fixed supply => no mint authority => rebases cannot emit on-chain. The index, the
// suOHM wrapper and the treasury are therefore an off-chain ledger: a simulation.
// Nothing here custodies funds. Payouts, if ever made, are scripted airdrops.
// Dependency-free: Node http + crypto.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const BOOT_TS = Date.now();
const PORT = process.env.PORT || 8178;
const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.TOKEN_TICKER || 'uOHM';
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, 'data.json');
const UOHM_MINT = process.env.UOHM_MINT || '0x91F41b74b7906266d4D28a327EBD0ed86c119261';  // $uOHM on Robinhood Chain
// staking custody: real $uOHM deposits land here (key held offline by the operator — never on this server)
const TREASURY_WALLET = process.env.TREASURY_WALLET || '0x6A690F711928E8b938Fb5FE38F6fc2B8164Abc97';
const ADMIN_KEY = process.env.ADMIN_KEY || '';  // set to enable /api/withdrawals admin export
const MIN_STAKE = +(process.env.MIN_STAKE || 300000);  // minimum $uOHM per stake deposit
const LOCK_SEC = +(process.env.LOCK_SEC || 3600);      // stake lock: must stay staked at least this long before unstaking
// Robinhood Chain mainnet — balances are read here directly so the app shows the truth
// no matter which chain the user's wallet is parked on.
const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = +(process.env.CHAIN_ID || 4663);
async function rpc(method, params) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
const REBASE_SEC = +(process.env.REBASE_SEC || 300);           // epoch length (demo: 5 min)
// Dynamic APY (OHM-style reflexive emissions): rich when the pool is small, decaying as it fills.
// apy = APY_MIN + (APY_MAX - APY_MIN) * HALF / (HALF + totalStaked)
// => empty pool ≈ APY_MAX; at HALF staked it's the midpoint; large pool → APY_MIN.
const APY_MAX = +(process.env.APY_MAX || 50000);   // ceiling, near-empty pool
const APY_MIN = +(process.env.APY_MIN || 6000);    // floor, deep pool
const APY_HALF = +(process.env.APY_HALF || 4e6);   // staked $uOHM at the halfway point
const APY_TARGET = APY_MAX;                          // legacy alias (banner copy / startup log)
// 24-HOUR APY BOOST: while active, APY is floored at BOOST_APY (old-school ponzi numbers).
// Arm it by setting BOOST_UNTIL to a unix-ms timestamp (or BOOST_HOURS from boot); off by default.
const BOOST_APY = +(process.env.BOOST_APY || 250000);
const BOOST_UNTIL_ENV = +(process.env.BOOST_UNTIL || 0);
const BOOST_HOURS = +(process.env.BOOST_HOURS || 0);
const TOTAL_SUPPLY = +(process.env.TOTAL_SUPPLY || 1e9);       // fixed supply at launch
let TOKEN_PRICE = +(process.env.TOKEN_PRICE || 0.005);         // $ per uOHM — overridden by the live pool price below
// live price: once UOHM_MINT is set, mark to the real Robinhood-chain pool (deepest pair wins)
async function pollPrice() {
  if (!UOHM_MINT) return;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + UOHM_MINT, { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const pairs = ((await r.json()).pairs || []).filter((p) => p.chainId === 'robinhood' && +p.priceUsd > 0);
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    if (pairs[0]) TOKEN_PRICE = +pairs[0].priceUsd;
  } catch (e) { /* keep last good */ }
}
pollPrice(); setInterval(pollPrice, 60000);
// The treasury wallet holds every staked $uOHM, so its on-chain balance IS the total staked pool.
// We read it directly — the off-chain ledger's own tally can reset on redeploy, this cannot.
let treasuryStaked = 0;
async function pollTreasury() {
  try {
    const hex = await rpc('eth_call', [{ to: UOHM_MINT, data: '0x70a08231' + TREASURY_WALLET.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
    treasuryStaked = Number(BigInt(hex)) / 1e18;
  } catch (e) { /* keep last good */ }
}
pollTreasury(); setInterval(pollTreasury, 30000);
const SEED_BALANCE = +(process.env.SEED_BALANCE || 1e6);       // demo: new wallet starts with this uOHM to try staking (raised from 1k — no more perceived stake cap)
// per-rebase rate derived from target APY
const REBASES_YR = 31557600 / REBASE_SEC;
// current APY from the live pool, and the per-rebase rate derived from it
// staked value from the COMMITTED index (no live fraction) — avoids a liveIndex→rate cycle
// pool = real staked $uOHM in the treasury (falls back to the ledger tally before the first poll)
function poolStaked() { return treasuryStaked > 0 ? treasuryStaked : db.totalAgons * db.index; }
// boost window: env-armed, or persisted in the ledger once armed via admin
function boostUntil() { return Math.max(BOOST_UNTIL_ENV, db.boostUntil || 0, BOOST_HOURS > 0 ? BOOT_TS + BOOST_HOURS * 3600e3 : 0); }
function boostActive() { return Date.now() < boostUntil(); }
const FIXED_APY = +(process.env.FIXED_APY || 250000);  // pin the displayed/emission APY; set 0 to use dynamic
function currentApy(ts) {
  if (FIXED_APY > 0) return FIXED_APY;
  const s = ts == null ? poolStaked() : ts;
  const base = APY_MIN + (APY_MAX - APY_MIN) * (APY_HALF / (APY_HALF + Math.max(0, s)));
  return boostActive() ? Math.max(base, BOOST_APY) : base;
}
function currentRate(ts) { return Math.pow(1 + currentApy(ts) / 100, 1 / REBASES_YR) - 1; }
const BONDS = [
  { id: 'eth', name: 'ETH', discount: 0.065, vestDays: 5 },
  { id: 'lp', name: 'uOHM-ETH LP', discount: 0.13, vestDays: 5 },
  { id: 'usdc', name: 'USDC', discount: 0.04, vestDays: 5 },
];

// ---------- state ----------
let db = { index: 1, epoch: 0, lastRebase: Date.now(), treasury: +(process.env.TREASURY_SEED || 84000), totalAgons: 0, wallets: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))); } catch (e) {}
if (!db.wallets) db.wallets = {};
if (!db.tape) db.tape = [];
if (!db.withdrawals) db.withdrawals = [];  // pending unstake payouts, settled manually from the treasury
// migration: wallets seeded under the old 1k cap get topped up to the new seed
for (const w of Object.values(db.wallets)) if (w.seeded && w.balance <= 1000) w.balance += SEED_BALANCE - 1000;
// the Stampede: rolling tape of protocol actions, newest first
function tapePush(type, wallet, amount) {
  db.tape.unshift({ t: Date.now(), type, w: wallet.slice(0, 4) + '…' + wallet.slice(-4), amount: +(+amount).toFixed(2) });
  if (db.tape.length > 60) db.tape.length = 60;
}
let saveT = null; function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; try { fs.writeFileSync(DATA_PATH, JSON.stringify(db)); } catch (e) {} }, 800); }
const isWallet = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);

function rebase() { db.index *= (1 + currentRate()); db.epoch++; db.lastRebase = Date.now(); save(); }
// catch up missed epochs on boot
(function catchup() { const missed = Math.floor((Date.now() - db.lastRebase) / 1000 / REBASE_SEC); for (let i = 0; i < Math.min(missed, 10000); i++) rebase(); })();

function liveIndex() { const frac = (Date.now() - db.lastRebase) / 1000 / REBASE_SEC; return db.index * (1 + currentRate() * Math.max(0, Math.min(1, frac))); }
function W(addr) { return db.wallets[addr] || (db.wallets[addr] = { balance: SEED_BALANCE, agons: 0, bonds: [], seeded: true }); }
function stakedOf(w, idx) { return w.agons * (idx || liveIndex()); }
function totalStaked(idx) { return db.totalAgons * (idx || liveIndex()); }
const circulating = () => TOTAL_SUPPLY;

function metrics() {
  const idx = liveIndex();
  // total staked = the treasury's real on-chain $uOHM balance (authoritative pool)
  const ts = poolStaked();
  const leaderboard = Object.entries(db.wallets).map(([a, w]) => ({ a, staked: w.agons * idx }))
    .filter((x) => x.staked > 0.001).sort((x, y) => y.staked - x.staked).slice(0, 8)
    .map((x) => ({ wallet: x.a.slice(0, 4) + '…' + x.a.slice(-4), staked: x.staked, share: ts > 0 ? x.staked / ts : 0 }));
  const backing = db.treasury / circulating();
  // runway: days the treasury can fund current reward emissions (rewards per day in $ vs treasury)
  const rate = currentRate(ts); const rewardsPerDay = ts * (Math.pow(1 + rate, 86400 / REBASE_SEC) - 1) * TOKEN_PRICE;
  // nothing staked => nothing emitting => runway is undefined, not zero. null so the UI can say so.
  const runway = rewardsPerDay > 0 ? db.treasury / rewardsPerDay : null;
  return {
    token: TOKEN, apy: currentApy(ts), rate: rate, index: +idx.toFixed(6), epoch: db.epoch,
    totalStaked: ts, circulating: circulating(), stakingRatio: ts / circulating(),
    treasury: db.treasury, backingPerToken: backing, price: TOKEN_PRICE, marketCap: TOKEN_PRICE * circulating(),
    runwayDays: runway, rebaseSec: REBASE_SEC, nextRebaseIn: Math.max(0, REBASE_SEC - (Date.now() - db.lastRebase) / 1000),
    bonds: BONDS.map((b) => ({ id: b.id, name: b.name, discount: b.discount, vestDays: b.vestDays, price: TOKEN_PRICE * (1 - b.discount) })),
    leaderboard, stakers: leaderboard.length, mint: UOHM_MINT, tape: db.tape.slice(0, 12),
    boost: boostActive() ? { apy: BOOST_APY, until: boostUntil(), secondsLeft: Math.ceil((boostUntil() - Date.now()) / 1000) } : null,
  };
}
function account(addr) {
  const w = W(addr); const idx = liveIndex();
  const now = Date.now();
  const bonds = w.bonds.filter((b) => !b.done).map((b) => {
    const pct = Math.max(0, Math.min(1, (now - b.start) / (b.end - b.start)));
    const claimable = b.payout * pct - b.claimed;
    return { market: b.market, payout: b.payout, claimable: Math.max(0, claimable), pct, endsIn: Math.max(0, (b.end - now) / 1000) };
  });
  const pendingOut = db.withdrawals.filter((x) => x.wallet === addr && x.status === 'pending').reduce((s, x) => s + x.amount, 0);
  return { wallet: addr, balance: w.balance, staked: stakedOf(w, idx), index: +idx.toFixed(6),
    nextReward: stakedOf(w, idx) * currentRate(), bonds, seeded: !!w.seeded, pendingOut,
    lockRemaining: Math.max(0, Math.ceil(((w.lockUntil || 0) - Date.now()) / 1000)) };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serve(req, res) { let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/client/landing.html'; if (u === '/app' || u === '/app/') u = '/client/index.html'; if (u === '/docs' || u === '/docs/') u = '/client/docs.html'; const f = path.normalize(path.join(ROOT, u)); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); } fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); }); }
function json(res, c, o) { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }

http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/config') return json(res, 200, { token: TOKEN, rebaseSec: REBASE_SEC, apy: APY_TARGET, mint: UOHM_MINT, treasury: TREASURY_WALLET, minStake: MIN_STAKE, lockSec: LOCK_SEC, chainId: CHAIN_ID, rpcUrl: RPC_URL, network: 'robinhood-chain' });
  if (u === '/api/metrics') return json(res, 200, metrics());
  if (req.method === 'POST' && u === '/api/balance') { const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'bad wallet' }); try { const hex = await rpc('eth_call', [{ to: UOHM_MINT, data: '0x70a08231' + d.wallet.slice(2).toLowerCase().padStart(64, '0') }, 'latest']); return json(res, 200, { balance: Number(BigInt(hex)) / 1e18 }); } catch (e) { return json(res, 200, { error: 'rpc unavailable' }); } }
  if (req.method === 'POST' && u === '/api/account') { const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a valid EVM wallet' }); return json(res, 200, account(d.wallet)); }
  // stake = a real on-chain $uOHM transfer to the treasury. The server VERIFIES the tx on
  // Robinhood Chain — it must exist, have succeeded, be a transfer() of $uOHM from this wallet
  // to the treasury — and credits suOHM for the ACTUAL on-chain amount, not the client's claim.
  if (req.method === 'POST' && u === '/api/stake') {
    const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'bad wallet' });
    if (!/^0x[0-9a-fA-F]{64}$/.test(d.txHash || '')) return json(res, 200, { error: 'missing deposit tx — stake sends $uOHM to the treasury first' });
    const txHash = d.txHash.toLowerCase();
    if (db.tape.some((e) => e.tx === txHash)) return json(res, 200, { error: 'deposit already credited' });
    let amt;
    try {
      const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [txHash]), rpc('eth_getTransactionReceipt', [txHash])]);
      if (!tx || !rc) return json(res, 200, { error: 'deposit not found on Robinhood Chain — nothing was credited' });
      if (rc.status !== '0x1') return json(res, 200, { error: 'deposit transaction failed on-chain' });
      if ((tx.to || '').toLowerCase() !== UOHM_MINT.toLowerCase()) return json(res, 200, { error: 'not a $uOHM transfer' });
      if ((tx.from || '').toLowerCase() !== d.wallet.toLowerCase()) return json(res, 200, { error: 'deposit was not sent from your wallet' });
      // decode transfer(address to, uint256 value): 0xa9059cbb + to(32) + value(32)
      const inp = (tx.input || '').toLowerCase();
      if (!inp.startsWith('0xa9059cbb') || inp.length < 138) return json(res, 200, { error: 'not a token transfer' });
      const to = '0x' + inp.slice(34, 74);
      if (to !== TREASURY_WALLET.toLowerCase()) return json(res, 200, { error: 'deposit did not go to the treasury' });
      amt = Number(BigInt('0x' + inp.slice(74, 138))) / 1e18;
    } catch (e) { return json(res, 200, { error: 'could not verify deposit — try again in a moment' }); }
    if (!(amt > 0)) return json(res, 200, { error: 'zero-value deposit' });
    if (amt < MIN_STAKE) return json(res, 200, { error: 'below minimum — deposit was ' + amt.toLocaleString() + ', minimum is ' + MIN_STAKE.toLocaleString() + ' $uOHM' });
    const w = W(d.wallet); const idx = liveIndex(); const ag = amt / idx; w.agons += ag; db.totalAgons += ag;
    w.lockUntil = Date.now() + LOCK_SEC * 1000;  // fresh deposit (re)locks the position for the minimum
    tapePush('stake', d.wallet, amt); db.tape[0].tx = txHash; db.tape[0].ag = ag; db.tape[0].addr = d.wallet; save();
    return json(res, 200, { ok: true, ...account(d.wallet) });
  }
  // operator: re-verify every credited stake against the chain and reverse any that don't check out.
  if (u === '/api/admin/reverify') {
    const q = new URL(req.url, 'http://x').searchParams; if (!ADMIN_KEY || q.get('key') !== ADMIN_KEY) return json(res, 403, { error: 'nope' });
    const reversed = [];
    for (const e of db.tape) {
      if (e.type !== 'stake' || !e.tx || e.bad) continue;
      let ok = false;
      try {
        const tx = await rpc('eth_getTransactionByHash', [e.tx]); const rc = await rpc('eth_getTransactionReceipt', [e.tx]);
        const inp = tx && (tx.input || '').toLowerCase();
        ok = !!(tx && rc && rc.status === '0x1' && (tx.to || '').toLowerCase() === UOHM_MINT.toLowerCase()
          && inp && inp.startsWith('0xa9059cbb') && ('0x' + inp.slice(34, 74)) === TREASURY_WALLET.toLowerCase());
      } catch (x) { continue; /* leave untouched if RPC is flaky */ }
      if (!ok) {
        const addr = e.addr; const ag = e.ag != null ? e.ag : (e.amount / liveIndex());
        if (addr && db.wallets[addr]) { db.wallets[addr].agons = Math.max(0, db.wallets[addr].agons - ag); }
        db.totalAgons = Math.max(0, db.totalAgons - ag);
        e.bad = true; reversed.push({ wallet: e.w, amount: e.amount, tx: e.tx });
      }
    }
    save(); return json(res, 200, { reversed, count: reversed.length });
  }
  // unstake = join the withdrawal queue; payouts are sent manually from the treasury wallet.
  if (req.method === 'POST' && u === '/api/unstake') { const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'bad wallet' }); const w = W(d.wallet); const lockLeft = Math.ceil(((w.lockUntil || 0) - Date.now()) / 1000); if (lockLeft > 0) return json(res, 200, { error: 'staked positions are locked for ' + Math.round(LOCK_SEC / 60) + ' min — ' + Math.ceil(lockLeft / 60) + ' min left' }); const idx = liveIndex(); const have = stakedOf(w, idx); const amt = Math.max(0, Math.min(+d.amount || 0, have)); if (amt <= 0) return json(res, 200, { error: 'nothing staked' }); const ag = amt / idx; w.agons = Math.max(0, w.agons - ag); db.totalAgons = Math.max(0, db.totalAgons - ag); db.withdrawals.push({ wallet: d.wallet, amount: +amt.toFixed(4), t: Date.now(), status: 'pending' }); tapePush('unstake', d.wallet, amt); save(); return json(res, 200, { ok: true, queued: +amt.toFixed(4), ...account(d.wallet) }); }
  // operator: arm/clear the 24-hour APY boost (requires ADMIN_KEY). ?hours=24 arms it, ?off=1 clears.
  if (u === '/api/admin/boost') {
    const q = new URL(req.url, 'http://x').searchParams; if (!ADMIN_KEY || q.get('key') !== ADMIN_KEY) return json(res, 403, { error: 'nope' });
    if (q.get('off')) { db.boostUntil = 0; save(); return json(res, 200, { ok: true, boost: null }); }
    const hours = Math.max(0, +q.get('hours') || 24);
    db.boostUntil = Date.now() + hours * 3600e3; save();
    return json(res, 200, { ok: true, boostApy: BOOST_APY, until: db.boostUntil, hours });
  }
  // operator export: who is owed what (requires ADMIN_KEY env)
  if (u === '/api/withdrawals') { const q = new URL(req.url, 'http://x').searchParams; if (!ADMIN_KEY || q.get('key') !== ADMIN_KEY) return json(res, 403, { error: 'nope' }); return json(res, 200, { treasury: TREASURY_WALLET, pending: db.withdrawals.filter((x) => x.status === 'pending'), all: db.withdrawals }); }
  if (req.method === 'POST' && u === '/api/bond') {
    const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'bad wallet' });
    const m = BONDS.find((b) => b.id === d.market); if (!m) return json(res, 200, { error: 'bad market' });
    const usd = Math.max(0, +d.amount || 0); if (usd <= 0) return json(res, 200, { error: 'enter an amount' });
    const payout = usd / (TOKEN_PRICE * (1 - m.discount)); // discounted uOHM
    const w = W(d.wallet); const now = Date.now();
    w.bonds.push({ market: m.name, payout, start: now, end: now + m.vestDays * 86400000, claimed: 0, done: false }); tapePush('bond', d.wallet, payout);
    db.treasury += usd; save();
    return json(res, 200, { ok: true, payout, ...account(d.wallet) });
  }
  if (req.method === 'POST' && u === '/api/claim') {
    const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'bad wallet' });
    const w = W(d.wallet); const now = Date.now(); let claimed = 0; const autostake = !!d.autostake;
    for (const b of w.bonds) { if (b.done) continue; const pct = Math.max(0, Math.min(1, (now - b.start) / (b.end - b.start))); const c = b.payout * pct - b.claimed; if (c > 0) { b.claimed += c; claimed += c; if (pct >= 1) b.done = true; } }
    if (claimed > 0) { if (autostake) { const idx = liveIndex(); const ag = claimed / idx; w.agons += ag; db.totalAgons += ag; } else w.balance += claimed; save(); }
    return json(res, 200, { ok: true, claimed, autostake, ...account(d.wallet) });
  }
  serve(req, res);
}).listen(PORT, () => console.log('uOHM ($' + TOKEN + ') on :' + PORT + ' — APY ' + APY_TARGET + '% (simulated), rebase ' + REBASE_SEC + 's'));

setInterval(() => { if (Date.now() - db.lastRebase >= REBASE_SEC * 1000) rebase(); }, 1000);
