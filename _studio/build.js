'use strict';
// uOHM brand-kit generator. Writes self-contained HTML per asset into _studio/out/,
// then headless Chrome (ABSOLUTE file:// URLs) rasterizes each to Desktop.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">`;

const BASE = `
:root{--pink:#FF007A;--deep:#c40062;--soft:#ffd6ea;--ink:#1c0a13;--dim:#8a5c74;--bg:#fff7fb}
*{margin:0;padding:0;box-sizing:border-box}
html,body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);background:var(--bg);overflow:hidden}
.stage{position:relative;overflow:hidden;background:
  radial-gradient(60% 75% at 82% 8%,rgba(255,0,122,.14),transparent 60%),
  radial-gradient(55% 65% at 10% 95%,rgba(255,0,122,.10),transparent 55%),
  linear-gradient(165deg,#ffffff,#fff0f7)}
.grad{background:linear-gradient(92deg,#FF007A,#ff5ca8);-webkit-background-clip:text;background-clip:text;color:transparent}
.mono{font-family:'JetBrains Mono',monospace}
`;

// scattered (3,3) confetti + sparkles, deterministic
function field(w, h, n = 26, seed = 9) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = 2 + rnd() * 4, o = (0.08 + rnd() * 0.18).toFixed(2);
    out += `<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,0,122,${o})"/>`;
  }
  return `<svg style="position:absolute;inset:0" width="${w}" height="${h}">${out}</svg>`;
}

