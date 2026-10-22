// Compares market-implied win probability (from oddsportal avgOdds) against
// the Elo model's win probability, on every match where both are available.
// Re-run after the odds-coverage fix (browser-scraped pagination gap) to
// check the README's flagged open question: market Brier was worse than
// Elo's on only 447 overlapping matches (0.262 vs 0.194) — surprisingly bad
// for a real market, and not yet explained. More coverage = a cleaner read.

const fs = require('fs');
const history = JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8'));
const withOdds = JSON.parse(fs.readFileSync('data/matches_with_odds.json', 'utf8'));

const oddsById = new Map(withOdds.map(m => [m.matchId, m]));

const rows = [];
for (const h of history) {
  const o = oddsById.get(h.matchId);
  if (!o || o.homeAvgOdds == null || o.awayAvgOdds == null) continue;
  // de-vig: normalize the two implied probabilities so they sum to 1
  const pHomeRaw = 1 / o.homeAvgOdds, pAwayRaw = 1 / o.awayAvgOdds;
  const overround = pHomeRaw + pAwayRaw;
  const marketProbHome = pHomeRaw / overround;
  rows.push({
    season: h.season,
    matchId: h.matchId,
    homeWin: h.homeWin,
    eloProb: h.homeWinProbModel,
    marketProb: marketProbHome,
    overround,
  });
}

function brier(rs, key) {
  return rs.reduce((s, r) => s + (r[key] - (r.homeWin ? 1 : 0)) ** 2, 0) / rs.length;
}
function accuracy(rs, key) {
  return rs.filter(r => (r[key] > 0.5) === r.homeWin).length / rs.length;
}

console.log(`Overlapping matches (both Elo + market odds available): ${rows.length} of ${history.length}`);
console.log(`\nBrier score (lower = better):`);
console.log(`  Elo model:    ${brier(rows, 'eloProb').toFixed(4)}   favourite-hit-rate ${(100*accuracy(rows,'eloProb')).toFixed(1)}%`);
console.log(`  Market (avg odds, de-vig'd): ${brier(rows, 'marketProb').toFixed(4)}   favourite-hit-rate ${(100*accuracy(rows,'marketProb')).toFixed(1)}%`);
console.log(`  Avg overround: ${(rows.reduce((s,r)=>s+r.overround,0)/rows.length).toFixed(4)} (1.0 = no bookmaker margin)`);

console.log(`\nBy season:`);
const seasons = [...new Set(rows.map(r => r.season))];
for (const s of seasons) {
  const rs = rows.filter(r => r.season === s);
  if (rs.length < 5) continue;
  console.log(`  ${s.padEnd(28)} n=${rs.length.toString().padStart(3)}  Elo=${brier(rs,'eloProb').toFixed(4)}  Market=${brier(rs,'marketProb').toFixed(4)}`);
}

// Short-priced favourite check from README: "$1.15 or shorter only won 61%"
const shortFavWinRate = (() => {
  const fav = rows.filter(r => Math.max(r.marketProb, 1 - r.marketProb) >= 1/1.15);
  if (!fav.length) return null;
  const hit = fav.filter(r => (r.marketProb >= 0.5) === r.homeWin).length;
  return { n: fav.length, hitRate: hit / fav.length };
})();
console.log(`\nShort-priced favourites ($1.15 or shorter, de-vig'd prob >= ${(1/1.15*100).toFixed(1)}%): n=${shortFavWinRate.n}, actual win rate=${(100*shortFavWinRate.hitRate).toFixed(1)}%`);
