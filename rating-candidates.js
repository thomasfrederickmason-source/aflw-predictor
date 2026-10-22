// Walk-forward test of candidate team ratings against the live model
// (Tom, 2026-10-02: "make sure the model is the best it can be").
//
// The live win chance averages Elo's logistic probability with a margin
// blend (OLS on Elo gap + scoring-model margin, refit each season on earlier
// seasons). Elo moves one game at a time with K=40, so it lurches after
// upsets. The candidate here is a decayed RIDGE ("Massey") rating: before each
// match, refit every team's rating to the margins of ALL earlier matches at
// once, weighting recent rounds most and earlier seasons less, with a ridge
// pull to the league average for teams with little data. It's only allowed
// to see matches that started before the one being predicted.
//
// Hyperparameters are tuned on 2019-2023 only; the verdict is read on
// 2024-2026, which the tuning never saw.
//
// Usage: node rating-candidates.js            (prints the comparison)
//        node rating-candidates.js --write    (writes data/massey_history.json
//                                              + data/massey_params.json)

const fs = require('fs');
const WRITE = process.argv.includes('--write');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeScore != null && m.awayScore != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));
const elo = new Map(JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8')).map(e => [e.matchId, e]));
const score = new Map(JSON.parse(fs.readFileSync('data/score_history.json', 'utf8')).map(s => [s.matchId, s]));
const HGA_ELO = JSON.parse(fs.readFileSync('data/elo_params.json', 'utf8')).hga;

// Season order by first match date (2022 had two seasons) and a global round
// counter that ticks once per distinct (season, round).
const seasonFirst = {};
for (const m of matches) if (!(m.season in seasonFirst)) seasonFirst[m.season] = new Date(m.date).getTime();
const seasonIdx = Object.fromEntries(Object.keys(seasonFirst).sort((a, b) => seasonFirst[a] - seasonFirst[b]).map((s, i) => [s, i]));
const roundKey = m => m.season + '|' + m.round;
const roundIdx = {};
let g = 0;
for (const m of matches) if (!(roundKey(m) in roundIdx)) roundIdx[roundKey(m)] = g++;
const year = m => Number((m.season.match(/\d{4}/) || [0])[0]);

// ── decayed ridge ratings ──
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; if (!f) continue; for (let q = c; q < n; q++) A[r][q] -= f * A[c][q]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}
// Returns Map matchId -> { pred (home margin), ratings snapshot not kept }
function massey({ tau, gamma, lambda }) {
  const out = new Map();
  const teams = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]))];
  const ti = Object.fromEntries(teams.map((t, i) => [t, i]));
  const K = teams.length + 1; // + HGA
  let lastFitAt = -1, fit = null;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const t0 = new Date(m.date).getTime();
    if (t0 !== lastFitAt) {
      const A = Array.from({ length: K }, () => new Array(K).fill(0));
      const b = new Array(K).fill(0);
      let any = false;
      for (let j = 0; j < i; j++) {
        const p = matches[j];
        if (new Date(p.date).getTime() >= t0) break;
        const gap = seasonIdx[m.season] - seasonIdx[p.season];
        const age = roundIdx[roundKey(m)] - roundIdx[roundKey(p)];
        const w = Math.pow(gamma, gap) * Math.exp(-age / tau);
        if (w < 1e-6) continue;
        any = true;
        const h = ti[p.homeTeam], a = ti[p.awayTeam], H = K - 1;
        const y = p.homeScore - p.awayScore;
        // x = e_h - e_a + e_H
        const idx = [h, a, H], val = [1, -1, 1];
        for (let u = 0; u < 3; u++) { b[idx[u]] += w * val[u] * y; for (let v = 0; v < 3; v++) A[idx[u]][idx[v]] += w * val[u] * val[v]; }
      }
      for (let k = 0; k < K - 1; k++) A[k][k] += lambda;
      A[K - 1][K - 1] += 1; // light pull on HGA too
      fit = any ? solve(A, b) : new Array(K).fill(0);
      lastFitAt = t0;
    }
    out.set(m.matchId, fit[ti[m.homeTeam]] - fit[ti[m.awayTeam]] + fit[K - 1]);
  }
  return out;
}

