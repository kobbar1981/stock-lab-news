// Cross-sectional momentum rotation study. Honest protocol, same as research.mjs:
// variants searched ONLY on train windows; 3 best locked; evaluated once on held-out test windows.
// Rebalance every W trading days. Rank by past L-day return skipping the last S days.
// Top N equal weight, entry next open, exit next open at next rebalance.
// Per-position cost each window: slippage by ADV (both sides) + 0.4% round-trip fees.
// Conservative: full round-trip charged every window even when a name stays in the portfolio.
import fs from 'node:fs';
const num = x => parseFloat(String(x).replace(/[$,]/g, ''));
const bars = JSON.parse(fs.readFileSync('bars.json', 'utf8'));
const uni = JSON.parse(fs.readFileSync('universe_dir.json', 'utf8')); // directory+screener universe w/ caps
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' };
const slip = adv => adv < 1e7 ? 0.6 : adv < 2.5e7 ? 0.35 : adv < 1e8 ? 0.2 : 0.1;
const dk = t => new Date(t * 1000).toISOString().slice(0, 10);
// SPY bars = trading calendar + regime + benchmark
const f2 = new Date(Date.now() - 800 * 864e5).toISOString().slice(0, 10), t2 = new Date().toISOString().slice(0, 10);
const j2 = await (await fetch(`https://api.nasdaq.com/api/quote/SPY/historical?assetclass=etf&fromdate=${f2}&limit=1000&todate=${t2}`, { headers: UA, signal: AbortSignal.timeout(25000) })).json();
const SP = (j2?.data?.tradesTable?.rows || []).map(r => { const [m, dd, y] = r.date.split('/'); return [Date.UTC(+y, +m - 1, +dd) / 1000, num(r.open), num(r.close)]; }).filter(b => isFinite(b[0]) && isFinite(b[1]) && isFinite(b[2])).sort((a, b) => a[0] - b[0]);
console.log('SPY bars:', SP.length);
const spyReg = {}; for (let i = 50; i < SP.length; i++) { let a = 0; for (let k = i - 49; k <= i; k++) a += SP[k][2]; spyReg[dk(SP[i][0])] = SP[i][2] > a / 50; }
const days = SP.map(b => b[0]);
// Precompute per-symbol indicator rows: for each bar index: close, open, adv20, sma50flag
const ind = {};
for (const s of Object.keys(uni)) {
  const B = bars[s]; if (!B || B.length < 160) continue;
  const tmap = new Map(); // time -> index
  const rows = [];
  for (let i = 0; i < B.length; i++) {
    tmap.set(B[i][0], i);
    let adv = null, s50 = null;
    if (i >= 20) { let a = 0; for (let k = i - 20; k < i; k++) a += B[k][5] * B[k][4]; adv = a / 20; }
    if (i >= 50) { let a = 0; for (let k = i - 50; k < i; k++) a += B[k][4]; s50 = B[i][4] > a / 50; }
    rows.push({ t: B[i][0], o: B[i][1], c: B[i][4], adv, s50 });
    ind[s] = { rows, tmap };
  }
}
let uniKeys = Object.keys(uni);
if (!uniKeys.length) { for (const s of Object.keys(bars)) if (bars[s] && bars[s].length >= 160) uni[s] = 1; uniKeys = Object.keys(uni); console.log('universe_dir empty - falling back to bars-key universe:', uniKeys.length); }
console.log('symbols with indicators:', Object.keys(ind).length);
// variant grid
const V = [];
for (const L of [21, 63]) for (const S of [0, 5]) for (const N of [10, 20]) for (const W of [5, 21]) for (const trend of [false, true]) for (const reg of [false, true])
  V.push({ L, S, N, W, trend, reg });
