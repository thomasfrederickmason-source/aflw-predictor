// One-off (2026-08-25): merges the browser-scraped supplement pages
// (data/odds.json only ever got each season's most-recent 50 matches via
// plain HTTP — see fetch-odds.js and README) into data/odds.json. Source:
// pipe-delimited scratch files pulled via Claude in Chrome from
// oddsportal.com's paginated results pages (2021, 2022-s6, 2022-s7, 2023,
// 2024, 2025 — the only seasons with >50 matches). The scratch files
// themselves lived in a session-specific temp dir and are gone; this is kept
// as a record of the method (see README) in case more seasons need the same
// treatment later, not meant to be re-run as-is.

const fs = require('fs');
const path = require('path');

const SCRATCH_DIR = 'C:/Users/Tom/AppData/Local/Temp/claude/C--Users-Tom/f6ccb6df-24ed-49e3-9147-4f6a3df28cbe/scratchpad';
const FILES = [
  'odds_supplement_2021.txt',
  'odds_supplement_2022s6.txt',
  'odds_supplement_2022s7.txt',
  'odds_supplement_2023.txt',
  'odds_supplement_2024.txt',
  'odds_supplement_2025.txt',
];

const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

function parseDate(s) {
  // "04 Oct 2025" -> unix seconds, noon UTC (exact time-of-day unknown from
  // the DOM date header; merge.js tolerance is +/-3 days so this is fine)
  const [dd, mon, yyyy] = s.split(' ');
  const d = new Date(Date.UTC(Number(yyyy), MONTHS[mon], Number(dd), 12, 0, 0));
  return Math.floor(d.getTime() / 1000);
}

let supplement = [];
for (const f of FILES) {
  const text = fs.readFileSync(path.join(SCRATCH_DIR, f), 'utf8');
  const lines = text.trim().split('\n');
  const season = lines[0].replace('season=', '');
  for (const line of lines.slice(1)) {
    const [date, homeTeam, awayTeam, homeScore, awayScore, homeAvgOdds, awayAvgOdds] = line.split('|');
    supplement.push({
      season,
      date: parseDate(date),
      timestamp: parseDate(date),
      homeTeam, awayTeam,
      homeScore: Number(homeScore), awayScore: Number(awayScore),
      stage: null,
      status: 'Finished',
      homeAvgOdds: Number(homeAvgOdds), homeMaxOdds: null,
      awayAvgOdds: Number(awayAvgOdds), awayMaxOdds: null,
      bookmakerCount: null,
    });
  }
}

const existing = JSON.parse(fs.readFileSync('data/odds.json', 'utf8'));

// Dedup key: season + both team names + date (day-level, since supplement
// timestamps are synthetic noon-UTC and existing ones are real bookmaker
// timestamps) — guards against re-running this script.
function key(o) {
  const day = new Date(o.timestamp * 1000).toISOString().slice(0, 10);
  return [o.season, o.homeTeam, o.awayTeam, day].join('|');
}
const existingKeys = new Set(existing.map(key));
const newRows = supplement.filter(o => !existingKeys.has(key(o)));
const dupes = supplement.length - newRows.length;

const merged = existing.concat(newRows);
fs.writeFileSync('data/odds.json', JSON.stringify(merged, null, 2));

const csvHeader = ['season','date','homeTeam','awayTeam','homeScore','awayScore','stage',
  'homeAvgOdds','homeMaxOdds','awayAvgOdds','awayMaxOdds','bookmakerCount'].join(',');
const csvRows = merged.map(m => [
  m.season, m.date, m.homeTeam, m.awayTeam, m.homeScore, m.awayScore, m.stage,
  m.homeAvgOdds, m.homeMaxOdds, m.awayAvgOdds, m.awayMaxOdds, m.bookmakerCount,
].map(v => v == null ? '' : String(v).includes(',') ? `"${v}"` : v).join(','));
fs.writeFileSync('data/odds.csv', [csvHeader, ...csvRows].join('\n'));

console.log(`Supplement rows parsed: ${supplement.length}`);
console.log(`Duplicates skipped (already in odds.json): ${dupes}`);
console.log(`New rows added: ${newRows.length}`);
console.log(`Total odds.json rows: ${merged.length} (was ${existing.length})`);

const bySeasonCount = {};
for (const m of merged) bySeasonCount[m.season] = (bySeasonCount[m.season] || 0) + 1;
console.log('\nPer-season odds.json counts:', bySeasonCount);
