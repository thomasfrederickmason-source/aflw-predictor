// Swaps the round's model data into the Fairline board: copies the fresh
// betting_odds_model.json into Fairline/data (the Worker bundles it for
// /api/market-beaters) and replaces the inline <script id="odds-data"> block
// the static page reads, plus the round label.
const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/Tom/Projects/AFLW-Predictor/data/betting_odds_model.json';
const FAIRLINE = 'C:/Users/Tom/Projects/Fairline';
const OLD_ROUND = Number(process.argv[2] || 5);
const NEW_ROUND = Number(process.argv[3] || 6);

const model = fs.readFileSync(SRC, 'utf8');
const parsed = JSON.parse(model);
const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
console.log(`model: ${entries.length} matches`);

// 1. bundled copy for the Worker
const dst = path.join(FAIRLINE, 'data/betting_odds_model.json');
fs.copyFileSync(dst, dst + '.r' + OLD_ROUND + 'bak');
fs.writeFileSync(dst, model);
console.log('wrote ' + dst);
// the fitted spreads, so /api/market-beaters prices lines/totals exactly as the board does
fs.copyFileSync('C:/Users/Tom/Projects/AFLW-Predictor/data/model_params.json', path.join(FAIRLINE, 'data/model_params.json'));
console.log('wrote ' + path.join(FAIRLINE, 'data/model_params.json'));

// 2. inline block in the static page
const htmlPath = path.join(FAIRLINE, 'public/index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
fs.writeFileSync(htmlPath + '.r' + OLD_ROUND + 'bak', html);
const OPEN = '<script id="odds-data" type="application/json">';
const start = html.indexOf(OPEN);
if (start < 0) throw new Error('odds-data script tag not found');
const from = start + OPEN.length;
const end = html.indexOf('</script>', from);
if (end < 0) throw new Error('unterminated odds-data block');

const oldInline = html.slice(from, end).trim();
const oldParsed = JSON.parse(oldInline);
const oldEntries = Array.isArray(oldParsed) ? oldParsed : Object.values(oldParsed);
console.log(`page currently holds ${oldEntries.length} matches: ` +
  oldEntries.map(e => e.homeTeam + ' v ' + e.awayTeam).join(', '));
// every field the page used before must still be there (new fields are fine)
const missingKeys = oldEntries.length ? Object.keys(oldEntries[0]).filter(k => !(k in entries[0])) : [];
if (missingKeys.length) throw new Error('shape mismatch: new model data lacks ' + missingKeys.join(', '));
html = html.slice(0, from) + '\n' + model.trim() + '\n' + html.slice(end);

// 3. round label. Since 2026-10-17 the page reads it from a small board-meta
// block (finals are named, e.g. "Semi Finals", not "Round 14"); the <title>
// is set to match. Older pages without the block get the old text swap.
const DATA_DIR = 'C:/Users/Tom/Projects/AFLW-Predictor/data';
const snapFile = fs.readdirSync(DATA_DIR).filter(f => new RegExp('^round' + NEW_ROUND + '_\\d{4}_prediction_snapshot\\.json$').test(f)).sort().pop();
const snapMeta = snapFile ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, snapFile), 'utf8')) : {};
const season = Number((snapFile || '').match(/_(\d{4})_/) ? snapFile.match(/_(\d{4})_/)[1] : new Date().getFullYear());
const roundName = snapMeta.roundName || ('Round ' + NEW_ROUND);
const META_RE = /<script id="board-meta" type="application\/json">[\s\S]*?<\/script>/;
if (META_RE.test(html)) {
  const meta = { round: NEW_ROUND, roundName, season, publishedAt: new Date().toISOString() };
  html = html.replace(META_RE, () => '<script id="board-meta" type="application/json">' + JSON.stringify(meta) + '</script>');
  html = html.replace(/<title>[^<]*<\/title>/, () => '<title>Fairline &middot; AFLW ' + roundName + '</title>');
  fs.writeFileSync(htmlPath, html);
  console.log(`wrote ${htmlPath} (board label: ${roundName}, ${season})`);
} else {
  const before = html;
  html = html.replace(new RegExp('Round ' + OLD_ROUND + '(?!\\d)', 'g'), 'Round ' + NEW_ROUND);
  const labelSwaps = (before.match(new RegExp('Round ' + OLD_ROUND + '(?!\\d)', 'g')) || []).length;
  fs.writeFileSync(htmlPath, html);
  console.log(`wrote ${htmlPath} (${labelSwaps} round labels updated)`);
}

// 4. verify the page still parses and now holds the new fixtures
const check = fs.readFileSync(htmlPath, 'utf8');
const s2 = check.indexOf(OPEN) + OPEN.length;
const e2 = check.indexOf('</script>', s2);
const now = JSON.parse(check.slice(s2, e2));
const nowEntries = Array.isArray(now) ? now : Object.values(now);
console.log(`page now holds ${nowEntries.length} matches: ` +
  nowEntries.map(e => e.homeTeam + ' v ' + e.awayTeam).join(', '));

// 5. the published-prediction ledger (added 2026-10-14) for the Record tab.
// Every prediction the board has ever shown, kept even after a mid-round
// re-run overwrites its round's snapshot file (a re-run only prices games not
// yet started, so the earlier games would otherwise be lost). An entry is only
// ever replaced by a newer snapshot taken BEFORE that game's kickoff, so the
// record can't be improved with hindsight. Results are filled from matches.json
// (the Worker also fetches them live from AFL.com.au).
const LEDGER = path.join(FAIRLINE, 'data/published.json');
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : { games: [] };
const byKey = new Map(ledger.games.map(g => [`${g.date}|${g.homeTeam}|${g.awayTeam}`, g]));
const DATA = 'C:/Users/Tom/Projects/AFLW-Predictor/data';
// entry shape, closing odds and results: fairline-ledger.js (shared with push-board.js)
const { ledgerEntry, completedMatches, closingOdds: closingOddsRows, seasonResults } = require('./fairline-ledger');
const results = completedMatches();
for (const f of fs.readdirSync(DATA).filter(f => /^round\d+_\d{4}_prediction_snapshot\.json$/.test(f))) {
  const snap = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const round = Number((snap.round.match(/Round (\d+)/) || [])[1]);
  const at = Date.parse(snap.capturedAt);
  for (const p of snap.predictions) {
    if (!(at < p.date * 1000)) continue; // only genuinely pre-match predictions
    const key = `${p.date}|${p.homeTeam}|${p.awayTeam}`;
    const old = byKey.get(key);
    if (old && Date.parse(old.publishedAt) >= at) continue;
    byKey.set(key, { ...ledgerEntry(p, round, snap.capturedAt), result: old ? old.result : null });
  }
}
for (const g of byKey.values()) {
  const m = results.find(x => x.homeTeam === g.homeTeam && x.awayTeam === g.awayTeam && Math.abs(Date.parse(x.date) - g.date * 1000) < 36 * 3600e3);
  if (m) g.result = { home: m.homeScore, away: m.awayScore };
}
const closingOdds = closingOddsRows();
const games = [...byKey.values()].sort((a, b) => a.date - b.date);
fs.writeFileSync(LEDGER, JSON.stringify({ updatedAt: new Date().toISOString(), games, closingOdds, results: seasonResults(results) }, null, 1));
console.log(`wrote ${LEDGER} (${games.length} published predictions, ${games.filter(g => g.result).length} with results, ${closingOdds.length} oddsportal closing prices)`);