console.log('trials:', V.length);
const rec = V.map(() => []); // per variant: [windowTime, meanNetPctPerPosition, spyPct, nPos]
// rebalance anchors: every W trading days, but grid W differs per variant - compute per variant
for (let vi = 0; vi < V.length; vi++) {
  const v = V[vi];
  for (let ti = 160; ti + v.W + 2 < days.length; ti += v.W) {
    const t0 = days[ti], tN = days[ti + v.W]; // rebalance day, next rebalance day
    if (v.reg && spyReg[dk(t0)] !== true) continue;
    // rank
    const cands = [];
    for (const s of Object.keys(ind)) {
      const { rows, tmap } = ind[s];
      const i = tmap.get(t0); if (i === undefined) continue;
      const iE = tmap.get(days[ti + 1]), iX = tmap.get(days[ti + v.W + 1]);
      if (iE === undefined || iX === undefined) continue;
      const back = i - v.S - v.L; if (back < 0) continue;
      const r = rows[i - v.S]; const rb = rows[back];
      if (!r.adv || r.adv < 5e6 || r.c < 3) continue;
      if (v.trend && r.s50 !== true) continue;
      const mom = (r.c / rb.c - 1) * 100;
      cands.push({ s, mom, adv: r.adv, eOpen: rows[iE].o, xOpen: rows[iX].o });
    }
    if (cands.length < v.N) continue;
    cands.sort((a, b) => b.mom - a.mom);
    const pick = cands.slice(0, v.N);
    let sum = 0;
    for (const p of pick) { const sl = slip(p.adv); const e = p.eOpen * (1 + sl / 100), x = p.xOpen * (1 - sl / 100); sum += (x / e - 1) * 100 - 0.4; }
    const spyR = (SP[ti + v.W + 1][1] / SP[ti + 1][1] - 1) * 100;
    rec[vi].push([t0, sum / pick.length, spyR, pick.length]);
  }
}
const allT = rec.flatMap(r => r.map(x => x[0])).sort((a, b) => a - b);
const split = allT.length ? allT[Math.floor(allT.length * 0.6)] : days[Math.floor(days.length * 0.6)];
const st = arr => { const n = arr.length; if (!n) return { n: 0 }; const m = arr.reduce((s, x) => s + x[1], 0) / n; const spy = arr.reduce((s, x) => s + x[2], 0) / n; const w = arr.filter(x => x[1] > 0).length; return { windows: n, meanNetPctPerWindow: +m.toFixed(2), spyPctPerWindow: +spy.toFixed(2), excessPct: +(m - spy).toFixed(2), winRatePct: +(w / n * 100).toFixed(0) }; };
const rows = V.map((v, i) => ({ v, train: st(rec[i].filter(x => x[0] < split)), test: st(rec[i].filter(x => x[0] >= split)) }));
const eligible = rows.filter(r => r.train.windows >= 10).sort((a, b) => b.train.meanNetPctPerWindow - a.train.meanNetPctPerWindow);
const locked = eligible.slice(0, 3);
// last ~2 months: windows in final 44 trading days, for locked variants AND median of all eligible
const recentCut = days[Math.max(0, days.length - 45)];
const recent = v => { const w = rec[V.findIndex(x => x === v)].filter(x => x[0] >= recentCut); return st(w); };
const med = (arr, f) => { const a = arr.map(f).filter(isFinite).sort((x, y) => x - y); return a.length ? +a[Math.floor(a.length / 2)].toFixed(2) : null; };
const out = { generatedAt: new Date().toISOString(), trials: V.length, universeSize: Object.keys(ind).length, trainWindowsEnd: dk(split), testFrom: dk(split),
  note: 'Cross-sectional momentum rotation. Every W trading days rank the $300M-$10B universe by past L-day return (skipping last S days), buy top N equal weight at next open, exit at next open next rebalance. Costs: slippage 0.1-0.6%/side by liquidity + 0.4% round-trip fees charged EVERY window per position (conservative - names that persist are overcharged). Filters: price>=$3, ADV>=$5M, optional above-50dma trend, optional SPY>50dma regime. Variants searched on TRAIN windows only; 3 locked; evaluated once on TEST. CAVEATS: current-universe survivorship (delisted names missing overstates returns); 64 correlated trials; rebalance-day prices from delayed Nasdaq data.',
  locked: locked.map(r => ({ variant: r.v, train: r.train, test: r.test })),
  anyPositiveOutOfSample: locked.some(r => r.test.windows >= 5 && r.test.meanNetPctPerWindow > 0 && r.test.excessPct > 0),
  medianTrainAllVariants: med(eligible, r => r.train.meanNetPctPerWindow),
  medianTestAllVariants: med(rows.filter(r => r.test.windows >= 5), r => r.test.meanNetPctPerWindow),
  lastTwoMonths: { label: 'TINY noisy sample (~9 weekly / 2 monthly windows) - indication only, not evidence', cutFrom: dk(recentCut), locked: locked.map(r => ({ variant: r.v, recent: recent(r.v) })), medianRecentAllEligible: med(eligible, r => recent(r.v).meanNetPctPerWindow) } };
fs.writeFileSync('research_momentum.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
// current momentum ranking for Kobi (latest date): L=63, skip 5, trend+liquidity
const ti = days.length - 1; const t0 = days[ti];
const cur = [];
for (const s of Object.keys(ind)) { const { rows, tmap } = ind[s]; const i = tmap.get(t0); if (i === undefined) continue; const back = i - 5 - 63; if (back < 0) continue; const r = rows[i - 5]; if (!r.adv || r.adv < 5e6 || r.c < 3 || r.s50 !== true) continue; cur.push({ s, mom63: +((r.c / rows[back].c - 1) * 100).toFixed(1), mom21: +((r.c / rows[i - 5 - 21].c - 1) * 100).toFixed(1) }); }
cur.sort((a, b) => b.mom63 - a.mom63);
fs.writeFileSync('momentum_now.json', JSON.stringify({ asOf: dk(t0), top: cur.slice(0, 30) }, null, 1));
console.log('current top momentum (63d, skip5):', JSON.stringify(cur.slice(0, 15)));