// ── shared stats ──
function ols(X, y) {
  const k = X[0].length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let p = 0; p < k; p++) { b[p] += X[i][p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += X[i][p] * X[i][q]; }
  for (let p = 1; p < k; p++) A[p][p] += 1e-6;
  return solve(A, b);
}
const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const Phi = (x, m, s) => 0.5 * (1 + erf((x - m) / (s * Math.SQRT2)));
const brier = (p, o) => (p - o) ** 2;
const logloss = (p, o) => { const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return -(o * Math.log(c) + (1 - o) * Math.log(1 - c)); };

function rowsWith(ms) {
  return matches.map(m => {
    const e = elo.get(m.matchId), s = score.get(m.matchId);
    if (!e || !s) return null;
    return {
      id: m.matchId, year: year(m), season: m.season,
      eloDiff: e.homeRatingPre + HGA_ELO - e.awayRatingPre, eloProb: e.homeWinProbModel,
      smMargin: s.predHomeScore - s.predAwayScore,
      ms: ms ? ms.get(m.matchId) : 0,
      margin: m.homeScore - m.awayScore,
      o: m.homeScore > m.awayScore ? 1 : m.homeScore < m.awayScore ? 0 : 0.5,
    };
  }).filter(Boolean);
}

// Walk-forward by test year: fit OLS margin model on earlier years, score.
function walk(rows, feat, years) {
  const res = [];
  for (const y of years) {
    const train = rows.filter(r => r.year < y), test = rows.filter(r => r.year === y);
    if (!test.length) continue;
    const w = ols(train.map(feat), train.map(r => r.margin));
    const s = sd(train.map(r => r.margin - dot(w, feat(r))));
    for (const r of test) { const mu = dot(w, feat(r)); res.push({ ...r, mu, p: 1 - Phi(0.5, mu, s) }); }
  }
  return res;
}
const summ = (res, pf = x => x.p) => ({
  n: res.length,
  mae: mean(res.map(x => Math.abs(x.margin - x.mu))),
  brier: mean(res.map(x => brier(pf(x), x.o))),
  ll: mean(res.filter(x => x.o !== 0.5).map(x => logloss(pf(x), x.o))),
});
const fmt = s => `n=${s.n}  MAE ${s.mae.toFixed(2)}  Brier ${s.brier.toFixed(4)}  LogLoss ${s.ll.toFixed(4)}`;

