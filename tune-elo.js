// Grid search over K-factor, home-ground advantage, and season-regression
// strength to find the combination that minimizes the Elo model's Brier
// score — the earlier v1 used reasonable-guess defaults (K=24, HGA=30,
// regression=1/3), this replaces guessing with an actual fit.

const fs = require('fs');
const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeScore != null && m.awayScore != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));

function expectedScore(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function movMultiplier(margin, eloDiffWinner) {
  return Math.log(Math.abs(margin) + 1) * (2.2 / (eloDiffWinner * 0.001 + 2.2));
}

function runElo(K, HGA, regression) {
  const ratings = new Map();
  let currentSeason = null;
  const probs = [], outcomes = [];
  function getRating(team) {
    if (!ratings.has(team)) {
      const vals = [...ratings.values()];
      ratings.set(team, vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 1500);
    }
    return ratings.get(team);
  }
  for (const m of matches) {
    if (m.season !== currentSeason) {
      if (currentSeason !== null) {
        const vals = [...ratings.values()];
        const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
        for (const [t, r] of ratings) ratings.set(t, r + (mean - r) * regression);
      }
      currentSeason = m.season;
    }
    const homeR = getRating(m.homeTeam), awayR = getRating(m.awayTeam);
    const homeExp = expectedScore(homeR + HGA, awayR);
    const homeActual = m.homeScore > m.awayScore ? 1 : m.homeScore < m.awayScore ? 0 : 0.5;
    probs.push(homeExp); outcomes.push(homeActual);
    const winnerEloDiff = m.homeScore >= m.awayScore ? (homeR+HGA-awayR) : (awayR-homeR-HGA);
    const mult = movMultiplier(m.margin, winnerEloDiff);
    const delta = K * mult * (homeActual - homeExp);
    ratings.set(m.homeTeam, homeR + delta);
    ratings.set(m.awayTeam, awayR - delta);
  }
  const brier = probs.reduce((s,p,i) => s + (p - outcomes[i])**2, 0) / probs.length;
  return brier;
}

let best = null;
const results = [];
for (const K of [8, 12, 16, 20, 24, 28, 32, 40]) {
  for (const HGA of [0, 15, 30, 45, 60, 80]) {
    for (const regression of [0, 0.2, 1/3, 0.5, 0.67]) {
      const brier = runElo(K, HGA, regression);
      results.push({ K, HGA, regression, brier });
      if (!best || brier < best.brier) best = { K, HGA, regression, brier };
    }
  }
}

results.sort((a, b) => a.brier - b.brier);
console.log('=== Top 10 parameter combinations by Brier score ===');
results.slice(0, 10).forEach(r => console.log(`K=${r.K}  HGA=${r.HGA}  regression=${r.regression.toFixed(2)}  Brier=${r.brier.toFixed(4)}`));
console.log(`\nBest: K=${best.K}, HGA=${best.HGA}, regression=${best.regression.toFixed(2)}, Brier=${best.brier.toFixed(4)}`);
console.log(`(v1 defaults were K=24, HGA=30, regression=0.33)`);

fs.writeFileSync('data/elo_tuning.json', JSON.stringify({ best, top20: results.slice(0, 20) }, null, 2));
