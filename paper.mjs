// Server-side paper portfolio. Only alerts that passed the gate trade. Virtual money only.
import fs from 'node:fs';
const FILE = 'paper_portfolio.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json, text/plain, */*' };
const RISK = 0.01, STOP = 0.95, TARGET = 1.08, HOLD = 10, FEE_RT_PCT = 0.4, TAX = 25, MAX_POS = 0.25;
const slipPct = adv => adv < 1e7 ? 0.6 : adv < 2.5e7 ? 0.35 : adv < 1e8 ? 0.2 : 0.1;
const num = x => parseFloat(String(x).replace(/[$,]/g, ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url) { for (let i = 0; i < 3; i++) { try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) }); if (r.ok) return await r.json(); } catch {} await sleep(1500); } return null; }
async function bars(sym) {
  const from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
  const d = await getJson(`https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=stocks&fromdate=${from}&limit=200&todate=${to}`);
  const rows = d?.data?.tradesTable?.rows; if (!rows) return null;
  return rows.map(r => { const [m, dd, y] = r.date.split('/'); return { date: `${y}-${m}-${dd}`, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close) }; }).filter(b => [b.o, b.h, b.l, b.c].every(isFinite)).sort((a, b) => a.date < b.date ? -1 : 1);
}
let P = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
const alertsDoc = fs.existsSync('alerts.json') ? JSON.parse(fs.readFileSync('alerts.json', 'utf8')) : { alerts: [], ok: false };
const dataAsOf = alertsDoc.dataAsOf || new Date().toISOString().slice(0, 10);
if (!P) {
  const fx = await getJson('https://open.er-api.com/v6/latest/USD');
  const rate = fx?.rates?.ILS;
  P = { startedAt: new Date().toISOString(), startCapitalILS: 10000, usdIls: rate || null, usdIlsSource: rate ? 'open.er-api.com at inception, fixed for the whole test' : 'unavailable at inception', startCapitalUSD: rate ? +(10000 / rate).toFixed(2) : null,
    cashUSD: rate ? 10000 / rate : 0, pending: [], open: [], closed: [], equity: [], log: [] };
}
const notes = [];
if (!P.usdIls) { P.note = 'No USD/ILS rate was available at start, so the portfolio is not running.'; }
else {
  const cache = {}; const B = async s => cache[s] ?? (cache[s] = await bars(s));
  // 1) enter pending alerts at the next open after the signal date
  const stillPending = [];
  for (const p of P.pending) {
    const b = await B(p.symbol); if (!b) { stillPending.push(p); continue; }
    const nb = b.find(x => x.date > p.signalDate);
    if (!nb) { stillPending.push(p); continue; }
    const sl = slipPct(p.avgDollarVol), entry = nb.o * (1 + sl / 100);
    const eq = P.cashUSD + P.open.reduce((a, t) => a + t.shares * t.entry, 0);
    const riskUSD = eq * RISK, perShareRisk = entry * (1 - STOP);
    let shares = Math.floor(Math.min(riskUSD / perShareRisk, eq * MAX_POS / entry, P.cashUSD / (entry * (1 + FEE_RT_PCT / 200))));
    if (shares < 1) { P.log.push({ date: nb.date, msg: `skipped ${p.symbol}: position would be under 1 share or no cash` }); continue; }
    const fee = shares * entry * FEE_RT_PCT / 200;
    P.cashUSD -= shares * entry + fee;
    P.open.push({ symbol: p.symbol, name: p.name, signalDate: p.signalDate, entryDate: nb.date, entry: +entry.toFixed(4), shares, stop: +(entry * STOP).toFixed(4), target: +(entry * TARGET).toFixed(4), slipPct: sl, feeIn: +fee.toFixed(2), lastChecked: nb.date, bars: 0, riskUSD: +(shares * perShareRisk).toFixed(2) });
    P.log.push({ date: nb.date, msg: `bought ${shares} ${p.symbol} at ~$${entry.toFixed(2)} (stop $${(entry * STOP).toFixed(2)})` });
    // fall through: also check the entry day itself below
    P.open[P.open.length - 1].lastChecked = '0000-00-00';
  }
  P.pending = stillPending;
  // 2) manage open trades bar by bar (day of entry included; same-day touch of both = stop)
  const stayOpen = [];
  for (const t of P.open) {
    const b = await B(t.symbol); if (!b) { stayOpen.push(t); continue; }
    let closed = false;
    for (const x of b.filter(x => x.date >= t.entryDate && x.date > t.lastChecked)) {
      t.bars++; t.lastChecked = x.date; let exit = null, why = null;
      if (x.l <= t.stop) { exit = Math.min(t.stop, x.o); why = 'stop'; }
      else if (x.h >= t.target) { exit = Math.max(t.target, x.o); why = 'target'; }
      else if (t.bars >= HOLD) { exit = x.c; why = 'time stop'; }
      if (exit != null) {
        exit *= (1 - t.slipPct / 100); const fee = t.shares * exit * FEE_RT_PCT / 200;
        const proceeds = t.shares * exit - fee; P.cashUSD += proceeds;
        const pnl = proceeds - (t.shares * t.entry + t.feeIn), cost = t.shares * t.entry + t.feeIn;
        P.closed.push({ ...t, exitDate: x.date, exit: +exit.toFixed(4), why, pnlUSD: +pnl.toFixed(2), pnlPct: +(pnl / cost * 100).toFixed(2), pnlILS: +(pnl * P.usdIls).toFixed(2) });
        P.log.push({ date: x.date, msg: `sold ${t.shares} ${t.symbol} at ~$${exit.toFixed(2)} (${why}), P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` });
        closed = true; break;
      }
    }
    if (!closed) stayOpen.push(t);
  }
  P.open = stayOpen;
  // 3) queue today's gated alerts (entered at the NEXT trading day open, never at the signal close)
  if (alertsDoc.ok !== false) for (const a of alertsDoc.alerts || []) {
    const dup = [...P.pending, ...P.open, ...P.closed].some(t => t.symbol === a.symbol && t.signalDate === a.barDate);
    if (!dup) { P.pending.push({ symbol: a.symbol, name: a.name, signalDate: a.barDate, avgDollarVol: a.avgDollarVol }); P.log.push({ date: dataAsOf, msg: `alert queued: ${a.symbol}, entry at the next open` }); }
  }
  // 4) mark to market
  let mtm = P.cashUSD;
  for (const t of P.open) { const b = await B(t.symbol); const last = b?.[b.length - 1]; t.lastClose = last?.c ?? t.entry; mtm += t.shares * t.lastClose; }
  const last = P.equity[P.equity.length - 1];
  const pt = { date: dataAsOf, equityUSD: +mtm.toFixed(2), equityILS: +(mtm * P.usdIls).toFixed(2) };
  if (last && last.date === pt.date) P.equity[P.equity.length - 1] = pt; else P.equity.push(pt);
  P.log = P.log.slice(-200);
}
// 5) stats + plain-language summary
const cl = P.closed, wins = cl.filter(t => t.pnlUSD > 0), loss = cl.filter(t => t.pnlUSD <= 0);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
let peak = 0, dd = 0; for (const e of P.equity) { peak = Math.max(peak, e.equityUSD); dd = Math.max(dd, peak ? (peak - e.equityUSD) / peak * 100 : 0); }
const curILS = P.equity.length ? P.equity[P.equity.length - 1].equityILS : P.startCapitalILS;
const pnlILS = curILS - P.startCapitalILS;
P.stats = { closedTrades: cl.length, openTrades: P.open.length, pending: P.pending.length, winRate: cl.length ? +(wins.length / cl.length * 100).toFixed(1) : null,
  expectancyPct: cl.length ? +mean(cl.map(t => t.pnlPct)).toFixed(2) : null, avgWinPct: wins.length ? +mean(wins.map(t => t.pnlPct)).toFixed(2) : null, avgLossPct: loss.length ? +mean(loss.map(t => t.pnlPct)).toFixed(2) : null,
  maxDrawdownPct: +dd.toFixed(2), equityILS: +curILS.toFixed(2), pnlILS: +pnlILS.toFixed(2), pnlPct: +(pnlILS / P.startCapitalILS * 100).toFixed(2), doNothingILS: P.startCapitalILS,
  taxNote: `Not deducted. At ${TAX}% on gains, after-tax P&L would be ${pnlILS > 0 ? (pnlILS * (1 - TAX / 100)).toFixed(0) : pnlILS.toFixed(0)} ILS.` };
