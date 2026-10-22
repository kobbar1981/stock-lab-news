// Train/test rule-variant study. Variants are searched ONLY on the earlier period; best few are locked and evaluated once on the later held-out period.
import fs from 'node:fs';
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json, text/plain, */*' };
const LIMIT = +process.env.LIMIT || 0, CONC = +process.env.CONC || 10, COST = 0.4;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => parseFloat(String(x).replace(/[$,]/g, ''));
async function get(url, text = false) { for (let i = 0; i < 3; i++) { try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) }); if (r.status === 429) { await sleep(2000 * (i + 1)); continue; } if (!r.ok) { if (r.status === 404) return null; continue; } return text ? await r.text() : await r.json(); } catch { await sleep(700); } } return undefined; }
const from = new Date(Date.now() - 740 * 864e5).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
const url = (s, c = 'stocks') => `https://api.nasdaq.com/api/quote/${s}/historical?assetclass=${c}&fromdate=${from}&limit=1000&todate=${to}`;
function bars(d) { const rows = d?.data?.tradesTable?.rows; if (!rows) return null; return rows.map(r => { const [m, dd, y] = r.date.split('/'); return { t: Date.UTC(+y, +m - 1, +dd) / 1000, o: num(r.open), c: num(r.close), h: num(r.high), l: num(r.low), v: num(r.volume) }; }).filter(b => [b.o, b.c, b.h, b.l, b.v].every(isFinite)).sort((a, b) => a.t - b.t); }
const slip = adv => adv < 1e7 ? 0.6 : adv < 2.5e7 ? 0.35 : adv < 1e8 ? 0.2 : 0.1;
// grid
const V = [];
for (const entry of ['breakout', 'pullback']) for (const lb of [20, 55]) for (const vr of [1.5, 2]) for (const reg of [false, true]) for (const trend of [false, true]) for (const liq of [5e6, 2e7]) for (const ex of [[5, 8, 10], [7, 15, 20], [10, 20, 20], [8, 25, 30]]) V.push({ entry, lb, vr, reg, trend, minDollarVol: liq, stop: ex[0], tgt: ex[1], hold: ex[2] });
const rec = V.map(() => []);
const spy = bars(await get(url('SPY', 'etf'))); const reg = {};
const dk = t => new Date(t * 1000).toISOString().slice(0, 10);
for (let i = 50; i < spy.length; i++) { let a = 0; for (let k = i - 49; k <= i; k++) a += spy[k].c; reg[dk(spy[i].t)] = spy[i].c > a / 50; }
const scr = await get('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true');
const cap = {}; for (const r of scr?.data?.rows || []) { const c = num(r.marketCap); cap[r.symbol] = isFinite(c) && c > 0 ? c : null; }
const a = await get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', true), b = await get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt', true);
const BAD = /warrant|rights?\b|units?\b|preferred|depositary shares|notes due|acquisition corp|trust\b|fund\b|etf|etn|index|% /i;
let uni = [];
for (const l of a.split('\n').slice(1)) { const c = l.trim().split('|'); if (c.length >= 8 && c[3] === 'N' && c[6] === 'N' && c[7] === 'N' && c[4] === 'N' && /^[A-Z]{1,5}$/.test(c[0]) && !BAD.test(c[1])) uni.push(c[0]); }
for (const l of b.split('\n').slice(1)) { const c = l.trim().split('|'); if (c.length >= 8 && ['N', 'A'].includes(c[2]) && c[4] === 'N' && c[6] === 'N' && /^[A-Z]{1,5}$/.test(c[7] || c[0]) && !BAD.test(c[1])) uni.push(c[7] || c[0]); }
uni = uni.filter(s => !(cap[s] && (cap[s] < 3e8 || cap[s] > 1e10)));
if (LIMIT) uni = uni.slice(0, LIMIT);
function scan(B) {
  const n = B.length; if (n < 260) return;
  const info = new Array(n).fill(null);
  for (let i = 55; i < n; i++) {
    const T = B[i]; let avgV = 0, avgDV = 0; for (let k = i - 20; k < i; k++) { avgV += B[k].v; avgDV += B[k].v * B[k].c; } avgV /= 20; avgDV /= 20;
    if (!avgV || T.c < 3) continue;
    const v5 = (B[i].v + B[i - 1].v + B[i - 2].v + B[i - 3].v + B[i - 4].v) / 5, volR = T.v / avgV;
    const chg = (T.c / B[i - 1].c - 1) * 100, wk = (T.c / B[i - 5].c - 1) * 100;
    let s50 = 0; for (let k = i - 49; k <= i; k++) s50 += B[k].c; s50 /= 50;
    let s200 = 0, has200 = i >= 199; if (has200) { for (let k = i - 199; k <= i; k++) s200 += B[k].c; s200 /= 200; }
    const hi = {}; for (const lb of [20, 55]) { let m = 0; for (let k = i - lb; k < i; k++) m = Math.max(m, B[k].h); hi[lb] = m; }
    info[i] = { avgDV, volR, vok: v5 / avgV >= 1.2 && chg <= 25 && wk <= 60, trend: has200 && T.c > s50 && s50 > s200, hi, day: dk(T.t) };
  }
  for (let vi = 0; vi < V.length; vi++) {
    const v = V[vi]; let lastJ = -99;
    for (let i = 56; i < n - 32; i++) {
      const f = info[i]; if (!f || f.avgDV < v.minDollarVol) continue;
      if (v.reg && reg[f.day] !== true) continue;
      if (v.trend && !f.trend) continue;
      let sig = false;
      if (v.entry === 'breakout') sig = B[i].c > f.hi[v.lb] && f.volR >= v.vr && f.vok;
      else {
        // pullback: a confirmed breakout within the last 10 days, price came back near the level and closed up
        for (let j = i - 10; j < i; j++) { const g = info[j]; if (!g || j <= lastJ) continue; if (B[j].c > g.hi[v.lb] && g.volR >= v.vr && g.vok) { const lvl = g.hi[v.lb]; if (B[i].c >= lvl * 0.97 && B[i].l <= lvl * 1.03 && B[i].c > B[i].o && B[i].c < B[j].c * 1.0001) { sig = true; lastJ = j; } break; } }
      }
      if (!sig) continue;
      if (i + v.hold + 1 >= n) continue;
      const sl = slip(f.avgDV), e = B[i + 1].o * (1 + sl / 100), stop = e * (1 - v.stop / 100), tg = e * (1 + v.tgt / 100);
      let ex = B[i + v.hold].c;
      for (let k = i + 1; k <= i + v.hold; k++) { if (B[k].l <= stop) { ex = Math.min(stop, B[k].o); break; } if (B[k].h >= tg) { ex = Math.max(tg, B[k].o); break; } }
      ex *= (1 - sl / 100);
      rec[vi].push([B[i].t, (ex / e - 1) * 100 - COST]);
    }
  }
}
let idx = 0, ok = 0, fail = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (idx < uni.length) { const s = uni[idx++]; const d = await get(url(s)); if (d === undefined) { fail++; continue; } const B = bars(d); if (B) { ok++; scan(B); } await sleep(30); } }));
const allT = rec.flatMap(r => r.map(x => x[0])).sort((x, y) => x - y);
const split = allT[Math.floor(allT.length * 0.6)];
const st = arr => { const n = arr.length; if (!n) return { n: 0 }; const m = arr.reduce((s, x) => s + x[1], 0) / n; const w = arr.filter(x => x[1] > 0).length; return { n, expectancyNetPct: +m.toFixed(2), winRatePct: +(w / n * 100).toFixed(1) }; };
const rows = V.map((v, i) => ({ v, train: st(rec[i].filter(x => x[0] < split)), test: st(rec[i].filter(x => x[0] >= split)) }));
const eligible = rows.filter(r => r.train.n >= 100).sort((a, b) => b.train.expectancyNetPct - a.train.expectancyNetPct);
const locked = eligible.slice(0, 3);
const trainPositive = eligible.filter(r => r.train.expectancyNetPct > 0).length;
const out = { generatedAt: new Date().toISOString(), trials: V.length, symbolsScanned: ok, failed: fail, trainPeriodEnds: dk(split), testPeriodFrom: dk(split),
  note: 'All variants were scored on the TRAIN period only. The 3 best by train expectancy were locked, then evaluated once on the later held-out TEST period. Entry types tried: breakout and pullback-to-breakout-level; filters: market regime (SPY above 50-day), stock trend (above 50-day and 50-day above 200-day), liquidity floor $5M or $20M, volume 1.5x or 2x, 4 stop/target/time-exit sets. NOT tried: sector strength (no free sector-return data wired in), news catalysts, float. Same costs as the main screener (next-day open, slippage 0.1-0.6%/side, 0.4% fees). Survivorship bias and correlated signals still apply. With 256 trials, a good-looking train result can be luck.',
  trainPositiveVariants: trainPositive, eligibleVariants: eligible.length,
  locked: locked.map(r => ({ variant: r.v, train: r.train, test: r.test })), anyPositiveOutOfSample: locked.some(r => r.test.n >= 30 && r.test.expectancyNetPct > 0),
  medianTrainExpectancyAllVariants: +eligible.map(r => r.train.expectancyNetPct).sort((a, b) => a - b)[Math.floor(eligible.length / 2)]?.toFixed(2),
  medianTestExpectancyAllVariants: +rows.filter(r => r.test.n >= 30).map(r => r.test.expectancyNetPct).sort((a, b) => a - b)[Math.floor(rows.filter(r => r.test.n >= 30).length / 2)]?.toFixed(2) };
fs.writeFileSync('research.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
