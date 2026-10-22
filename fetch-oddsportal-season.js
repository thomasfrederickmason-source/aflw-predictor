// Current season's CLOSING head-to-head odds from oddsportal's results page
// (average and best price across the ~5 bookmakers it tracks), for scoring the
// model against the market in rounds Fairline played before it started saving
// bookie prices itself (it began on 2026-10-02, round 8). Writes
// data/oddsportal_<season>.json and leaves the full history in odds.json alone.
// Only the latest 50 games are on the page a plain fetch gets (see fetch-odds.js).
//
// Usage: node fetch-oddsportal-season.js [season=2026]
const fs = require('fs');
const { extractInitial, extractMoneyline, UA } = require('./fetch-odds');

const SEASON = process.argv[2] || '2026';
const URL = 'https://www.oddsportal.com/aussie-rules/australia/afl-women/results/';

(async () => {
  const res = await fetch(URL, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-AU,en;q=0.9' } });
  if (!res.ok) throw new Error('oddsportal HTTP ' + res.status);
  const initial = extractInitial(await res.text());
  if (!initial) throw new Error('no results data in the page');
  const rows = (initial.rows || []).map(r => ({
    date: r['date-start-timestamp'], homeTeam: r['home-name'], awayTeam: r['away-name'],
    homeScore: r.homeResult != null ? Number(r.homeResult) : null, awayScore: r.awayResult != null ? Number(r.awayResult) : null,
    status: r['event-stage-name'], ...extractMoneyline(r),
  })).filter(r => r.homeAvgOdds && r.awayAvgOdds);
  fs.writeFileSync(`data/oddsportal_${SEASON}.json`, JSON.stringify({ fetchedAt: new Date().toISOString(), source: URL, pageCount: (initial.pagination || {}).pageCount, rows }, null, 1));
  const ds = rows.map(r => r.date).sort();
  console.log(`oddsportal ${SEASON}: ${rows.length} games with closing odds, ${new Date(ds[0] * 1000).toISOString().slice(0, 10)} to ${new Date(ds[ds.length - 1] * 1000).toISOString().slice(0, 10)} (page 1 of ${(initial.pagination || {}).pageCount})`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
