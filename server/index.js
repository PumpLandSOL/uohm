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

const PORT = process.env.PORT || 8178;
const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.TOKEN_TICKER || 'uOHM';
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, 'data.json');
const UOHM_MINT = process.env.UOHM_MINT || '0x91F41b74b7906266d4D28a327EBD0ed86c119261';  // $uOHM on Robinhood Chain
// staking custody: real $uOHM deposits land here (key held offline by the operator — never on this server)
const TREASURY_WALLET = process.env.TREASURY_WALLET || '0x6A690F711928E8b938Fb5FE38F6fc2B8164Abc97';
const ADMIN_KEY = process.env.ADMIN_KEY || '';  // set to enable /api/withdrawals admin export
const REBASE_SEC = +(process.env.REBASE_SEC || 300);           // epoch length (demo: 5 min)
const APY_TARGET = +(process.env.APY_TARGET || 50000);         // displayed APY %  (OHM-style, simulated)
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
const SEED_BALANCE = +(process.env.SEED_BALANCE || 1e6);       // demo: new wallet starts with this uOHM to try staking (raised from 1k — no more perceived stake cap)
// per-rebase rate derived from target APY
const REBASES_YR = 31557600 / REBASE_SEC;
const RATE = Math.pow(1 + APY_TARGET / 100, 1 / REBASES_YR) - 1;
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

function rebase() { db.index *= (1 + RATE); db.epoch++; db.lastRebase = Date.now(); save(); }
// catch up missed epochs on boot
(function catchup() { const missed = Math.floor((Date.now() - db.lastRebase) / 1000 / REBASE_SEC); for (let i = 0; i < Math.min(missed, 10000); i++) rebase(); })();

function liveIndex() { const frac = (Date.now() - db.lastRebase) / 1000 / REBASE_SEC; return db.index * (1 + RATE * Math.max(0, Math.min(1, frac))); }
function W(addr) { return db.wallets[addr] || (db.wallets[addr] = { balance: SEED_BALANCE, agons: 0, bonds: [], seeded: true }); }
function stakedOf(w, idx) { return w.agons * (idx || liveIndex()); }
function totalStaked(idx) { return db.totalAgons * (idx || liveIndex()); }
const circulating = () => TOTAL_SUPPLY;

function metrics() {
  const idx = liveIndex(); const ts = totalStaked(idx);
  const leaderboard = Object.entries(db.wallets).map(([a, w]) => ({ a, staked: w.agons * idx }))
    .filter((x) => x.staked > 0.001).sort((x, y) => y.staked - x.staked).slice(0, 8)
    .map((x) => ({ wallet: x.a.slice(0, 4) + '…' + x.a.slice(-4), staked: x.staked, share: ts > 0 ? x.staked / ts : 0 }));
  const backing = db.treasury / circulating();
  // runway: days the treasury can fund current reward emissions (rewards per day in $ vs treasury)
  const rewardsPerDay = ts * (Math.pow(1 + RATE, 86400 / REBASE_SEC) - 1) * TOKEN_PRICE;
  // nothing staked => nothing emitting => runway is undefined, not zero. null so the UI can say so.
  const runway = rewardsPerDay > 0 ? db.treasury / rewardsPerDay : null;
  return {
    token: TOKEN, apy: APY_TARGET, rate: RATE, index: +idx.toFixed(6), epoch: db.epoch,
    totalStaked: ts, circulating: circulating(), stakingRatio: ts / circulating(),
    treasury: db.treasury, backingPerToken: backing, price: TOKEN_PRICE, marketCap: TOKEN_PRICE * circulating(),
    runwayDays: runway, rebaseSec: REBASE_SEC, nextRebaseIn: Math.max(0, REBASE_SEC - (Date.now() - db.lastRebase) / 1000),
    bonds: BONDS.map((b) => ({ id: b.id, name: b.name, discount: b.discount, vestDays: b.vestDays, price: TOKEN_PRICE * (1 - b.discount) })),
    leaderboard, stakers: leaderboard.length, mint: UOHM_MINT, tape: db.tape.slice(0, 12),
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
    nextReward: stakedOf(w, idx) * RATE, bonds, seeded: !!w.seeded, pendingOut };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serve(req, res) { let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/client/landing.html'; if (u === '/app' || u === '/app/') u = '/client/index.html'; if (u === '/docs' || u === '/docs/') u = '/client/docs.html'; const f = path.normalize(path.join(ROOT, u)); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); } fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); }); }
function json(res, c, o) { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }

http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/config') return json(res, 200, { token: TOKEN, rebaseSec: REBASE_SEC, apy: APY_TARGET, mint: UOHM_MINT, treasury: TREASURY_WALLET, network: 'robinhood-chain' });
  if (u === '/api/metrics') return json(res, 200, metrics());
  if (req.method === 'POST' && u === '/api/account') { const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a valid EVM wallet' }); return json(res, 200, account(d.wallet)); }
  // stake = a real on-chain $uOHM transfer to the treasury; the client sends the tx hash after it confirms.
  // The ledger credits suOHM against that deposit. (Deposit hashes are recorded for reconciliation.)
  if (req.method === 'POST' && u === '/api/stake') { const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'bad wallet' }); if (!/^0x[0-9a-fA-F]{64}$/.test(d.txHash || '')) return json(res, 200, { error: 'missing deposit tx — stake sends $uOHM to the treasury first' }); if (db.tape.some((e) => e.tx === d.txHash)) return json(res, 200, { error: 'deposit already credited' }); const w = W(d.wallet); const idx = liveIndex(); const amt = +d.amount || 0; if (amt <= 0) return json(res, 200, { error: 'nothing to stake' }); const ag = amt / idx; w.agons += ag; db.totalAgons += ag; tapePush('stake', d.wallet, amt); db.tape[0].tx = d.txHash; save(); return json(res, 200, { ok: true, ...account(d.wallet) }); }
  // unstake = join the withdrawal queue; payouts are sent manually from the treasury wallet.
  if (req.method === 'POST' && u === '/api/unstake') { const d = await body(req); if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'bad wallet' }); const w = W(d.wallet); const idx = liveIndex(); const have = stakedOf(w, idx); const amt = Math.max(0, Math.min(+d.amount || 0, have)); if (amt <= 0) return json(res, 200, { error: 'nothing staked' }); const ag = amt / idx; w.agons = Math.max(0, w.agons - ag); db.totalAgons = Math.max(0, db.totalAgons - ag); db.withdrawals.push({ wallet: d.wallet, amount: +amt.toFixed(4), t: Date.now(), status: 'pending' }); tapePush('unstake', d.wallet, amt); save(); return json(res, 200, { ok: true, queued: +amt.toFixed(4), ...account(d.wallet) }); }
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