P.updatedAt = new Date().toISOString(); P.dataAsOf = dataAsOf;
P.assumptions = { entry: 'next trading day open after the alert, plus slippage', slippagePerSidePct: 'by liquidity: 0.1 to 0.6', feesRoundTripPct: FEE_RT_PCT, riskPerTradePct: RISK * 100, stopPct: 5, targetPct: 8, timeStopDays: HOLD, maxPositionPctOfEquity: MAX_POS * 100, fx: P.usdIlsSource, notModeled: ['tax', 'halts', 'real spreads and partial fills', 'delisted names', 'intraday path (same-day target and stop = stop)'] };
const recent = P.log.slice(-6).map(l => `${l.date}: ${l.msg}`);
P.summary = (!P.usdIls ? 'Paper portfolio is not running: no exchange rate was available at start.' :
  `Virtual portfolio (not real money), data as of ${dataAsOf}: ${P.equity.length ? '' : 'no data yet. '}capital ${curILS.toFixed(0)} ILS vs ${P.startCapitalILS} ILS at start (${pnlILS >= 0 ? '+' : ''}${pnlILS.toFixed(0)} ILS, ${P.stats.pnlPct}%). Doing nothing would still be ${P.startCapitalILS} ILS. ` +
  (cl.length + P.open.length + P.pending.length === 0 ? 'No alert has passed the strict gate yet, so nothing was bought. That is the intended behavior: the system stays in cash until a signal type proves positive expectancy after costs.' :
   `Closed trades: ${cl.length}${cl.length ? ` (win rate ${P.stats.winRate}%, avg result ${P.stats.expectancyPct}% per trade)` : ''}; open: ${P.open.length}; waiting for next open: ${P.pending.length}. Recent: ${recent.join(' | ') || 'none'}.`) +
  ` Small samples prove nothing; fees and slippage are included, tax is not.`);
fs.writeFileSync(FILE, JSON.stringify(P, null, 1));
console.log(P.summary);
