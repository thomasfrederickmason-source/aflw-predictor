// Joins data/flashscore_lines.json (totals/handicap odds scraped via
// fetch-flashscore-lines.js) onto data/matches.json, the same way merge.js
// joins the oddsportal moneyline data — unordered team pair + closest date
// within tolerance, then use SCORES (not the home/away label) to decide
// whether flashscore's side 1/2 lines up with our home/away, since Grand
// Finals in particular sometimes have the two sites disagreeing on which
// side is "home" (see README).
//
// Writes data/matches_with_lines.json: matches.json rows plus `overUnder`
// and `handicap` arrays (empty where flashscore had no data), oriented so
// odds1/handicap sign always refer to OUR home team.

const fs = require('fs');

const results = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const flashscoreBySeason = JSON.parse(fs.readFileSync('data/flashscore_lines.json', 'utf8'));

const NICKNAME_MAP = {
  'crows': 'adelaide crows', 'lions': 'brisbane lions', 'blues': 'carlton blues',
  'magpies': 'collingwood magpies', 'bombers': 'essendon bombers', 'dockers': 'fremantle dockers',
  'freo': 'fremantle dockers', 'giants': 'gws giants', 'cats': 'geelong cats',
  'suns': 'gold coast suns', 'hawks': 'hawthorn hawks', 'demons': 'melbourne demons',
  'kangaroos': 'north melbourne', 'power': 'port adelaide', 'richmond': 'richmond',
  'st kilda': 'st kilda', 'swans': 'sydney swans', 'west coast eagles': 'west coast eagles',
  'eagles': 'west coast eagles', 'bulldogs': 'western bulldogs',
};
function normalize(name) {
  const n = name.toLowerCase().replace(/\bw\b/g, '').trim();
  return NICKNAME_MAP[n] || n;
}

function parseFlashscoreDate(d) {
  // "29.11.2025" -> unix seconds, noon UTC (day-level precision is enough;
  // merge tolerance is +/- 3 days)
  const [dd, mm, yyyy] = d.split('.');
  return Math.floor(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0) / 1000);
}

const allFlashscore = [];
for (const season in flashscoreBySeason) {
  for (const m of flashscoreBySeason[season]) {
    if (!m.date || m.homeScore == null || m.awayScore == null) continue;
    if (!m.overUnder.length && !m.handicap.length) continue; // skip empty, nothing to join
    allFlashscore.push({ ...m, timestamp: parseFlashscoreDate(m.date) });
  }
}

const byUnorderedPair = new Map();
for (const m of allFlashscore) {
  const key = [normalize(m.homeTeam), normalize(m.awayTeam)].sort().join('|');
  if (!byUnorderedPair.has(key)) byUnorderedPair.set(key, []);
  byUnorderedPair.get(key).push(m);
}

let matched = 0, unmatched = 0, swapped = 0, withOverUnder = 0, withHandicap = 0;
const merged = results.map(m => {
  const pairKey = [normalize(m.homeTeam), normalize(m.awayTeam)].sort().join('|');
  const candidates = byUnorderedPair.get(pairKey) || [];
  const matchTs = new Date(m.date).getTime() / 1000;
  let best = null, bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(c.timestamp - matchTs);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  const withinTolerance = best && bestDiff < 3 * 24 * 3600;
  if (!withinTolerance) { unmatched++; return { ...m, overUnder: [], handicap: [] }; }

  const flashHomeMatchesOurHome = best.homeScore === m.homeScore && best.awayScore === m.awayScore;
  const flashHomeMatchesOurAway = best.homeScore === m.awayScore && best.awayScore === m.homeScore;
  if (!flashHomeMatchesOurHome && !flashHomeMatchesOurAway) {
    unmatched++; return { ...m, overUnder: [], handicap: [] };
  }
  matched++;

  let overUnder = best.overUnder;
  let handicap = best.handicap;
  if (flashHomeMatchesOurAway) {
    // flashscore's "1"/home side is actually our away team - flip so
    // handicap/over sign always refers to OUR home team, and "1" odds
    // always means "our home team" for consistency with matches_with_odds.json
    swapped++;
    handicap = handicap.map(h => ({ handicap: -h.handicap, odds1: h.odds2, odds2: h.odds1 }));
    // over/under total isn't home/away-relative, no flip needed
  }
  if (overUnder.length) withOverUnder++;
  if (handicap.length) withHandicap++;

  return { ...m, overUnder, handicap };
});

fs.writeFileSync('data/matches_with_lines.json', JSON.stringify(merged, null, 1));

console.log(`Matched ${matched} of ${results.length} results matches to flashscore lines data (${(100 * matched / results.length).toFixed(1)}%)`);
console.log(`Of those: ${withOverUnder} have totals (over/under), ${withHandicap} have Asian handicap`);
console.log(`Home/away swapped to align: ${swapped}`);
console.log(`Unmatched (no flashscore lines data found nearby): ${unmatched}`);
