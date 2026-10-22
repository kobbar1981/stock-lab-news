// Event-driven (post-earnings) rule study. Same discipline as research.mjs:
// variants searched ONLY on train period; best few locked; evaluated once on held-out test.
// Event = earnings report date D from Nasdaq calendar. Reaction window = first two trading days >= D
// (covers BMO and AMC since the calendar gives no time-of-day for historical rows).
// Entry at open of the day AFTER the reaction window, with slippage; honest costs (0.4% round-trip).
import fs from 'node:fs';
const num = x => parseFloat(String(x).replace(/[$,]/g, ''));
const cal = JSON.parse(fs.readFileSync('calendar.json', 'utf8'));
const bars = JSON.parse(fs.readFileSync('bars.json', 'utf8'));
const COST = 0.4; // round-trip fees, pct
const slip = adv => adv < 1e7 ? 0.6 : adv < 2.5e7 ? 0.35 : adv < 1e8 ? 0.2 : 0.1;
const dk = t => new Date(t * 1000).toISOString().slice(0, 10);
// events
const evs = [];
let dropped = { noSurprise: 0, cap: 0, noBars: 0, thinBars: 0, noWindow: 0 };
const seen = new Set();
for (const [d, rows] of Object.entries(cal)) {
  for (const r of rows || []) {
    const key = r.s + '|' + d; if (seen.has(key)) continue; seen.add(key);
    const cap = num(r.cap); if (!(cap >= 3e8 && cap <= 1e10)) { dropped.cap++; continue; }
    const surp = parseFloat(r.surp); if (!isFinite(surp)) { dropped.noSurprise++; continue; }
    evs.push({ s: r.s, d, surp });
  }
}
console.log('events total (cap-filtered, with surprise):', evs.length, 'dropped:', dropped);
// variant grid
const V = [];
for (const sMin of [0, 5, 10]) for (const mMin of [2, 5]) for (const vMin of [1.5, 2.5]) for (const reg of [false, true]) for (const ex of [[8, 12, 10], [10, 20, 20], [12, 30, 30]])
  V.push({ sMin, mMin, vMin, reg, stop: ex[0], tgt: ex[1], hold: ex[2] });