// ── 1. nested walk-forward: for each test season, tune the ridge rating's
// settings on EARLIER seasons only (as the weekly run will), then score it.
// Live structure A (adopted if it wins): win% = average of Elo's logistic and
// a normal-margin blend of [scoring-model margin, ridge margin].
const GRID = [];
for (const tau of [12, 20, 40, 80, 1e9]) for (const gamma of [0.05, 0.1, 0.2, 0.35, 0.5]) for (const lambda of [0.25, 0.5, 1, 2, 4]) GRID.push({ tau, gamma, lambda });
const cache = new Map();
const rowsFor = hp => { const k = JSON.stringify(hp); if (!cache.has(k)) cache.set(k, rowsWith(massey(hp))); return cache.get(k); };
function tune(years) {
  let best = null;
  for (const hp of GRID) {
    const s = summ(walk(rowsFor(hp), r => [1, r.ms], years));
    if (!best || s.brier < best.s.brier) best = { hp, s };
  }
  return best;
}
const FEAT_A = r => [1, r.smMargin, r.ms];
const FEAT_B = r => [1, r.eloDiff, r.smMargin, r.ms];
const FEAT_LIVE = r => [1, r.eloDiff, r.smMargin];
const TEST_YEARS = [2024, 2025, 2026];
const out = { live: [], A: [], B: [], eloOnly: [] };
const t0 = Date.now();
for (const y of TEST_YEARS) {
  const tuneYears = [2019, 2020, 2021, 2022, 2023, 2024, 2025].filter(x => x < y);
  const best = tune(tuneYears);
  const rows = rowsFor(best.hp);
  const liveRes = walk(rows, FEAT_LIVE, [y]).map(x => ({ ...x, p: (x.eloProb + x.p) / 2 }));
  const aRes = walk(rows, FEAT_A, [y]).map(x => ({ ...x, p: (x.eloProb + x.p) / 2 }));
  const bRes = walk(rows, FEAT_B, [y]).map(x => ({ ...x, p: (x.eloProb + x.p) / 2 }));
  out.live.push(...liveRes); out.A.push(...aRes); out.B.push(...bRes);
  out.eloOnly.push(...liveRes.map(x => ({ ...x, p: x.eloProb })));
  console.log(`${y}: settings tuned on ${tuneYears[0]}-${tuneYears[tuneYears.length - 1]} -> tau=${best.hp.tau >= 1e9 ? 'none' : best.hp.tau} gamma=${best.hp.gamma} lambda=${best.hp.lambda}` +
    `   Brier live ${summ(liveRes).brier.toFixed(4)}  A ${summ(aRes).brier.toFixed(4)}  B ${summ(bRes).brier.toFixed(4)}`);
}
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)\n\nNested walk-forward, ${TEST_YEARS.join('-')}:`);
console.log('  Elo logistic alone'.padEnd(46) + fmt(summ(out.eloOnly)));
console.log('  LIVE  avg(Elo, [Elo gap, score margin])'.padEnd(46) + fmt(summ(out.live)));
console.log('  A     avg(Elo, [score margin, ridge])'.padEnd(46) + fmt(summ(out.A)));
console.log('  B     avg(Elo, [Elo gap, score, ridge])'.padEnd(46) + fmt(summ(out.B)));

// Calibration of A: predicted vs actual home-win rate by probability band.
console.log('\nCalibration of A (home win %, predicted vs actual):');
for (const [lo, hi] of [[0, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 1.01]]) {
  const b = out.A.filter(x => x.p >= lo && x.p < hi);
  if (!b.length) continue;
  console.log(`  ${(lo * 100).toFixed(0).padStart(3)}-${Math.min(100, hi * 100).toFixed(0).padEnd(3)}%  n=${String(b.length).padStart(3)}  predicted ${(mean(b.map(x => x.p)) * 100).toFixed(1)}%  actual ${(mean(b.map(x => x.o)) * 100).toFixed(1)}%`);
}

// Settings for live use: tuned on every completed season before the current one.
const CURRENT = Math.max(...matches.map(year));
const liveTune = tune([2019, 2020, 2021, 2022, 2023, 2024, 2025].filter(x => x < CURRENT));
console.log(`\nLive settings for ${CURRENT} (tuned on 2019-${CURRENT - 1}): tau=${liveTune.hp.tau >= 1e9 ? 'none' : liveTune.hp.tau} gamma=${liveTune.hp.gamma} lambda=${liveTune.hp.lambda}`);
if (WRITE) {
  const ms = massey(liveTune.hp);
  fs.writeFileSync('data/massey_params.json', JSON.stringify({ ...liveTune.hp, tunedOn: '2019-' + (CURRENT - 1), fittedAt: new Date().toISOString() }, null, 1));
  fs.writeFileSync('data/massey_history.json', JSON.stringify(matches.map(m => ({ matchId: m.matchId, season: m.season, round: m.round, date: m.date, homeTeam: m.homeTeam, awayTeam: m.awayTeam, predMargin: ms.get(m.matchId) }))));
  console.log('Written data/massey_params.json + data/massey_history.json');
}
