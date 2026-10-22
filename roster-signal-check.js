// Validates the player-availability signal before it goes anywhere near the
// model. Builds a running "games played" count per player (appearance
// count as of each match, using positions[] as the source of truth for who
// played), then for each match sums the games-played of each team's `outs`
// (AFL.com.au's own ins/outs-vs-last-match diff) as an "importance-weighted
// outs" score — losing a 50-game veteran should matter more than losing a
// fringe player who's only played twice.
//
// Then checks: does a team's outs-importance actually correlate with
// underperforming the Elo model's expectation? If not, this isn't worth
// building into the model no matter how appealing it sounds a priori.

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const rosters = JSON.parse(fs.readFileSync('data/rosters.json', 'utf8'));
const eloHistory = JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8'));

// chronological order, same as elo-model.js / fetch-data.js produce
const sorted = [...matches].sort((a, b) => new Date(a.date) - new Date(b.date));

const gamesPlayed = new Map(); // playerId -> appearance count BEFORE this match
const eloByMatchId = new Map(eloHistory.map(h => [h.matchId, h]));

const rows = [];
for (const m of sorted) {
  const roster = rosters[m.matchId];
  if (!roster || !roster.homeTeam || !roster.awayTeam) continue;
  const elo = eloByMatchId.get(m.matchId);
  if (!elo) continue;

  // "Managed" (planned rest) is confounded with already being a heavy
  // favourite — a team doesn't need its rested-not-injured star to still
  // win comfortably, so lump it in and it dilutes/reverses any real signal.
  // Split it out from genuinely unplanned outs.
  function outsImportance(side, excludeManaged) {
    let sum = 0, n = 0;
    for (const o of side.outs) {
      if (excludeManaged && o.reason === 'Managed') continue;
      const gp = gamesPlayed.get(o.playerId) || 0;
      sum += gp;
      n++;
    }
    return { sum, n };
  }
  const homeOuts = outsImportance(roster.homeTeam, false);
  const awayOuts = outsImportance(roster.awayTeam, false);
  const homeOutsUnplanned = outsImportance(roster.homeTeam, true);
  const awayOutsUnplanned = outsImportance(roster.awayTeam, true);

  rows.push({
    matchId: m.matchId,
    season: m.season,
    date: m.date,
    homeOutsCount: homeOuts.n,
    awayOutsCount: awayOuts.n,
    homeOutsImportance: homeOuts.sum,
    awayOutsImportance: awayOuts.sum,
    netOutsAdvantage: awayOuts.sum - homeOuts.sum, // positive = home team advantaged (away lost more important players)
    netOutsAdvantageUnplanned: awayOutsUnplanned.sum - homeOutsUnplanned.sum,
    netOutsCountUnplanned: awayOutsUnplanned.n - homeOutsUnplanned.n,
    eloHomeWinProb: elo.homeWinProbModel,
    homeWin: elo.homeWin,
    margin: elo.margin, // home - away
  });

  // update appearance counts AFTER using them (so this match's own players
  // don't count themselves)
  for (const side of [roster.homeTeam, roster.awayTeam]) {
    for (const p of side.positions) {
      gamesPlayed.set(p.playerId, (gamesPlayed.get(p.playerId) || 0) + 1);
    }
  }
}

console.log(`Matches with both roster + Elo history: ${rows.length} of ${matches.length}`);

// --- Validation 1: simple correlation between netOutsAdvantage and margin residual ---
// residual = actual margin - what Elo alone would predict on average for that win prob
// (crude but fine for a first check): use eloHomeWinProb converted to an
// implied expected margin via the same logistic mapping tune-elo.js/elo-model.js
// uses isn't available standalone here, so just correlate against raw margin
// and against (homeWin - eloHomeWinProb) as the "surprise" signal.
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

const withOuts = rows.filter(r => r.homeOutsCount + r.awayOutsCount > 0);
console.log(`Matches where at least one team had a tracked out: ${withOuts.length}`);

const netAdv = rows.map(r => r.netOutsAdvantage);
const surprise = rows.map(r => (r.homeWin ? 1 : 0) - r.eloHomeWinProb);
const marginArr = rows.map(r => r.margin);