console.log('variants (trials):', V.length);
const rec = V.map(() => []);
let usable = 0, noBars = 0, noIdx = 0, noRoom = 0;
// SPY regime map (fetched live, one call)
let regMap = {};
{
  const UA2 = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' };
  const f2 = new Date(Date.now() - 800 * 864e5).toISOString().slice(0, 10), t2 = new Date().toISOString().slice(0, 10);
  const r2 = await fetch(`https://api.nasdaq.com/api/quote/SPY/historical?assetclass=etf&fromdate=${f2}&limit=1000&todate=${t2}`, { headers: UA2, signal: AbortSignal.timeout(25000) });
  const j2 = await r2.json();
  const rows2 = j2?.data?.tradesTable?.rows || [];
  const SP = rows2.map(r => { const [m, dd, y] = r.date.split('/'); return [Date.UTC(+y, +m - 1, +dd) / 1000, num(r.close)]; }).filter(b => isFinite(b[1])).sort((a, b) => a[0] - b[0]);
  for (let i = 50; i < SP.length; i++) { let a = 0; for (let k = i - 49; k <= i; k++) a += SP[k][1]; regMap[dk(SP[i][0])] = SP[i][1] > a / 50; }
  console.log('SPY bars:', SP.length);
}
for (const e of evs) {
  const B = bars[e.s];
  if (!B) { noBars++; continue; }
  if (B.length < 60) { noBars++; continue; }
  const tD = Date.parse(e.d + 'T00:00:00Z') / 1000;
  let i0 = B.findIndex(b => b[0] >= tD); // first trading day >= D
  if (i0 < 21) { noIdx++; continue; }
  const i1 = i0 + 1, iE = i0 + 2;
  if (i1 >= B.length || iE >= B.length) { noRoom++; continue; }
  const prevC = B[i0 - 1][4];
  let avgV = 0, avgDV = 0; for (let k = i0 - 20; k < i0; k++) { avgV += B[k][5]; avgDV += B[k][5] * B[k][4]; } avgV /= 20; avgDV /= 20;
  if (!avgV || prevC < 3 || avgDV < 5e6) { noIdx++; continue; }
  const gap = (B[i0][1] / prevC - 1) * 100;
  const move = (B[i1][4] / prevC - 1) * 100; // 2-day reaction
  const volR = Math.max(B[i0][5], B[i1][5]) / avgV;
  const held = B[i1][4] > B[i0][1]; // reaction window closed above window open (no full fade)
  usable++;
  for (let vi = 0; vi < V.length; vi++) {
    const v = V[vi];
    if (e.surp < v.sMin) continue;
    if (move < v.mMin) continue;
    if (volR < v.vMin) continue;
    if (v.reg && regMap[dk(B[i0][0])] !== true) continue;
    if (iE + v.hold >= B.length) { continue; }
    const sl = slip(avgDV), entry = B[iE][1] * (1 + sl / 100);
    const stop = entry * (1 - v.stop / 100), tg = entry * (1 + v.tgt / 100);
    let ex = B[iE + v.hold][4];
    for (let k = iE; k <= iE + v.hold; k++) { if (B[k][3] <= stop) { ex = Math.min(stop, B[k][1]); break; } if (B[k][2] >= tg) { ex = Math.max(tg, B[k][1]); break; } }
    ex *= (1 - sl / 100);
    rec[vi].push([B[i0][0], (ex / entry - 1) * 100 - COST]);
  }
}
console.log({ usable, noBars, noIdx, noRoom });
// Baseline, rule-free: forward returns after ALL usable events, by surprise sign (gross of costs)
const base = { pos: [], neg: [] };
for (const e of evs) {
  const B = bars[e.s]; if (!B || B.length < 60) continue;
  const tD = Date.parse(e.d + 'T00:00:00Z') / 1000;
  const i0 = B.findIndex(b => b[0] >= tD); if (i0 < 21) continue;
  const iE = i0 + 2; if (iE + 10 >= B.length) continue;
  const prevC = B[i0 - 1][4];
  let avgDV = 0; for (let k = i0 - 20; k < i0; k++) avgDV += B[k][5] * B[k][4]; avgDV /= 20;
  if (prevC < 3 || avgDV < 5e6) continue;
  const r10 = (B[iE + 10][4] / B[iE][1] - 1) * 100; // open of day after window -> close 10 trading days later
  (e.surp >= 0 ? base.pos : base.neg).push(r10);
}
const bm = a => a.length ? { n: a.length, meanFwd10dPct: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2), medianPct: +a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) } : { n: 0 };
console.log('baseline positive-surprise:', bm(base.pos), 'negative-surprise:', bm(base.neg));
const allT = rec.flatMap(r => r.map(x => x[0])).sort((a, b) => a - b);
const split = allT.length ? allT[Math.floor(allT.length * 0.6)] : Date.now() / 1000;
const st = arr => { const n = arr.length; if (!n) return { n: 0 }; const m = arr.reduce((s, x) => s + x[1], 0) / n; const w = arr.filter(x => x[1] > 0).length; return { n, expectancyNetPct: +m.toFixed(2), winRatePct: +(w / n * 100).toFixed(1) }; };
const rows = V.map((v, i) => ({ v, train: st(rec[i].filter(x => x[0] < split)), test: st(rec[i].filter(x => x[0] >= split)) }));
const eligible = rows.filter(r => r.train.n >= 100).sort((a, b) => b.train.expectancyNetPct - a.train.expectancyNetPct);
const locked = eligible.slice(0, 3);
const out = { generatedAt: new Date().toISOString(), trials: V.length, eventsTotal: evs.length, eventsUsable: usable, droppedNoBars: noBars, trainPeriodEnds: dk(split), testPeriodFrom: dk(split),
  note: 'Post-earnings drift study. Event = earnings report date from Nasdaq calendar (includes actual EPS, consensus, surprise% for past dates). Calendar gives no BMO/AMC time for past dates, so the reaction window is the first TWO trading days >= report date (covers both). Signal needs surprise% >= sMin AND 2-day reaction move >= mMin% AND window volume >= vMin x 20-day avg. Entry at open of the day after the window (no lookahead), exits stop/target/time, slippage 0.1-0.6%/side by liquidity, 0.4% fees. Universe: market cap $300M-$10B as reported by the calendar endpoint. Variants searched on TRAIN only; 3 best locked; evaluated once on TEST. CAVEATS: (1) survivorship - bars could not be fetched for some past reporters (likely delisted); dropping them overstates returns, count reported. (2) marketCap is as reported by the endpoint, may reflect a later snapshot. (3) 72 correlated trials - a good train result can be luck. (4) surprise coverage ~73% of calendar rows.',
  trainPositiveVariants: eligible.filter(r => r.train.expectancyNetPct > 0).length, eligibleVariants: eligible.length,
  locked: locked.map(r => ({ variant: r.v, train: r.train, test: r.test })),
  anyPositiveOutOfSample: locked.some(r => r.test.n >= 30 && r.test.expectancyNetPct > 0),
  medianTrainExpectancyAllVariants: +(eligible.map(r => r.train.expectancyNetPct).sort((a, b) => a - b)[Math.floor(eligible.length / 2)] ?? NaN).toFixed(2),
  medianTestExpectancyAllVariants: +(rows.filter(r => r.test.n >= 30).map(r => r.test.expectancyNetPct).sort((a, b) => a - b)[Math.floor(rows.filter(r => r.test.n >= 30).length / 2)] ?? NaN).toFixed(2) };
fs.writeFileSync('research_events.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
