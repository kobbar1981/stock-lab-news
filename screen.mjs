// Daily breakout screen. Free sources only: Nasdaq Trader symbol directory + api.nasdaq.com (daily bars, screener with market cap).
import fs from 'node:fs';
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept': 'application/json, text/plain, */*' };
const LIMIT = +process.env.LIMIT || 0;
const CONC = +process.env.CONC || 10;
const CFG = { minPrice: 3, minAvgDollarVol: 5e6, minCap: 3e8, maxCap: 1e10, breakoutDays: 20,
  volToday: 1.5, volSustain: 1.2, maxDayGain: 25, maxWeekGain: 60 };
const COST_PCT = +process.env.COST_PCT || 0.4; // round-trip commission + slippage assumption, percent of position
const sleep = ms => new Promise(r => setTimeout(r, ms));
const netStats = { rate: 0, http: {} };
async function get(url, opt = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(25000) });
      netStats.http[r.status] = (netStats.http[r.status] || 0) + 1;
      if (r.status === 429) { await sleep(2000 * (i + 1)); netStats.rate++; continue; }
      if (!r.ok) { if (r.status === 404) return null; await sleep(500); continue; }
      return opt.text ? await r.text() : await r.json();
    } catch { await sleep(700); }
  }
  return undefined;
}
const BAD = /warrant|rights?\b|units?\b|preferred|depositary shares|notes due|acquisition corp|trust\b|fund\b|etf|etn|index|% /i;
async function universe() {
  const out = [];
  const a = await get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', { text: true });
  const b = await get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt', { text: true });
  if (!a || !b) throw new Error('symbol directory unavailable');
  for (const l of a.split('\n').slice(1)) {
    const c = l.trim().split('|'); if (c.length < 8 || c[0].startsWith('File')) continue;
    if (c[3] !== 'N' || c[6] !== 'N' || c[7] !== 'N' || c[4] !== 'N') continue;
    out.push({ symbol: c[0], name: c[1], exchange: 'NASDAQ' });
  }
  for (const l of b.split('\n').slice(1)) {
    const c = l.trim().split('|'); if (c.length < 8 || c[0].startsWith('File')) continue;
    // ACT symbol|Name|Exchange|CQS|ETF|Lot|Test|NASDAQ symbol ; keep NYSE (N) and NYSE American (A); no ARCA/BATS (mostly ETFs)
    if (!['N', 'A'].includes(c[2]) || c[4] !== 'N' || c[6] !== 'N') continue;
    out.push({ symbol: c[7] || c[0], name: c[1], exchange: c[2] === 'N' ? 'NYSE' : 'NYSE American' });
  }
  return out.filter(s => /^[A-Z]{1,5}$/.test(s.symbol) && !BAD.test(s.name));
}
const FWD = 10, TARGET = 1.08, STOP = 0.95;
const THRESH = { minN: 30, minExpectancyNetPct: 0.5, minPeriodN: 12, maxDrawdownR: 25 };
const num = x => parseFloat(String(x).replace(/[$,]/g, ''));
function bars2(d) {
  const rows = d?.data?.tradesTable?.rows; if (!rows) return null;
  const bars = [];
  for (const r of rows) {
    const [m, dd, y] = r.date.split('/'); const t = Date.UTC(+y, +m - 1, +dd) / 1000;
    const o = num(r.open), c = num(r.close), h = num(r.high), l = num(r.low), v = num(r.volume);
    if ([o, c, h, l, v].some(x => !isFinite(x))) continue;
    bars.push({ t, o, c, h, l, v });
  }
  return bars.sort((a, b) => a.t - b.t);
}
function sma(bars, i, n) { let a = 0; for (let k = i - n + 1; k <= i; k++) a += bars[k].c; return a / n; }
// Evaluate bar i. Returns {skip} or {sig}.
function evalBar(bars, i, regimeOk) {
  const T = bars[i], prev = bars.slice(i - CFG.breakoutDays, i);
  const priorHigh = Math.max(...prev.map(b => b.h));
  if (!(T.c > priorHigh)) return { skip: 'nobreak' };
  const avgV = prev.reduce((a, b) => a + b.v, 0) / prev.length;
  if (!avgV) return { skip: 'volume' };
  const v5 = (bars[i].v + bars[i-1].v + bars[i-2].v + bars[i-3].v + bars[i-4].v) / 5;
  const avgDV = prev.reduce((a, b) => a + b.v * b.c, 0) / prev.length;
  const chg = (T.c / bars[i-1].c - 1) * 100, wk = (T.c / bars[i-5].c - 1) * 100;
  const rng = T.h - T.l, closePos = rng > 0 ? (T.c - T.l) / rng : 0.5;
  const gap = (T.o / bars[i-1].c - 1) * 100;
  const sm50 = sma(bars, i, 50), above = (T.c / sm50 - 1) * 100;
  if (T.c < CFG.minPrice) return { skip: 'penny' };
  if (avgDV < CFG.minAvgDollarVol) return { skip: 'illiquid' };
  const volRatio = T.v / avgV, vol5Ratio = v5 / avgV;
  if (volRatio < CFG.volToday || vol5Ratio < CFG.volSustain) return { skip: 'volume' };
  if (chg > CFG.maxDayGain || wk > CFG.maxWeekGain) return { skip: 'spike' };
  const traps = [];
  if (gap >= 5 && T.c < T.o) traps.push('gap-and-fade');
  if (closePos < 0.4) traps.push('weak close (near the day low)');
  if (volRatio > 4 && vol5Ratio < 1.5) traps.push('single-bar volume spike');
  if (above > 35) traps.push('extended above 50-day average');
  if (wk > 40) traps.push('parabolic week');
  const strong = volRatio >= 2 && above > 0 && !traps.length && regimeOk === true;
  return { sig: { close: T.c, priorHigh, chgPct: chg, weekPct: wk, breakoutPct: (T.c / priorHigh - 1) * 100, volRatio, vol5Ratio, avgDollarVol: avgDV, aboveSma50Pct: above, closePos, gapPct: gap, traps, strong, t: T.t } };
}
const slipPct = adv => adv < 1e7 ? 0.6 : adv < 2.5e7 ? 0.35 : adv < 1e8 ? 0.2 : 0.1; // assumed per-side spread + impact, wider for thinner names
const TAX = 25; // Israeli capital gains tax assumption (percent of gains, no loss offset modeled)
function outcome(bars, i, priorHigh, adv) {
  if (i + FWD + 1 >= bars.length) return null;
  // no look-ahead: the signal is known only after the close of bar i, so entry is the NEXT bar's open
  const sl = slipPct(adv);
  const e = bars[i + 1].o * (1 + sl / 100), stop = e * STOP, tgt = e * TARGET;
  let exit = bars[i + FWD].c, res = 'timeout', xk = i + FWD;
  for (let k = i + 1; k <= i + FWD; k++) {
    if (bars[k].l <= stop) { exit = Math.min(stop, bars[k].o); res = 'stop'; xk = k; break; } // gap through the stop fills at the open; same-day touch of both = stop
    if (bars[k].h >= tgt) { exit = Math.max(tgt, bars[k].o); res = 'hit'; xk = k; break; }
  }
  exit *= (1 - sl / 100);
  let falseBO = false;
  for (let k = i + 1; k <= Math.min(i + 3, bars.length - 1); k++) if (bars[k].c < priorHigh) { falseBO = true; break; }
  const gross = (exit / e - 1) * 100, net = gross - COST_PCT;
  return { entryT: bars[i + 1].t, exitT: bars[xk].t, entry: e, exitPx: exit, res, gross, net, netTax: net > 0 ? net * (1 - TAX / 100) : net, r: net / ((1 - STOP) * 100), t: bars[i].t, falseBO };
}

function simPortfolio(arr, startUSD, rate) {
  const list = [];
  // retrospective portfolio: every signal of this type, 1% risk per trade, max 25% of equity per position, cash-limited, costs included
  const trades = [...arr].sort((a, b) => a.entryT - b.entryT);
  let cash = startUSD; const open = []; const closed = []; const curve = []; let skipped = 0;
  const settle = t => { for (let k = open.length - 1; k >= 0; k--) if (open[k].exitT <= t) { const p = open.splice(k, 1)[0]; const fee = p.sh * p.exitPx * COST_PCT / 200; cash += p.sh * p.exitPx - fee; const cost = p.sh * p.entry + p.feeIn; const pnl = p.sh * p.exitPx - fee - cost; closed.push({ t: p.exitT, pnl, cost }); list.push({ symbol: p.sym, entryDate: new Date(p.entryT * 1000).toISOString().slice(0, 10), entryPrice: +p.entry.toFixed(2), exitDate: new Date(p.exitT * 1000).toISOString().slice(0, 10), exitPrice: +p.exitPx.toFixed(2), exitReason: p.res, shares: p.sh, pnlUSD: +pnl.toFixed(2), pnlILS: +(pnl * (rate || 3.3)).toFixed(2), pnlPct: +(pnl / cost * 100).toFixed(2) }); } };
  const eqNow = () => cash + open.reduce((a, p) => a + p.sh * p.entry, 0);
  for (const x of trades) {
    settle(x.entryT);
    const eq = eqNow(); const sh = Math.floor(Math.min(eq * 0.01 / (x.entry * 0.05), eq * 0.25 / x.entry, cash / (x.entry * (1 + COST_PCT / 200))));
    if (sh < 1) { skipped++; continue; }
    const feeIn = sh * x.entry * COST_PCT / 200; cash -= sh * x.entry + feeIn;
    open.push({ sh, entry: x.entry, exitPx: x.exitPx, exitT: x.exitT, feeIn, sym: x.sym, entryT: x.entryT, res: x.res });
    curve.push({ t: x.entryT, eq: eqNow() });
  }
  settle(Infinity);
  closed.sort((a, b) => a.t - b.t);
  let eq = startUSD, peak = eq, dd = 0; const pts = [];
  for (const c of closed) { eq += c.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak * 100); pts.push({ date: new Date(c.t * 1000).toISOString().slice(0, 10), eq: +eq.toFixed(2) }); }
  const w = closed.filter(c => c.pnl > 0).length;
  list.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
  return { tradeList: list, trades: closed.length, skippedNoCash: skipped, winRatePct: closed.length ? +(w / closed.length * 100).toFixed(1) : null, expectancyPct: closed.length ? +(closed.reduce((a, c) => a + c.pnl / c.cost * 100, 0) / closed.length).toFixed(2) : null,
    endUSD: +eq.toFixed(2), returnPct: +((eq / startUSD - 1) * 100).toFixed(2), maxDrawdownPct: +dd.toFixed(1), curve: pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 60)) === 0 || i === pts.length - 1) };
}
const regimeByDate = {};
const hist = { base: [], strong: [] };
function analyze(s, d) {
  const bars = bars2(d); if (!bars) return null;
  if (bars.length < 80) return { skip: 'short' };
  const n = bars.length; let today = null; const skips = {};
  for (let i = 55; i < n; i++) {
    const day = new Date(bars[i].t * 1000).toISOString().slice(0, 10);
    const e = evalBar(bars, i, regimeByDate[day]);
    if (!e.sig) { if (i === n - 1) today = { skip: e.skip }; continue; }
    if (i === n - 1) { today = { sig: e.sig, bars }; continue; }
    const o = outcome(bars, i, e.sig.priorHigh, e.sig.avgDollarVol);
    if (!o) continue;
    o.sym = s.symbol;
    hist.base.push(o); if (e.sig.strong) hist.strong.push(o);
  }
  if (!today) return { skip: 'short' };
  if (today.skip) return today;
  const g = today.sig, T = bars[n - 1];
  const o = { symbol: s.symbol, name: s.name, exchange: s.exchange, close: +g.close.toFixed(2), chgPct: +g.chgPct.toFixed(1), weekPct: +g.weekPct.toFixed(1),
    breakoutPct: +g.breakoutPct.toFixed(1), volRatio: +g.volRatio.toFixed(1), vol5Ratio: +g.vol5Ratio.toFixed(1), avgDollarVol: Math.round(g.avgDollarVol),
    aboveSma50Pct: +g.aboveSma50Pct.toFixed(1), barDate: new Date(T.t * 1000).toISOString().slice(0, 10), traps: g.traps, strong: g.strong, flags: [] };
  return { cand: o };
}
function stats(arr) {
  const n = arr.length;
  if (!n) return { n: 0 };
  const hits = arr.filter(x => x.res === 'hit').length, stops = arr.filter(x => x.res === 'stop').length;
  const wins = arr.filter(x => x.net > 0), loss = arr.filter(x => x.net <= 0);
  const mean = a => a.length ? a.reduce((s, x) => s + x.net, 0) / a.length : 0;
  const p = hits / n, z = 1.96;
  const wil = (p + z*z/(2*n) - z * Math.sqrt((p*(1-p) + z*z/(4*n)) / n)) / (1 + z*z/n);
  const byT = [...arr].sort((a, b) => a.t - b.t);
  // equity curve in R (1R = the 5% stop distance), signals in date order, one unit of risk each (ignores overlap and correlation)
  let eq = 0, peak = 0, dd = 0; for (const x of byT) { eq += x.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const cut = Math.floor(n * 0.6), early = byT.slice(0, cut), late = byT.slice(cut);
  const avgW = mean(wins), avgL = mean(loss);
  const sorted = arr.map(x => x.net).sort((a, b) => a - b);
  return { n, hitRate: +p.toFixed(3), wilsonLow95: +wil.toFixed(3), stopRate: +(stops / n).toFixed(3),
    expectancyNetPct: +mean(arr).toFixed(2), expectancyAfterTaxPct: +(arr.reduce((a, x) => a + x.netTax, 0) / n).toFixed(2), avgWinPct: +avgW.toFixed(2), avgLossPct: +avgL.toFixed(2),
    winLossRatio: avgL ? +(avgW / Math.abs(avgL)).toFixed(2) : null, medianNetPct: +sorted[Math.floor(n / 2)].toFixed(2),
    maxDrawdownR: +dd.toFixed(1), totalR: +eq.toFixed(1), falseBreakoutRate: +(arr.filter(x => x.falseBO).length / n).toFixed(3),
    firstPeriod: { n: early.length, expectancyNetPct: +mean(early).toFixed(2), to: new Date(early[early.length - 1].t * 1000).toISOString().slice(0, 10) },
    secondPeriod: { n: late.length, expectancyNetPct: +mean(late).toFixed(2), from: late.length ? new Date(late[0].t * 1000).toISOString().slice(0, 10) : null } };
}

const t0 = Date.now();
const fromDate = new Date(Date.now() - 740 * 864e5).toISOString().slice(0, 10), toDate = new Date().toISOString().slice(0, 10);
const histUrl = (sym, cls = 'stocks') => `https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=${cls}&fromdate=${fromDate}&limit=1000&todate=${toDate}`;
// market regime: SPY above its 50-day average
let regimeNow = null;
const spy = bars2(await get(histUrl('SPY', 'etf')));
if (spy && spy.length > 60) {
  for (let i = 50; i < spy.length; i++) regimeByDate[new Date(spy[i].t * 1000).toISOString().slice(0, 10)] = spy[i].c > sma(spy, i, 50);
  regimeNow = regimeByDate[new Date(spy[spy.length - 1].t * 1000).toISOString().slice(0, 10)];
}
// market cap / sector / IPO year from the Nasdaq screener (one call)
const capMap = {};
const scr = await get('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true');
for (const r of scr?.data?.rows || scr?.data?.table?.rows || []) { const c = num(r.marketCap); capMap[r.symbol] = { cap: isFinite(c) && c > 0 ? c : null, sector: r.sector || null, ipoyear: r.ipoyear || null, country: r.country || null }; }
let uni = await universe();
const universeSize = uni.length;
if (LIMIT) uni = uni.slice(0, LIMIT);
// cheap pre-filter on the screener: skip symbols whose known market cap is outside the range (saves ~half the requests)
let preSkipped = 0;
uni = uni.filter(s => { const m = capMap[s.symbol]; if (m?.cap && (m.cap < CFG.minCap || m.cap > CFG.maxCap)) { preSkipped++; return false; } return true; });
const skips = {}, cands = []; let failed = 0, scanned = 0, i = 0;
async function worker() {
  while (i < uni.length) {
    const s = uni[i++];
    const d = await get(histUrl(s.symbol));
    if (d === undefined) { failed++; continue; }
    scanned++;
    const a = analyze(s, d);
    if (!a) { skips.nodata = (skips.nodata || 0) + 1; continue; }
    if (a.skip) { skips[a.skip] = (skips[a.skip] || 0) + 1; continue; }
    cands.push(a.cand);
    await sleep(30);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
const st = { base: stats(hist.base), strong: stats(hist.strong) };
const fx = (await get('https://open.er-api.com/v6/latest/USD'))?.rates?.ILS || null;
const START_USD = fx ? 10000 / fx : 3000;
const cutoff = Math.floor(Date.now() / 1000) - 365 * 86400;
const spy12 = spy ? spy.filter(b => b.t >= cutoff) : [];
const bh = spy12.length > 1 ? +((spy12[spy12.length - 1].c / spy12[0].o - 1) * 100).toFixed(2) : null;
const bt = { label: 'RETROSPECTIVE backtest portfolio (what would have happened on past data; not forward results)', startILS: 10000, usdIls: fx, fxNote: fx ? 'open.er-api.com, today rate applied to the whole period' : 'rate unavailable, assumed 3.3', period: spy ? `${new Date(spy[50].t * 1000).toISOString().slice(0, 10)} to ${new Date(spy[spy.length - 1].t * 1000).toISOString().slice(0, 10)}` : null,
  window12m: spy12.length ? `${new Date(spy12[0].t * 1000).toISOString().slice(0, 10)} to ${new Date(spy12[spy12.length - 1].t * 1000).toISOString().slice(0, 10)}` : null, spyBuyHold12mPct: bh, spyBuyHold12mILS: bh == null ? null : Math.round(10000 * (1 + bh / 100)),
  strong: simPortfolio(hist.strong, START_USD, fx), base: simPortfolio(hist.base, START_USD, fx),
  strong12m: simPortfolio(hist.strong.filter(x => x.entryT >= cutoff), START_USD, fx), base12m: simPortfolio(hist.base.filter(x => x.entryT >= cutoff), START_USD, fx) };
for (const k of ['strong', 'base', 'strong12m', 'base12m']) { bt[k].afterTaxEndILS = 0; bt[k].endILS = +(bt[k].endUSD * (fx || 3.3)).toFixed(0); bt[k].pnlILS = bt[k].endILS - 10000; bt[k].afterTaxEndILS = Math.round(10000 + (bt[k].pnlILS > 0 ? bt[k].pnlILS * 0.75 : bt[k].pnlILS)); }
const trades12 = { generatedAt: new Date().toISOString(), window: bt.window12m, note: 'Retrospective simulation, not real trades. Entry next-day open + slippage, exit stop -5% / target +8% / day 10, fees included, 25% tax not deducted in P&L.', strong: bt.strong12m.tradeList, base: bt.base12m.tradeList };
fs.writeFileSync('backtest_trades.json', JSON.stringify(trades12, null, 1));
for (const k of Object.keys(bt)) if (bt[k]?.tradeList) delete bt[k].tradeList;
const gate = k => { const x = st[k]; return !!(x.n >= THRESH.minN && x.expectancyNetPct >= THRESH.minExpectancyNetPct && x.firstPeriod.n >= THRESH.minPeriodN && x.secondPeriod.n >= THRESH.minPeriodN && x.firstPeriod.expectancyNetPct > 0 && x.secondPeriod.expectancyNetPct > 0 && x.maxDrawdownR <= THRESH.maxDrawdownR); };
const final = [];
for (const c of cands) {
  const m = capMap[c.symbol];
  if (m?.cap) { c.marketCap = m.cap; c.verified = true; } else { c.verified = false; c.flags.push('market cap unverified'); }
  if (m?.sector) c.sector = m.sector;
  if (m?.ipoyear && +m.ipoyear >= new Date().getFullYear() - 1) c.flags.push('recent IPO (' + m.ipoyear + ')');
  c.catalyst = 'unknown (not checked)';
  c.stopRef = +(c.close * STOP).toFixed(2); c.stop = c.stopRef; c.riskPerSharePct = +((1 - STOP) * 100).toFixed(1); c.target = +(c.close * TARGET).toFixed(2);
  c.signalType = c.strong ? 'strong' : 'base';
  c.alert = !!(c.strong && c.verified && regimeNow === true && gate('strong'));
  final.push(c);
}
final.sort((a, b) => b.volRatio - a.volRatio);
const dates = {}; for (const c of cands) dates[c.barDate] = (dates[c.barDate] || 0) + 1;
const dataAsOf = Object.entries(dates).sort((a, b) => b[1] - a[1])[0]?.[0] || (spy ? new Date(spy[spy.length - 1].t * 1000).toISOString().slice(0, 10) : null);
const failRate = uni.length ? failed / uni.length : 1;
const alerts = final.filter(c => c.alert);
const meta = { generatedAt: new Date().toISOString(), dataAsOf, source: 'Nasdaq.com market data API (free, delayed daily bars, unofficial) + Nasdaq Trader symbol directory',
  marketRegime: { spyAbove50dma: regimeNow },
  rules: { ...CFG, forwardDays: FWD, costRoundTripPct: COST_PCT, stopPct: (1 - STOP) * 100, targetPct: (TARGET - 1) * 100,
    tradeModel: `signal known after the close; entry at the NEXT day open plus slippage (0.1% to 0.6% per side by liquidity); exit at +${(TARGET - 1) * 100}% target, -${(1 - STOP) * 100}% stop (gap through the stop fills at the open), or close of day ${FWD}; same-day touch of both counts as stop; ${COST_PCT}% round-trip fees/FX assumed; ${TAX}% Israeli capital-gains tax shown separately (no loss offset)`,
    alertGate: THRESH,
    text: 'close > highest high of prior 20 days; today volume >= 1.5x and 5-day avg volume >= 1.2x of prior 20-day avg; price >= $3; 20d avg dollar volume >= $5M; market cap $300M-$10B; excludes >25% one-day or >60% 5-day jumps; ETFs, test, OTC, warrants, units, preferred excluded. "Strong" adds: volume >= 2x, above 50-day average, no trap flags, S&P 500 (SPY) above its 50-day average. An alert needs: strong signal, verified market cap, market regime ok, AND the strong signal type has positive net expectancy in both halves of the last ~2 years with enough samples and bounded drawdown.' },
  universe: universeSize, preFilteredByCap: preSkipped, scanned, failed, rateLimited: netStats.rate, filteredOut: skips, ok: failRate < 0.15 && scanned > 0,
  backtestPortfolio: bt, historicalStats: { ...st, alertGatePassed: { base: gate('base'), strong: gate('strong') }, assumptions: { entry: 'next-day open', slippagePerSidePct: 'by 20d avg dollar volume: <$10M 0.6, <$25M 0.35, <$100M 0.2, else 0.1', feesRoundTripPct: COST_PCT, taxPct: TAX, notModeled: ['delisted/failed stocks (free data lists only current symbols)', 'halts and gaps beyond the open', 'real bid/ask spread and partial fills', 'intraday path (same-day target and stop touch is counted as a stop)', 'tax loss offsets and currency conversion (ILS/USD)', 'float and catalyst/news'] }, note: 'Measured on the last ~2 years of symbols listed TODAY (survivorship bias: delisted losers are missing, so real results are likely worse). The same data was used to shape the rules (in-sample). Signals cluster on the same market days, so they are not independent. Real slippage on small names can exceed these assumptions; halts, bid/ask spreads and partial fills are not modeled; the free data is end-of-day and delayed; no intraday data. Past results are not a guarantee.' },
  disclaimer: 'Filters reduce but cannot eliminate pump, manipulation or trap risk. Catalyst/news and float are not checked here. Signals, not investment advice.' };
fs.writeFileSync(process.env.OUT || 'candidates.json', JSON.stringify({ ...meta, count: final.length, candidates: final }, null, 1));
fs.writeFileSync(process.env.OUT2 || 'alerts.json', JSON.stringify({ ...meta, count: alerts.length, alerts }, null, 1));
console.log(JSON.stringify({ universe: universeSize, preSkipped, scanned, failed, http: netStats.http, cands: cands.length, final: final.length, alerts: alerts.length, dataAsOf, regimeNow, secs: Math.round((Date.now() - t0) / 1000), skips, st }));
