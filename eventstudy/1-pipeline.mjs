// Event + momentum data pipeline: calendar -> symbols -> bars. Writes calendar.json, universe_dir.json, bars.json (in cwd).
import fs from 'node:fs';
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => parseFloat(String(x).replace(/[$,]/g, ''));
async function get(url, text = false, tries = 4) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) }); if (r.status === 429) { await sleep(4000 * (i + 1)); continue; } if (!r.ok) { if (r.status === 404) return null; await sleep(800); continue; } return text ? await r.text() : await r.json(); } catch { await sleep(900); } } return undefined; }
const from = new Date(Date.now() - 740 * 864e5), to = new Date();
const fromS = from.toISOString().slice(0, 10), toS = to.toISOString().slice(0, 10);
// 1. earnings calendar
const days = [];
for (let t = new Date(from); t <= to; t = new Date(t.getTime() + 864e5)) { const d = t.getUTCDay(); if (d !== 0 && d !== 6) days.push(t.toISOString().slice(0, 10)); }
const cal = {}; let cfail = 0;
{
  let idx = 0; const CONC = 3;
  await Promise.all(Array.from({ length: CONC }, async () => { while (idx < days.length) { const d = days[idx++]; const j = await get(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`); if (j === undefined) { cfail++; cal[d] = null; } else cal[d] = (j.data?.rows || []).map(r => ({ s: r.symbol, name: r.name, eps: r.eps, fc: r.epsForecast, surp: r.surprise, cap: r.marketCap, est: r.noOfEsts })); await sleep(250); } }));
}
fs.writeFileSync('calendar.json', JSON.stringify(cal));
console.log('calendar done, failDays', cfail, 'events', Object.values(cal).flatMap(r => r || []).length);
// 2. symbol universe = calendar cap-filtered UNION directory+screener
const syms = new Set();
for (const rows of Object.values(cal)) for (const r of rows || []) { const c = num(r.cap); if (isFinite(c) && c >= 3e8 && c <= 1e10 && /^[A-Z]{1,5}(\.[A-Z])?$/.test(r.s)) syms.add(r.s); }
const scr = await get('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true');
const capNow = {}; for (const r of scr?.data?.rows || []) { const c = num(r.marketCap); capNow[r.symbol] = isFinite(c) && c > 0 ? c : null; }
const a = await get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', true), b = await get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt', true);
const BAD = /warrant|rights?\b|units?\b|preferred|depositary shares|notes due|acquisition corp|trust\b|fund\b|etf|etn|index|% /i;
const dirUni = {};
if (a && b) {
  const add = (s, name) => { if (/^[A-Z]{1,5}$/.test(s) && !BAD.test(name) && capNow[s] && capNow[s] >= 3e8 && capNow[s] <= 1e10) { syms.add(s); dirUni[s] = capNow[s]; } };
  for (const l of a.split('\n').slice(1)) { const c = l.trim().split('|'); if (c.length >= 8 && c[3] === 'N' && c[6] === 'N' && c[7] === 'N' && c[4] === 'N') add(c[0], c[1]); }
  for (const l of b.split('\n').slice(1)) { const c = l.trim().split('|'); if (c.length >= 8 && ['N', 'A'].includes(c[2]) && c[4] === 'N' && c[6] === 'N') add(c[7] || c[0], c[1]); }
}
fs.writeFileSync('universe_dir.json', JSON.stringify(dirUni));
console.log('symbols total', syms.size, 'dirUniverse', Object.keys(dirUni).length);
// 3. bars
const bars = {}; let done = 0, fail = 0, empty = 0; const list = [...syms]; const t0 = Date.now();
let idx = 0; const CONC = 8;
await Promise.all(Array.from({ length: CONC }, async () => { while (idx < list.length) { const s = list[idx++]; const d = await get(`https://api.nasdaq.com/api/quote/${s}/historical?assetclass=stocks&fromdate=${fromS}&limit=1000&todate=${toS}`); if (d === undefined) { fail++; continue; } const rows = d?.data?.tradesTable?.rows; if (!rows || !rows.length) { bars[s] = []; empty++; } else bars[s] = rows.map(r => { const [m, dd, y] = r.date.split('/'); return [Date.UTC(+y, +m - 1, +dd) / 1000, num(r.open), num(r.high), num(r.low), num(r.close), num(r.volume)]; }).filter(x => x.slice(1).every(isFinite)).sort((p, q) => p[0] - q[0]); done++; if (done % 200 === 0) console.log(`bars ${done}/${list.length} fail=${fail} empty=${empty} ${Math.round((Date.now() - t0) / 1000)}s`); await sleep(40); } }));
fs.writeFileSync('bars.json', JSON.stringify(bars));
console.log(`DONE bars fetched=${done} fail=${fail} empty=${empty} secs=${Math.round((Date.now() - t0) / 1000)}`);
