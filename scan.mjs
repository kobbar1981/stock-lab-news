// News/political event scanner. Runs in GitHub Actions. Node 20+, no deps.
import fs from 'node:fs';
const OUT = 'events.json';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const gn = (q, he) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=${he ? 'he&gl=IL&ceid=IL:he' : 'en-US&gl=US&ceid=US:en'}`;
const FEEDS = [
  ['Google News EN: Trump/tariffs', gn('Trump tariffs OR sanctions OR "executive order"')],
  ['Google News EN: Fed/rates', gn('Federal Reserve OR "interest rates" OR inflation')],
  ['Google News EN: Iran/Israel', gn('Iran OR Israel OR Hezbollah OR Houthi missile OR strike')],
  ['Google News EN: oil', gn('oil prices OPEC OR Hormuz')],
  ['Google News HE: ביטחון', gn('איראן OR חיזבאללה OR טילים OR מתקפה', true)],
  ['Google News HE: כלכלה', gn('בנק ישראל ריבית OR מכסים OR "הצהרה" בורסה', true)],
  ['Globes', 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=2'],
  ['ynet economy', 'https://www.ynet.co.il/Integration/StoryRss6.xml'],
  ['Fed press releases', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['Yahoo Finance', 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US'],
];
// Rules: theme -> keywords (en/he) and affected tickers (Yahoo symbols; .TA = Tel Aviv)
const THEMES = [
  { id: 'security-israel', label: 'ביטחון/איראן/טילים', kw: ['iran','missile','hezbollah','houthi','hamas','idf','איראן','טיל','חיזבאללה','חמאס','צה"ל','מתקפה'],
    up: ['ESLT','ESLT.TA','LMT','NOC','ITA'], down: ['LUMI.TA','POLI.TA'] },
  { id: 'oil', label: 'נפט/אנרגיה', kw: ['oil','opec','hormuz','crude','brent','נפט'], up: ['XOM','CVX','OXY'], down: ['DAL','UAL','AAL'] },
  { id: 'tariffs', label: 'מכסים/סחר', kw: ['tariff','trade war','sanction','export control','מכס','סנקציות'], up: [], down: ['NVDA','AAPL','TSLA','AMD'] },
  { id: 'rates', label: 'ריבית/אינפלציה', kw: ['federal reserve','fed ','rate cut','rate hike','interest rate','inflation','powell','בנק ישראל','ריבית','אינפלציה'], up: [], down: ['JPM','XLF','LUMI.TA','POLI.TA','DSCT.TA'] },
  { id: 'tech-policy', label: 'רגולציה/טכנולוגיה', kw: ['antitrust','chip','semiconductor','ai regulation'], up: [], down: ['NVDA','MSFT','GOOGL'] },
];
const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
function parse(xml, src) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g)) {
    const b = m[0];
    const g = t => (b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
    const link = decode(g('link')) || (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const date = new Date(decode(g('pubDate') || g('published') || g('updated')) || Date.now());
    items.push({ title: decode(g('title')), link, source: src, ts: isNaN(date) ? Date.now() : date.getTime() });
  }
  return items;
}
async function fetchFeed([name, url]) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 stock-lab-scanner' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status);
    return { name, items: parse(await r.text(), name), ok: true };
  } catch (e) { return { name, items: [], ok: false, err: String(e) }; }
}
const norm = t => t.toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^\p{L}\p{N} ]/gu, '').trim();
function ruleMatch(title) {
  const t = title.toLowerCase();
  return THEMES.filter(th => th.kw.some(k => t.includes(k)));
}
async function llm(batch) {
  if (!GEMINI_KEY || !batch.length) return null;
  const prompt = `You analyze news headlines (Hebrew or English) for stock-market relevance for a Tel Aviv + US investor. For each headline, decide if it contains a political statement, government action, security event or announcement likely to move specific stocks/sectors. Return JSON array: [{"i":index,"relevant":bool,"theme":"short English theme","tickers":[{"symbol":"Yahoo symbol, Tel Aviv uses .TA","direction":"up|down","why_he":"short Hebrew reason"}],"confidence":0-1,"summary_he":"one Hebrew sentence"}]. Be conservative: relevant=false for gossip, opinion, routine news. Confidence above 0.85 only for clear, material, named-company or sector-wide effects. Never invent tickers you are unsure of.\n\n` + batch.map((e, i) => `${i}. [${e.source}] ${e.title}`).join('\n');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
    signal: AbortSignal.timeout(60000) });
  if (!r.ok) { console.error('gemini', r.status, (await r.text()).slice(0, 200)); return null; }
  const j = await r.json();
  try { return JSON.parse(j.candidates[0].content.parts[0].text); } catch { return null; }
}
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { events: [], seen: {} };
const results = await Promise.all(FEEDS.map(fetchFeed));
const cutoff = Date.now() - 36 * 3600e3;
const fresh = [], seenTitles = new Set();
for (const r of results) for (const it of r.items) {
  const k = norm(it.title);
  if (!k || seenTitles.has(k) || prev.seen[k] || it.ts < cutoff) continue;
  seenTitles.add(k);
  const th = ruleMatch(it.title);
  if (th.length) fresh.push({ ...it, k, themes: th });
}
fresh.sort((a, b) => b.ts - a.ts);
const batch = fresh.slice(0, 40);
const ai = await llm(batch);
const newEvents = [];
batch.forEach((e, i) => {
  const a = ai && ai.find(x => x.i === i);
  if (ai && a && !a.relevant) return;
  const tickers = a?.tickers?.length ? a.tickers : e.themes.flatMap(t => [...t.up.map(s => ({ symbol: s, direction: 'up', why_he: t.label })), ...t.down.map(s => ({ symbol: s, direction: 'down', why_he: t.label }))]).slice(0, 6);
  const conf = a ? Number(a.confidence) || 0 : 0.3;
  newEvents.push({ id: Buffer.from(e.k).toString('base64url').slice(0, 24) + e.ts.toString(36), ts: e.ts, title: e.title, link: e.link, source: e.source,
    theme: a?.theme || e.themes.map(t => t.id).join(','), themes_he: e.themes.map(t => t.label), summary_he: a?.summary_he || '', tickers, confidence: conf,
    analyzed_by: a ? 'ai+rules' : 'rules', high_confidence: !!a && conf >= 0.85 && tickers.length > 0 });
});
const mark = {}; for (const e of fresh) mark[e.k] = e.ts;
const seen = { ...prev.seen, ...mark };
for (const k of Object.keys(seen)) if (seen[k] < Date.now() - 4 * 86400e3) delete seen[k];
const events = [...newEvents, ...prev.events].filter(e => e.ts > Date.now() - 7 * 86400e3).slice(0, 300);

fs.writeFileSync(OUT, JSON.stringify({ updated: Date.now(), feeds: results.map(r => ({ name: r.name, ok: r.ok, n: r.items.length })), ai_enabled: !!GEMINI_KEY, events, seen }, null, 1));
console.log('feeds', results.map(r => `${r.name}:${r.ok ? r.items.length : 'FAIL'}`).join(' | '), '\nnew events', newEvents.length, 'high', newEvents.filter(e => e.high_confidence).length);
