// Pulls AFLW historical odds (moneyline/1X2, closing avg + max across ~5 bookmakers)
// from oddsportal.com's server-rendered season results pages.
//
// IMPORTANT LIMITATION: oddsportal paginates at 50 matches/page, and their
// pagination (both the legacy ajax-sport-country-tournament-archive_ endpoint and
// the Next.js RSC ?page= param) only works via real browser JS — confirmed dead
// for a plain HTTP fetch (ajax endpoint 404s, ?page= is silently ignored server-
// side). So this script only ever gets each season's most recent 50 matches.
//   - Seasons with <=50 total matches (2017-2020) come back COMPLETE.
//   - Seasons with >50 matches (2021 onward) only get the back half of the
//     season (roughly the last 5-6 rounds + finals) — the front of those
//     seasons is NOT in this dataset. See README for how to fill that gap
//     (real browser automation, or a paid odds API) if it's needed later.
//
// Also a ToS note: oddsportal's terms prohibit automated scraping. This is a
// personal research script, not a redistributed product — worth keeping in
// mind if this ever needs to run at higher volume/frequency.

const fs = require('fs');
const path = require('path');

const SEASON_URLS = [
  ['2017', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2017/results/'],
  ['2018', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2018/results/'],
  ['2019', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2019/results/'],
  ['2020', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2020/results/'],
  ['2021', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2021/results/'],
  ['2022-s6', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2022/results/'],
  ['2022-s7', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2022-2023/results/'],
  ['2023', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2023/results/'],
  ['2024', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2024/results/'],
  ['2025', 'https://www.oddsportal.com/aussie-rules/australia/afl-women-2025/results/'],
  ['2026', 'https://www.oddsportal.com/aussie-rules/australia/afl-women/results/'], // current season, no year suffix
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function extractInitial(html) {
  const marker = 'self.__next_f.push([1,"';
  let idx = 0;
  const chunks = [];
  while (true) {
    const start = html.indexOf(marker, idx);
    if (start === -1) break;
    const strStart = start + marker.length - 1;
    let i = strStart + 1;
    while (i < html.length) {
      if (html[i] === '\\') { i += 2; continue; }
      if (html[i] === '"') break;
      i++;
    }
    const raw = html.slice(strStart, i + 1);
    idx = i + 1;
    try { chunks.push(JSON.parse(raw)); } catch (e) { /* skip */ }
  }
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const body = line.slice(colon + 1);
      if (!body.startsWith('[') && !body.startsWith('{')) continue;
      if (!line.includes('"rows"') || !line.includes('"pagination"')) continue;
      try {
        const data = JSON.parse(body);
        let found = null;
        (function walk(node) {
          if (found) return;
          if (Array.isArray(node)) { for (const c of node) walk(c); return; }
          if (node && typeof node === 'object') {
            if (Array.isArray(node.rows) && node.pagination) { found = node; return; }
            for (const k in node) walk(node[k]);
          }
        })(data);
        if (found) return found;
      } catch (e) { /* not this line */ }
    }
  }
  return null;
}

// bettingTypeId 3 = 1X2 moneyline, scopeId 1 = full match.
// outcomeResultId is the outcome's RESULT (1 = won, 2 = lost), not home/away.
// It was read as 1=home 2=away until 2026-10-14, which swapped the two prices
// in every game the away side won: that's why this data looked worse than Elo
// (Brier 0.262) and "$1.15 favourites only won 61%". Found by checking against
// the closing prices Fairline captured itself in rounds 8-9 (6 of 17 swapped,
// exactly the home losses). The entries come in home, away order.
function extractMoneyline(row) {
  const ml = (row.odds || []).filter(o => o.bettingTypeId === 3 && o.scopeId === 1);
  const hs = Number(row.homeResult), as = Number(row.awayResult);
  let home, away;
  if (row.homeResult != null && row.awayResult != null && hs !== as) {
    const won = ml.find(o => o.outcomeResultId === 1), lost = ml.find(o => o.outcomeResultId === 2);
    [home, away] = hs > as ? [won, lost] : [lost, won];
  } else { home = ml[0]; away = ml[ml.length - 1]; }
  return {
    homeAvgOdds: home ? home.avgOdds : null,
    homeMaxOdds: home ? home.maxOdds : null,
    awayAvgOdds: away ? away.avgOdds : null,
    awayMaxOdds: away ? away.maxOdds : null,
    bookmakerCount: home ? home.cntActive : null,
  };
}

async function main() {
  const allMatches = [];
  const coverage = [];

  for (const [label, url] of SEASON_URLS) {
    let html = null;
    for (let attempt = 1; attempt <= 4 && !html; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-AU,en;q=0.9',
          },
        });
        if (!res.ok) { console.log(`${label}: HTTP ${res.status} (attempt ${attempt})`); await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        html = await res.text();
      } catch (e) {
        console.log(`${label}: ${e.message} (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    if (!html) { console.log(`${label}: FAILED after retries, skipping`); continue; }
    const initial = extractInitial(html);
    if (!initial) { console.log(`${label}: no data found in page`); continue; }

    const rows = initial.rows || [];
    const pag = initial.pagination || {};
    const complete = pag.pageCount <= 1;
    coverage.push({ season: label, matchesInPage: rows.length, pageCount: pag.pageCount, complete });
    console.log(`${label}: ${rows.length} matches on page 1 of ${pag.pageCount} (${complete ? 'FULL SEASON' : 'PARTIAL — most recent only'})`);

    for (const r of rows) {
      const ml = extractMoneyline(r);
      allMatches.push({
        season: label,
        date: r['date-start-base'],
        timestamp: r['date-start-timestamp'],
        homeTeam: r['home-name'],
        awayTeam: r['away-name'],
        homeScore: r.homeResult != null ? Number(r.homeResult) : null,
        awayScore: r.awayResult != null ? Number(r.awayResult) : null,
        stage: r['tournament-stage-name'] || null,
        status: r['event-stage-name'],
        ...ml,
      });
    }
    await new Promise(r => setTimeout(r, 2000)); // be polite
  }

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'odds.json'), JSON.stringify(allMatches, null, 2));

  const csvHeader = ['season','date','homeTeam','awayTeam','homeScore','awayScore','stage',
    'homeAvgOdds','homeMaxOdds','awayAvgOdds','awayMaxOdds','bookmakerCount'].join(',');
  const csvRows = allMatches.map(m => [
    m.season, m.date, m.homeTeam, m.awayTeam, m.homeScore, m.awayScore, m.stage,
    m.homeAvgOdds, m.homeMaxOdds, m.awayAvgOdds, m.awayMaxOdds, m.bookmakerCount,
  ].map(v => v == null ? '' : String(v).includes(',') ? `"${v}"` : v).join(','));
  fs.writeFileSync(path.join(outDir, 'odds.csv'), [csvHeader, ...csvRows].join('\n'));

  console.log(`\nTotal matches with odds saved: ${allMatches.length}`);
  console.log('\nCoverage summary:');
  coverage.forEach(c => console.log(`  ${c.season}: ${c.matchesInPage} matches, ${c.complete ? 'complete' : `partial (${c.pageCount} pages total, only page 1 pulled)`}`));
}

// fetch-oddsportal-season.js reuses the parsers for a quick current-season pull
module.exports = { extractInitial, extractMoneyline, UA };
if (require.main === module) main().catch(e => { console.error('FATAL', e); process.exit(1); });