// unicorn roundel mark
function mark(size) {
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(140deg,#FF007A,#c40062);display:flex;align-items:center;justify-content:center;box-shadow:0 ${size * 0.05}px ${size * 0.22}px rgba(255,0,122,.45)">
    <div style="font-size:${size * 0.55}px;line-height:1">🦄</div></div>`;
}

const page = (w, h, css, body) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE}
.stage{width:${w}px;height:${h}px}${css}</style></head><body><div class="stage">${body}</div></body></html>`;

const assets = {};

// 1) PFP 800x800
assets['uohm-pfp'] = page(800, 800, `
  .stage{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px}
  .t{font-size:96px;font-weight:900;letter-spacing:-.03em}`,
  `${field(800, 800, 22, 5)}${mark(360)}<div class="t">u<span class="grad">OHM</span></div>`);

// 2) BANNER 1500x500
assets['uohm-banner'] = page(1500, 500, `
  .wrap{position:absolute;inset:0;display:flex;align-items:center;gap:56px;padding:0 90px}
  .h{font-size:92px;font-weight:900;letter-spacing:-.03em;line-height:1.02}
  .s{font-size:30px;color:var(--dim);margin-top:18px;font-weight:600}
  .pill{position:absolute;right:90px;bottom:44px;background:#fff;border:2px solid var(--pink);color:var(--pink);border-radius:999px;padding:12px 28px;font-weight:700;font-size:24px}`,
  `${field(1500, 500, 26, 11)}
   <div class="wrap">${mark(250)}
     <div><div class="h">The unicorn <span class="grad">reserve.</span></div>
       <div class="s">$uOHM · OHM-style (3,3) on Robinhood Chain · launching on pools.trade</div></div>
   </div><div class="pill mono">uohmrh.xyz</div>`);

// 3) KEY ART 2400x1350
assets['uohm-keyart'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:130px 150px;display:flex;flex-direction:column;justify-content:center}
  .ey{font-size:32px;letter-spacing:.28em;color:var(--pink);text-transform:uppercase;font-weight:700;margin-bottom:40px;max-width:1750px}
  .h{font-size:150px;font-weight:900;letter-spacing:-.03em;line-height:1.02;margin-bottom:48px}
  .s{font-size:44px;color:var(--dim);line-height:1.5;max-width:1500px;font-weight:500}
  .row{display:flex;gap:28px;margin-top:80px}
  .chip{background:#fff;border:2px solid rgba(255,0,122,.35);border-radius:999px;padding:20px 44px;font-size:34px;font-weight:700}
  .m{position:absolute;right:150px;top:120px}`,
  `${field(2400, 1350, 40, 23)}<div class="m">${mark(320)}</div>
   <div class="wrap">
     <div class="ey mono">the unicorn reserve · pools.trade · robinhood chain</div>
     <div class="h">The reserve currency<br>in DeFi's favorite<br><span class="grad">shade of pink.</span></div>
     <div class="s">Stake $uOHM and compound every epoch. Bond ETH or USDC at a discount and grow the treasury that backs it. The (3,3) engine that carried OHM to $4B — reborn as a unicorn.</div>
     <div class="row"><div class="chip">🦄 Stake → suOHM</div><div class="chip">💰 Bond → treasury</div><div class="chip">🤝 (3,3) → everyone wins</div><div class="chip mono" style="color:var(--pink)">uohmrh.xyz</div></div>
   </div>`);

// 4) HOW IT WORKS 2400x1350
const step = (n, t, d) => `<div style="flex:1;background:#fff;border:2px solid rgba(255,0,122,.3);border-radius:30px;padding:56px 48px;box-shadow:0 16px 50px rgba(255,0,122,.08)">
  <div class="mono" style="font-size:40px;color:var(--pink);margin-bottom:24px;font-weight:700">0${n}</div>
  <div style="font-size:52px;font-weight:800;margin-bottom:20px">${t}</div>
  <div style="font-size:33px;color:var(--dim);line-height:1.45;font-weight:500">${d}</div></div>`;
assets['uohm-howitworks'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:120px 140px;display:flex;flex-direction:column}
  .ey{font-size:38px;letter-spacing:.4em;color:var(--pink);text-transform:uppercase;font-weight:700;margin-bottom:26px}
  .h{font-size:100px;font-weight:900;letter-spacing:-.02em;margin-bottom:80px}
  .foot{margin-top:auto;display:flex;justify-content:space-between;align-items:center;font-size:34px;color:var(--dim);font-weight:600}`,
  `${field(2400, 1350, 36, 41)}
   <div class="wrap">
     <div class="ey mono">How it works</div>
     <div class="h">Stake. Bond. <span class="grad">(3,3).</span></div>
     <div style="display:flex;gap:40px">
       ${step(1, 'Stake $uOHM', 'Receive suOHM and rebase upward every epoch — automatic, compounding, nothing to claim. The index only goes up.')}
       ${step(2, 'Bond the treasury', 'Sell ETH or USDC to the protocol at a discount for vesting $uOHM. Every bond deepens the reserve under the horn.')}
       ${step(3, 'Play (3,3)', 'If everyone stakes, everyone wins. Cooperate and the unicorn runs — defect and it&#39;s glue.')}
     </div>
     <div class="foot"><div>🦄 the unicorn reserve · launching on pools.trade</div><div class="mono" style="color:var(--pink)">uohmrh.xyz</div></div>
   </div>`);

// 5) (3,3) MATRIX 2400x1350 — the classic game grid, unicorn edition
const cell = (v, best) => `<div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:64px;font-weight:800;border:2px solid rgba(255,0,122,.25);border-radius:24px;padding:44px;background:${best ? 'linear-gradient(140deg,#FF007A,#ff5ca8)' : '#fff'};color:${best ? '#fff' : 'var(--ink)'}">${v}</div>`;
assets['uohm-33'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:120px 160px;display:flex;gap:110px;align-items:center}
  .h{font-size:110px;font-weight:900;letter-spacing:-.02em;line-height:1.05;margin-bottom:40px}
  .s{font-size:40px;color:var(--dim);line-height:1.5;font-weight:500}
  .grid{flex:1;display:flex;flex-direction:column;gap:28px}
  .row{display:flex;gap:28px}
  .lab{font-size:34px;font-weight:700;color:var(--pink);text-align:center;margin-bottom:6px}`,
  `${field(2400, 1350, 34, 61)}
   <div class="wrap">
     <div style="flex:1.1">
       <div class="h">If everyone stakes,<br><span class="grad">everyone wins.</span></div>
       <div class="s">The (3,3) game, unicorn edition. Staking is cooperation. Bonding feeds the treasury. Selling is glue. Simple as.</div>
       <div class="mono" style="margin-top:56px;font-size:34px;color:var(--pink);font-weight:700">$uOHM · uohmrh.xyz · pools.trade</div>
     </div>
     <div class="grid">
       <div class="lab mono">you → · them ↓</div>
       <div class="row">${cell('(3,3) 🦄', true)}${cell('(1,1)')}</div>
       <div class="row">${cell('(1,1)')}${cell('(-3,-3) 🩸')}</div>
     </div>
   </div>`);

// 6) LAUNCH CARD 2400x1350 — pools.trade announcement
assets['uohm-launch'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  .ey{font-size:40px;letter-spacing:.45em;color:var(--pink);text-transform:uppercase;font-weight:700;margin-bottom:44px}
  .h{font-size:170px;font-weight:900;letter-spacing:-.03em;line-height:1;margin-bottom:44px}
  .s{font-size:46px;color:var(--dim);font-weight:600;margin-bottom:70px}
  .pill{background:linear-gradient(92deg,#FF007A,#ff5ca8);color:#fff;border-radius:999px;padding:26px 70px;font-size:44px;font-weight:800;box-shadow:0 20px 60px rgba(255,0,122,.35)}`,
  `${field(2400, 1350, 40, 77)}
   <div class="wrap">
     <div style="margin-bottom:56px">${mark(300)}</div>
     <div class="ey mono">launching on pools.trade — uniswap's launchpad</div>
     <div class="h">$u<span class="grad">OHM</span></div>
     <div class="s">The unicorn reserve · OHM-style (3,3) · Robinhood Chain</div>
     <div class="pill mono">uohmrh.xyz</div>
   </div>`);

for (const [name, html] of Object.entries(assets)) {
  fs.writeFileSync(path.join(OUT, name + '.html'), html);
  console.log('wrote', name + '.html');
}
console.log('done:', Object.keys(assets).length, 'assets');
