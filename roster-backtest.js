// Walk-forward test of the team-news (unplanned outs) adjustment: does it
// actually improve predictions, and which kinds of outs should count?
//
// roster-signal-check.js established a correlation (r~0.10); this asks the
// question that matters for pricing -- scored season by season on matches the
// slope never saw, does shifting the prediction by slope * net career games
// of players out lower margin error and Brier score? Career games are counted
// POINT-IN-TIME (only games before each match), unlike the live adjustment's
// "games as of now" shortcut.
//
// Usage: node roster-backtest.js

const fs = require('fs');
const rosters = JSON.parse(fs.readFileSync('data/rosters.json', 'utf8'));
const elo = JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8'));
const { normalCDF } = require('./stats');

const VARIANTS = {
  'every out except Managed (live now)': r => r !== 'Managed',
  'unplanned only (no Managed, no Omitted)': r => r !== 'Managed' && r !== 'Omitted',
  'injury/illness/suspension only': r => ['Injured', 'Illness', 'Suspension'].includes(r),
};

// point-in-time career games + per-match net importance for each variant
const games = new Map();
const rows = [];
for (const e of elo) { // elo_history is chronological
  const ro = rosters[e.matchId];
  if (ro && ro.homeTeam && ro.awayTeam) {
    const net = {};
    for (const [name, keep] of Object.entries(VARIANTS)) {
      const imp = side => (side.outs || []).filter(o => keep(o.reason)).reduce((s, o) => s + (games.get(o.playerId) || 0), 0);
      net[name] = imp(ro.awayTeam) - imp(ro.homeTeam); // + = home advantaged
    }
    const year = Number((e.season.match(/\d{4}/) || [0])[0]);
    // Elo-only margin prediction from the Elo line (fitted per season below)
    rows.push({ year, eloDiff: e.homeRatingPre + 15 - e.awayRatingPre, margin: e.homeScore - e.awayScore,
      outcome: e.homeScore > e.awayScore ? 1 : e.homeScore < e.awayScore ? 0 : 0.5, net });
  }
  if (ro) for (const side of [ro.homeTeam, ro.awayTeam]) if (side) for (const p of side.positions || []) games.set(p.playerId, (games.get(p.playerId) || 0) + 1);
}

function fit(xs, ys) { // simple OLS y = a + b x
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0; // no outs recorded yet (earliest seasons) -> no adjustment
  return { a: my - b * mx, b };
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const years = [...new Set(rows.map(r => r.year))].sort().filter(y => y >= 2019);
console.log(`Team-news adjustment, walk-forward ${years[0]}-${years[years.length - 1]} (${rows.filter(r => r.year >= years[0]).length} matches with team sheets)\n`);
console.log('variant'.padEnd(42) + 'slope/game  margin MAE  Brier    (no adjustment: MAE / Brier)');
for (const name of Object.keys(VARIANTS)) {
  const errBase = [], errAdj = [], brBase = [], brAdj = [], slopes = [];
  for (const y of years) {
    const train = rows.filter(r => r.year < y), test = rows.filter(r => r.year === y);
    const eloLine = fit(train.map(r => r.eloDiff), train.map(r => r.margin));
    const resid = train.map(r => r.margin - (eloLine.a + eloLine.b * r.eloDiff));
    const sd = Math.sqrt(mean(resid.map(v => v * v)));
    const rl = fit(train.map(r => r.net[name]), resid); // slope of residual on net importance
    slopes.push(rl.b);
    for (const r of test) {
      const base = eloLine.a + eloLine.b * r.eloDiff, adj = base + rl.b * r.net[name];
      errBase.push(Math.abs(r.margin - base)); errAdj.push(Math.abs(r.margin - adj));
      brBase.push((1 - normalCDF(0, base, sd) - r.outcome) ** 2); brAdj.push((1 - normalCDF(0, adj, sd) - r.outcome) ** 2); // P(margin > 0) = expected score
    }
  }
  console.log(name.padEnd(42) + mean(slopes).toFixed(4).padStart(9) + mean(errAdj).toFixed(3).padStart(12) + mean(brAdj).toFixed(4).padStart(9) +
    `    (${mean(errBase).toFixed(3)} / ${mean(brBase).toFixed(4)})`);
}
// Full-history slope for the variant(s), with a rough standard error
for (const name of Object.keys(VARIANTS)) {
  const all = rows;
  const eloLine = fit(all.map(r => r.eloDiff), all.map(r => r.margin));
  const resid = all.map(r => r.margin - (eloLine.a + eloLine.b * r.eloDiff));
  const xs = all.map(r => r.net[name]); const rl = fit(xs, resid);
  const res2 = resid.map((v, i) => v - (rl.a + rl.b * xs[i]));
  const mx = mean(xs); const se = Math.sqrt(mean(res2.map(v => v * v)) / xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  console.log(`  full-history slope, ${name}: ${rl.b.toFixed(4)} pts/game (SE ${se.toFixed(4)}, t=${(rl.b / se).toFixed(1)})`);
}

// --write: store the live settings (the variant that tested best) where
// roster-adjustment.js reads them, merged into data/model_params.json.
if (process.argv.includes('--write')) {
  const LIVE = 'unplanned only (no Managed, no Omitted)';
  const all = rows;
  const eloLine = fit(all.map(r => r.eloDiff), all.map(r => r.margin));
  const resid = all.map(r => r.margin - (eloLine.a + eloLine.b * r.eloDiff));
  const rl = fit(all.map(r => r.net[LIVE]), resid);
  const path = 'data/model_params.json';
  const params = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
  params.roster = {
    slopePerCareerGame: +rl.b.toFixed(4),
    countedReasons: ['Injured', 'Illness', 'Suspension', 'Personal Reason'], // not Managed (planned rest), not Omitted (dropped for form)
    fittedOn: all.length, fittedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path, JSON.stringify(params, null, 1));
  console.log(`\nWritten: team-news settings to ${path} (slope ${params.roster.slopePerCareerGame} pts per career game, ${params.roster.countedReasons.join('/')})`);
}