console.log(`\nCorrelation (net outs-importance advantage) vs (win-prob surprise): ${pearson(netAdv, surprise).toFixed(4)}`);
console.log(`Correlation (net outs-importance advantage) vs (actual margin): ${pearson(netAdv, marginArr).toFixed(4)}`);

// simpler binary version: does raw outs COUNT advantage (not importance-weighted) matter?
const netCount = rows.map(r => r.awayOutsCount - r.homeOutsCount);
console.log(`Correlation (net outs COUNT advantage) vs (win-prob surprise): ${pearson(netCount, surprise).toFixed(4)}`);
console.log(`Correlation (net outs COUNT advantage) vs (actual margin): ${pearson(netCount, marginArr).toFixed(4)}`);

// unplanned-only (excludes "Managed" rests, which are confounded with
// already being a heavy favourite)
const netAdvUnplanned = rows.map(r => r.netOutsAdvantageUnplanned);
const netCountUnplanned = rows.map(r => r.netOutsCountUnplanned);
console.log(`\n--- Excluding "Managed" (planned rest) outs ---`);
console.log(`Correlation (net UNPLANNED outs-importance advantage) vs (win-prob surprise): ${pearson(netAdvUnplanned, surprise).toFixed(4)}`);
console.log(`Correlation (net UNPLANNED outs-importance advantage) vs (actual margin): ${pearson(netAdvUnplanned, marginArr).toFixed(4)}`);
console.log(`Correlation (net UNPLANNED outs COUNT advantage) vs (win-prob surprise): ${pearson(netCountUnplanned, surprise).toFixed(4)}`);
console.log(`Correlation (net UNPLANNED outs COUNT advantage) vs (actual margin): ${pearson(netCountUnplanned, marginArr).toFixed(4)}`);

// --- Validation 2: bucket by |netOutsAdvantage| and see if bigger swings -> bigger surprises ---
console.log('\n=== Bucketed by importance-weighted net outs advantage (home perspective) ===');
const buckets = [[-Infinity, -20], [-20, -5], [-5, 5], [5, 20], [20, Infinity]];
for (const [lo, hi] of buckets) {
  const bucket = rows.filter(r => r.netOutsAdvantage > lo && r.netOutsAdvantage <= hi);
  if (!bucket.length) continue;
  const avgSurprise = bucket.reduce((s, r) => s + ((r.homeWin ? 1 : 0) - r.eloHomeWinProb), 0) / bucket.length;
  const avgMargin = bucket.reduce((s, r) => s + r.margin, 0) / bucket.length;
  console.log(`  (${lo}, ${hi}]  n=${bucket.length.toString().padStart(4)}  avg win-prob surprise=${avgSurprise >= 0 ? '+' : ''}${avgSurprise.toFixed(3)}  avg margin=${avgMargin >= 0 ? '+' : ''}${avgMargin.toFixed(1)}`);
}

console.log('\n=== Bucketed by UNPLANNED-only net outs advantage (home perspective) ===');
for (const [lo, hi] of buckets) {
  const bucket = rows.filter(r => r.netOutsAdvantageUnplanned > lo && r.netOutsAdvantageUnplanned <= hi);
  if (!bucket.length) continue;
  const avgSurprise = bucket.reduce((s, r) => s + ((r.homeWin ? 1 : 0) - r.eloHomeWinProb), 0) / bucket.length;
  const avgMargin = bucket.reduce((s, r) => s + r.margin, 0) / bucket.length;
  console.log(`  (${lo}, ${hi}]  n=${bucket.length.toString().padStart(4)}  avg win-prob surprise=${avgSurprise >= 0 ? '+' : ''}${avgSurprise.toFixed(3)}  avg margin=${avgMargin >= 0 ? '+' : ''}${avgMargin.toFixed(1)}`);
}
const overallAvgMargin = marginArr.reduce((a,b)=>a+b,0)/marginArr.length;
console.log(`\n(baseline avg margin across all ${rows.length} matches: ${overallAvgMargin.toFixed(1)})`);

fs.writeFileSync('data/roster_signal.json', JSON.stringify(rows, null, 1));
console.log('\nWrote data/roster_signal.json for further use.');
