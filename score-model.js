// Offense/defense rating model for TOTAL SCORE and QUARTER-LEVEL markets —
// separate from the win/loss Elo model, since a team can be well-rated for
// winning while being either high- or low-scoring (matters for totals/line
// markets specifically, not just who wins).
//
// Approach: each team gets an attack rating (their scoring output relative
// to league average) and a defense rating (opponents' scoring against them,
// relative to league average), updated match-by-match with an EMA (more
// weight on recent form, same spirit as the Elo model's season regression).
// Predicted score for a team = leagueAvgTeamScore * attackRating(scorer) *
// defenseRating(conceder) — same multiplicative structure used in most
// sports scoring-rate models (e.g. baseball/basketball efficiency ratings).
//
// Also computes each team's per-quarter scoring/conceding profile, since
// AFLW rosters are shallower than the men's game and fatigue/rotation
// effects across a match can be more pronounced — worth checking before
// assuming a flat quarter split like the league average.

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeScore != null && m.awayScore != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));

const EMA_ALPHA = 0.08; // weight on each new match; ~12-match half-life

const attack = new Map(); // team -> rating (1.0 = league average scoring output)
const defense = new Map(); // team -> rating (1.0 = league average points conceded)
let leagueAvgTeamScore = null; // recomputed as a trailing average, seeded below

// seed league average from the first ~40 matches so ratings don't start blind
const seedScores = matches.slice(0, 40).flatMap(m => [m.homeScore, m.awayScore]);
leagueAvgTeamScore = seedScores.reduce((a, b) => a + b, 0) / seedScores.length;

function getAttack(team) { return attack.has(team) ? attack.get(team) : 1.0; }
function getDefense(team) { return defense.has(team) ? defense.get(team) : 1.0; }

const history = [];
for (const m of matches) {
  const homeAtk = getAttack(m.homeTeam), homeDef = getDefense(m.homeTeam);
  const awayAtk = getAttack(m.awayTeam), awayDef = getDefense(m.awayTeam);

  const predHomeScore = leagueAvgTeamScore * homeAtk * awayDef;
  const predAwayScore = leagueAvgTeamScore * awayAtk * homeDef;

  history.push({
    matchId: m.matchId, season: m.season, date: m.date,
    homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    predHomeScore, predAwayScore,
    actualHomeScore: m.homeScore, actualAwayScore: m.awayScore,
    predTotal: predHomeScore + predAwayScore, actualTotal: m.totalScore,
  });

  // update: how did each side's actual scoring output compare to what their
  // attack rating times the opponent's defense predicted?
  const homeAtkError = m.homeScore / (leagueAvgTeamScore * awayDef) - homeAtk;
  const awayAtkError = m.awayScore / (leagueAvgTeamScore * homeDef) - awayAtk;
  const homeDefError = m.awayScore / (leagueAvgTeamScore * awayAtk) - homeDef; // home's defense judged on away's output
  const awayDefError = m.homeScore / (leagueAvgTeamScore * homeAtk) - awayDef;

  attack.set(m.homeTeam, homeAtk + EMA_ALPHA * homeAtkError);
  attack.set(m.awayTeam, awayAtk + EMA_ALPHA * awayAtkError);
  defense.set(m.homeTeam, homeDef + EMA_ALPHA * homeDefError);
  defense.set(m.awayTeam, awayDef + EMA_ALPHA * awayDefError);

  // slowly drift the league average total-score baseline (scoring has risen
  // over AFLW's history — see README) rather than using one fixed number
  // for the whole dataset
  leagueAvgTeamScore = leagueAvgTeamScore * 0.995 + ((m.homeScore + m.awayScore) / 2) * 0.005;
}

console.log('=== Current attack/defense ratings (1.0 = league average) ===');
const teams = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]))];
const table = teams.map(t => ({ team: t, attack: getAttack(t), defense: getDefense(t) }))
  .sort((a, b) => b.attack - a.attack);
table.forEach(r => console.log(`${r.team.padEnd(14)} attack ${r.attack.toFixed(2)}   defense ${r.defense.toFixed(2)} ${r.defense < 1 ? '(stingy)' : '(leaky)'}`));

console.log(`\nCurrent league-average team score (trailing): ${leagueAvgTeamScore.toFixed(1)}`);

// backtest: mean absolute error on total score and each team's score
const totalErrors = history.map(h => Math.abs(h.predTotal - h.actualTotal));
const homeErrors = history.map(h => Math.abs(h.predHomeScore - h.actualHomeScore));
console.log(`\nTotal-score MAE (all ${history.length} matches): ${(totalErrors.reduce((a,b)=>a+b,0)/totalErrors.length).toFixed(1)} points`);
console.log(`Home-team-score MAE: ${(homeErrors.reduce((a,b)=>a+b,0)/homeErrors.length).toFixed(1)} points`);

// naive baseline for comparison: always predict the current trailing league average total
const naiveErrors = history.map(h => Math.abs(leagueAvgTeamScore * 2 - h.actualTotal));
console.log(`Naive baseline (always predict league-avg total) MAE: ${(naiveErrors.reduce((a,b)=>a+b,0)/naiveErrors.length).toFixed(1)} points`);

// --- quarter-level scoring profile per team ---
console.log('\n=== Per-team quarter scoring profile (avg points FOR per quarter, current-era 2024+ only) ===');
const recentMatches = matches.filter(m => m.season.includes('2024') || m.season.includes('2025') || m.season.includes('2026'));
const qFor = new Map(), qAgainst = new Map(), qCount = new Map();
for (const m of recentMatches) {
  for (const [team, own, opp] of [[m.homeTeam, m.homeQtr, m.awayQtr], [m.awayTeam, m.awayQtr, m.homeQtr]]) {
    if (!qFor.has(team)) { qFor.set(team, [0,0,0,0]); qAgainst.set(team, [0,0,0,0]); qCount.set(team, 0); }
    const f = qFor.get(team), a = qAgainst.get(team);
    for (let i = 0; i < 4; i++) { if (own[i] != null) f[i] += own[i]; if (opp[i] != null) a[i] += opp[i]; }
    qCount.set(team, qCount.get(team) + 1);
  }
}
for (const team of teams) {
  const n = qCount.get(team) || 0;
  if (n < 5) continue; // not enough recent-era matches
  const f = qFor.get(team).map(v => (v/n).toFixed(1));
  const a = qAgainst.get(team).map(v => (v/n).toFixed(1));
  console.log(`${team.padEnd(14)} FOR: Q1 ${f[0]} Q2 ${f[1]} Q3 ${f[2]} Q4 ${f[3]}   AGAINST: Q1 ${a[0]} Q2 ${a[1]} Q3 ${a[2]} Q4 ${a[3]}  (n=${n})`);
}

fs.writeFileSync('data/score_ratings.json', JSON.stringify(Object.fromEntries(table.map(r => [r.team, { attack: r.attack, defense: r.defense }])), null, 2));
// The attack/defense ratings above are fitted RELATIVE to this trailing
// baseline, so a consumer must use the same number or every predicted
// score is scaled wrong. Written out rather than printed so predict-round.js
// can read it instead of keeping a hand-copied constant that goes stale.
fs.writeFileSync('data/score_baseline.json', JSON.stringify({ leagueAvgTeamScore, updatedAt: new Date().toISOString() }, null, 1));
fs.writeFileSync('data/score_history.json', JSON.stringify(history, null, 2));
console.log('\nWritten: data/score_ratings.json, data/score_history.json');
