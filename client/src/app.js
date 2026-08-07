// uOHM (3,3) dashboard — metrics, live rebase, stake/bond/claim.
// All state is the off-chain ledger in server/index.js. Nothing here touches a contract.
(function () {
  const $ = (id) => document.getElementById(id);
  let M = null, A = null, CFG = null, chainBal = null, wallet = localStorage.getItem('uohm_w') || '';
  let anchor = null; // {index, nextIn, rate, rebaseSec, t, agons, totalAgons}
  let stakeMode = 'stake';

  const isW = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
  const commas = (n, d) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const money = (n) => '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2));
  const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? commas(n, 0) : commas(n, 2);
  const pct = (n) => (n * 100).toLocaleString('en-US', { maximumFractionDigits: n < 0.01 ? 3 : 2 }) + '%';
  const apyFmt = (n) => commas(n, 0) + '%';
  function toast(t) { const e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(e._t); e._t = setTimeout(() => e.style.display = 'none', 2400); }

  // ---- theme (defaults light, remembers the choice) ----
  const themeBtn = $('themeBtn');
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('uohm_theme', t);
    if (themeBtn) themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  setTheme(localStorage.getItem('uohm_theme') || 'light');
  if (themeBtn) themeBtn.onclick = () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');

  // ---- views ----
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    if (!t.dataset.view) return; // /docs is a real link
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    ['dash', 'stake', 'bond', 'calc'].forEach((v) => $(v).classList.toggle('hide', v !== t.dataset.view));
  }));

  // ---- wallet (EVM connect via injected provider) ----
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  function renderWallet() {
    const b = $('connectBtn');
    if (wallet) { b.textContent = short(wallet); b.classList.add('connected'); b.classList.remove('primary'); b.title = 'Disconnect'; }
    else { b.textContent = 'Connect Wallet'; b.classList.remove('connected'); b.classList.add('primary'); b.title = ''; }
  }
  function setWallet(a) {
    if (a && isW(a)) { wallet = a; localStorage.setItem('uohm_w', a); renderWallet(); loadAccount(); loadChainBalance(); }
    else { wallet = ''; A = null; localStorage.removeItem('uohm_w'); renderWallet(); ['yStaked', 'yBalance', 'yNext'].forEach((id) => $(id).textContent = '—'); renderYourBonds(); }
  }
  $('connectBtn').onclick = async () => {
    if (wallet) { setWallet(''); toast('Wallet disconnected'); return; }
    const eth = window.ethereum;
    if (!eth) return toast('No EVM wallet found — install MetaMask or Rabby');
    try {
      const acc = await eth.request({ method: 'eth_requestAccounts' });
      if (acc && acc[0] && isW(acc[0])) { setWallet(acc[0]); toast('Connected ' + short(acc[0]) + ' (3,3)'); }
      else toast('No account returned');
    } catch (e) { toast('Connection rejected'); }
  };
  if (window.ethereum && window.ethereum.on) window.ethereum.on('accountsChanged', (acc) => { setWallet(acc && acc[0]); });
  renderWallet();

  // ---- fetch ----
  async function loadConfig() { try { CFG = await (await fetch('/api/config')).json(); } catch (e) {} }
  async function loadMetrics() { try { M = await (await fetch('/api/metrics')).json(); reanchor(); renderMetrics(); renderBonds(); } catch (e) {} }
  // real on-chain $uOHM balance, read server-side from the Robinhood Chain RPC —
  // correct even when the user's wallet is parked on a different chain.
  async function loadChainBalance() {
    if (!isW(wallet)) { chainBal = null; return; }
    try {
      const r = await (await fetch('/api/balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet }) })).json();
      chainBal = r.error ? null : r.balance;
    } catch (e) { chainBal = null; }
    renderAccount();
  }
  // deposits must go out on Robinhood Chain — switch (or add) the network first
  async function ensureChain() {
    const idHex = '0x' + (+CFG.chainId).toString(16);
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    if (cur === idHex) return;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: idHex }] });
    } catch (e) {
      if (e && (e.code === 4902 || String(e.message).includes('4902') || String(e.message).toLowerCase().includes('unrecognized'))) {
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: idHex, chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [CFG.rpcUrl], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] }] });
      } else throw new Error('switch your wallet to Robinhood Chain to stake');
    }
  }
  async function loadAccount() { if (!isW(wallet)) return; try { A = await (await fetch('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet }) })).json(); reanchor(); renderAccount(); } catch (e) {} }
  function reanchor() {
    if (!M) return;
    anchor = { index: M.index, nextIn: M.nextRebaseIn, rate: M.rate, rebaseSec: M.rebaseSec, t: Date.now(),
      agons: A && A.staked ? A.staked / A.index : 0, totalAgons: M.totalStaked / M.index, treasury: M.treasury, totalStaked: M.totalStaked, price: M.price };
  }
  function liveIndex() {
    if (!anchor) return { index: 1, nextIn: 0 };
    let idx = anchor.index; let nextIn = anchor.nextIn - (Date.now() - anchor.t) / 1000;
    let guard = 0; while (nextIn < 0 && guard++ < 50) { idx *= (1 + anchor.rate); nextIn += anchor.rebaseSec; }
    const frac = 1 - nextIn / anchor.rebaseSec;
    return { index: idx * (1 + anchor.rate * frac), nextIn };
  }

  // ---- render ----
  function renderMetrics() {
    if (!M) return;
    $('mApy').textContent = apyFmt(M.apy);
    // 24-hour APY boost banner + countdown
    const note = $('mApyNote'), card = $('mApy').closest('.stat');
    if (M.boost) {
      boostEnd = Date.now() + M.boost.secondsLeft * 1000; boostLeft = M.boost.secondsLeft;
      if (card) card.classList.add('boosting');
      if (note) note.innerHTML = '⚡ 24-HOUR APY BOOST · <span id="boostCd" class="cd"></span> left';
    } else {
      boostLeft = 0; if (card) card.classList.remove('boosting');
      if (note) note.textContent = '🦄 fixed 250,000% · every epoch';
    }
    $('mTreasury').textContent = money(M.treasury);
    $('mBacking').textContent = 'backing $' + M.backingPerToken.toFixed(6) + ' / $uOHM';
    $('mPrice').textContent = '$' + M.price.toFixed(4);
    $('mMc').textContent = 'mcap ' + money(M.marketCap);
    $('mRatio').textContent = pct(M.stakingRatio) + ' of supply';
    $('mRunway').textContent = M.runwayDays == null ? '—'
      : M.runwayDays >= 365 ? (M.runwayDays / 365).toFixed(1) + ' yr'
      : Math.round(M.runwayDays) + ' days';
    $('mEpoch').textContent = M.epoch;
    $('yApy').textContent = apyFmt(M.apy);
    const roi = (days) => Math.pow(1 + M.rate, days * 86400 / M.rebaseSec) - 1;
    $('yRoi5').textContent = pct(roi(5)); $('yRoi7').textContent = pct(roi(7)); $('yRoi30').textContent = pct(roi(30)); $('yRoi1y').textContent = apyFmt(M.apy);
    // top stakers
    if (M.leaderboard && M.leaderboard.length) {
      $('lbPanel').style.display = 'block';
      $('lbRows').innerHTML = M.leaderboard.map((b, i) => `<div class="row"><span>${i + 1}. <b class="cd">${b.wallet}</b></span><span><b class="tl">${tok(b.staked)} suOHM</b> <span style="color:var(--mut)">· ${pct(b.share)}</span></span></div>`).join('');
    }
    // the Stampede: staking-ratio bar + live tape
    $('stBar').style.width = Math.min(100, M.stakingRatio * 100).toFixed(2) + '%';
    $('stRatioLbl').textContent = pct(M.stakingRatio) + ' of supply staked';
    if (M.tape && M.tape.length) {
      const ago = (t) => { const s = Math.max(1, (Date.now() - t) / 1000); return s < 60 ? Math.floor(s) + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : Math.floor(s / 3600) + 'h ago'; };
      const ico = { stake: '🦄', unstake: '🩸', bond: '💰' };
      const verb = { stake: 'staked', unstake: 'unstaked', bond: 'bonded' };
      $('stRows').innerHTML = M.tape.map((e) => `<div class="row"><span>${ico[e.type] || '·'} <b class="cd">${e.w}</b> ${verb[e.type] || e.type} <b class="tl">${tok(e.amount)} $uOHM</b></span><span style="color:var(--mut)">${ago(e.t)}</span></div>`).join('');
    }
    calc();
    if (M.mint) { const bar = $('ca'); bar.style.display = 'flex'; $('caV').textContent = M.mint.slice(0, 6) + '…' + M.mint.slice(-4); bar.href = 'https://pools.trade'; $('caCopy').onclick = (e) => { e.preventDefault(); navigator.clipboard && navigator.clipboard.writeText(M.mint); $('caCopy').textContent = 'Copied'; setTimeout(() => $('caCopy').textContent = 'Copy', 1200); }; }
  }
  function renderAccount() {
    if (!A) return;
    $('yBalance').textContent = chainBal == null ? '—' : tok(chainBal) + ' $uOHM';
    $('yNext').textContent = '+' + (A.staked * M.rate).toFixed(4) + ' $uOHM';
    updateLockUI();
    if (A.pendingOut > 0) toastOnce('Withdrawal of ' + tok(A.pendingOut) + ' $uOHM pending — paid from the treasury');
  }
  let _toasted = ''; function toastOnce(m) { if (_toasted === m) return; _toasted = m; toast(m); }
  // stake lock: local ticking countdown off the last server-reported lockRemaining
  let lockUntil = 0, boostLeft = 0, boostEnd = 0;
  function fmtDur(s) { s = Math.max(0, Math.ceil(s)); const m = Math.floor(s / 60), ss = s % 60; return m > 0 ? m + 'm ' + String(ss).padStart(2, '0') + 's' : ss + 's'; }
  function updateLockUI() {
    if (A && A.lockRemaining != null) lockUntil = A.lockRemaining > 0 ? Date.now() + A.lockRemaining * 1000 : 0;
    const left = lockUntil ? (lockUntil - Date.now()) / 1000 : 0;
    const row = $('yLockRow'); if (row) { row.style.display = left > 0 ? 'flex' : 'none'; if (left > 0) $('yLock').textContent = fmtDur(left); }
    if (stakeMode === 'unstake') {
      const btn = $('stakeBtn'); if (btn) { btn.disabled = left > 0; btn.textContent = left > 0 ? 'Locked · ' + fmtDur(left) : 'Unstake'; }
    }
  }
  function renderBonds() {
    if (!M) return;
    $('bondCards').innerHTML = M.bonds.map((b) => `
      <div class="bond"><h3>${b.name}</h3>
        <div class="disc">${(b.discount * 100).toFixed(1)}%</div><div class="dl">discount · ${b.vestDays}-day vest</div>
        <div class="br"><span>Bond price</span><b>$${b.price.toFixed(4)}</b></div>
        <div class="br"><span>Discount vs market</span><b style="color:var(--success)">+${(b.discount * 100).toFixed(1)}%</b></div>
        <div class="bf"><input id="bondAmt_${b.id}" type="text" inputmode="decimal" placeholder="$ amount"><button data-bond="${b.id}">Bond</button></div>
      </div>`).join('');
    $('bondCards').querySelectorAll('[data-bond]').forEach((btn) => btn.addEventListener('click', () => doBond(btn.dataset.bond)));
  }
  function renderYourBonds() {
    if (!A) { $('yourBonds').innerHTML = '<div class="psub">Connect your wallet to see your bonds.</div>'; return; }
    if (!A.bonds || !A.bonds.length) { $('yourBonds').innerHTML = '<div class="psub">No active bonds.</div>'; return; }
    $('yourBonds').innerHTML = A.bonds.map((b) => `
      <div class="yb"><span>${b.market} · <b>${tok(b.payout)}</b> $uOHM</span>
        <div class="prog"><i style="width:${(b.pct * 100).toFixed(0)}%"></i></div>
        <span class="tl"><b>${tok(b.claimable)}</b> claimable</span></div>`).join('') +
      `<div style="display:flex;gap:8px;margin-top:14px"><button class="btn ghost" id="claimBtn">Claim</button><button class="btn primary" id="claimStakeBtn">Claim &amp; Stake</button></div>`;
    const cb = $('claimBtn'), cs = $('claimStakeBtn'); if (cb) cb.onclick = () => doClaim(false); if (cs) cs.onclick = () => doClaim(true);
  }

  // ---- actions ----
  $('segStake').onclick = () => { stakeMode = 'stake'; $('segStake').classList.add('on'); $('segUnstake').classList.remove('on'); $('stakeBtn').disabled = false; $('stakeBtn').textContent = 'Stake'; };
  $('segUnstake').onclick = () => { stakeMode = 'unstake'; $('segUnstake').classList.add('on'); $('segStake').classList.remove('on'); $('stakeBtn').textContent = 'Unstake'; updateLockUI(); };
  $('stakeMax').onclick = () => { if (!A) return; $('stakeAmt').value = (stakeMode === 'stake' ? (chainBal || 0) : A.staked).toFixed(2); };
  // stake = a REAL $uOHM transfer to the protocol treasury, then the ledger credits suOHM.
  async function depositToTreasury(amt) {
    if (!window.ethereum) throw new Error('No EVM wallet found');
    if (!CFG || !CFG.mint || !CFG.treasury) throw new Error('config not loaded — try again');
    await ensureChain();
    const wei = BigInt(Math.round(amt * 1e6)) * (10n ** 12n);
    const data = '0xa9059cbb' + CFG.treasury.slice(2).toLowerCase().padStart(64, '0') + wei.toString(16).padStart(64, '0');
    const txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: CFG.mint, data }] });
    toast('Deposit sent — waiting for confirmation…');
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try { const rc = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
        if (rc) { if (rc.status === '0x1') return txHash; throw new Error('deposit transaction failed'); } } catch (e) { if (String(e.message).includes('failed')) throw e; }
    }
    throw new Error('deposit not confirmed yet — refresh in a minute');
  }
  $('stakeBtn').onclick = async () => {
    if (!isW(wallet)) return toast('connect your wallet first');
    const amt = parseFloat($('stakeAmt').value); if (!(amt > 0)) return toast('enter an amount');
    // hard gate BEFORE any real deposit leaves the wallet — the ledger would reject it after
    if (stakeMode === 'stake' && CFG && CFG.minStake && amt < CFG.minStake) return toast('minimum stake is ' + tok(CFG.minStake) + ' $uOHM');
    try {
      if (stakeMode === 'stake') {
        const txHash = await depositToTreasury(amt);
        toast('Deposit confirmed — verifying on-chain…');
        const r = await post('/api/stake', { wallet, txHash });
        if (r.error) return toast(r.error);
        A = r; reanchor(); renderAccount(); loadChainBalance(); $('stakeAmt').value = '';
        toast('Deposited & staked ' + tok(amt) + ' $uOHM (3,3)');
      } else {
        const r = await post('/api/unstake', { wallet, amount: amt });
        if (r.error) return toast(r.error);
        A = r; reanchor(); renderAccount(); $('stakeAmt').value = '';
        toast('Unstaked — ' + tok(r.queued) + ' $uOHM queued for payout from the treasury');
      }
    } catch (e) { toast(e && e.message ? e.message : 'transaction rejected'); }
  };
  async function doBond(id) {
    if (!isW(wallet)) return toast('connect your wallet first');
    const amt = parseFloat(($('bondAmt_' + id) || {}).value); if (!(amt > 0)) return toast('enter an amount');
    const r = await post('/api/bond', { wallet, market: id, amount: amt });
    if (r.error) return toast(r.error); A = r; renderYourBonds(); loadMetrics(); $('bondAmt_' + id).value = ''; toast('Bonded — ' + tok(r.payout) + ' $uOHM vesting');
  }
  async function doClaim(autostake) {
    const r = await post('/api/claim', { wallet, autostake });
    if (r.error) return toast(r.error); A = r; reanchor(); renderAccount(); renderYourBonds(); toast(autostake ? 'Claimed & staked ' + tok(r.claimed) : 'Claimed ' + tok(r.claimed) + ' $uOHM');
  }
  async function post(url, b) { try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(); } catch (e) { return { error: 'request failed' }; } }

  // ---- live tick (setInterval, not rAF: rAF is throttled/dead in embedded panes) ----
  function tick() {
    if (!anchor || !M) return;
    const li = liveIndex();
    const cd = Math.max(0, li.nextIn); const mm = Math.floor(cd / 60), ss = Math.floor(cd % 60);
    const cds = mm + ':' + String(ss).padStart(2, '0');
    $('mRebase').textContent = cds; $('yRebase').textContent = cds;
    $('mIndex').textContent = li.index.toFixed(5);
    const ratio = li.index / anchor.index;
    $('mStaked').textContent = tok(anchor.totalStaked * ratio) + ' suOHM';
    if (A && anchor.agons) { $('yStaked').textContent = (anchor.agons * li.index).toFixed(4) + ' suOHM'; }
    else if (A) $('yStaked').textContent = '0.0000 suOHM';
    if (lockUntil) updateLockUI();
    if (boostLeft > 0) { boostLeft = (boostEnd - Date.now()) / 1000; const b = $('boostCd'); if (b) { const s = Math.max(0, boostLeft); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60); b.textContent = h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); } }
  }
  // ---- calculator ----
  function calc() {
    if (!M) return; const amt = parseFloat($('calcAmt').value) || 0; const days = +$('calcDays').value;
    $('calcDaysL').textContent = days; $('calcPrice').textContent = M.price.toFixed(4);
    const out = amt * Math.pow(1 + M.rate, days * 86400 / M.rebaseSec);
    $('calcOut').textContent = tok(out) + ' $uOHM';
    $('calcMult').textContent = (out / (amt || 1)).toFixed(1) + '× your stake';
    $('calcUsd').textContent = money(out * M.price);
    $('calcProfit').textContent = '+' + money((out - amt) * M.price);
  }
  $('calcAmt').addEventListener('input', calc); $('calcDays').addEventListener('input', calc);

  loadConfig().then(() => { if (wallet) loadChainBalance(); }); loadMetrics(); if (wallet) loadAccount();
  setInterval(loadMetrics, 6000); setInterval(() => { if (wallet) { loadAccount(); renderYourBonds(); } }, 6000);
  renderYourBonds(); setInterval(tick, 100); tick();
})();
