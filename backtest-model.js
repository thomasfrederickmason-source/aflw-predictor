// Walk-forward backtest of the MATCH PREDICTOR itself -- which margin
// estimate to trust, and whether the per-team scores the board shows are
// consistent with it -- using only information available before each match.
//
// Every row joins pre-match quantities that already exist in data/:
//   * Elo: homeRatingPre / awayRatingPre (elo_history.json) -> eloDiff incl. HGA
//   * Score model: predHomeScore / predAwayScore (score_history.json)
//   * Ridge rating: predMargin (ridge_history.json, ridge-model.js)
//   * the actual result
// All are generated chronologically, so each row's predictions were
// made BEFORE that match's result was folded in. The only fitted things here
// (regression coefficients, residual SDs) are refit each season on earlier
// seasons only, then scored on that season -- never on the data they saw.
//
// Usage: node backtest-model.js   (writes data/model_params.json when run
// with --write; read by predict-round.js / betting-odds-model.js)

const fs = require('fs');
const elo = JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8'));
const score = JSON.parse(fs.readFileSync('data/score_history.json', 'utf8'));
const ridge = new Map(JSON.parse(fs.readFileSync('data/ridge_history.json', 'utf8')).map(r => [r.matchId, r.predMargin])); // ridge-model.js
const ridgeTotal = new Map(JSON.parse(fs.readFileSync('data/ridge_total_history.json', 'utf8')).map(r => [r.matchId, r.predTotal])); // ridge-model.js
const eloParams = JSON.parse(fs.readFileSync('data/elo_params.json', 'utf8'));
const HGA = eloParams.hga;
// Lineup strength vs the team's usual (player-value.js, added 2026-10-02) and
// the local-derby rule, so the blend is fitted on exactly what predict-round.js
// feeds it: a derby has no home advantage in the ridge margin either.
const { buildPlayerValues } = require('./player-value');
const { buildTeamHomeCities, getTravelAdjustment } = require('./travel-adjustment');
const lineups = buildPlayerValues().history;
const allMatches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const matchById = new Map(allMatches.map(m => [m.matchId, m]));
const homeCities = buildTeamHomeCities(allMatches);
const RIDGE_HGA = JSON.parse(fs.readFileSync('data/ridge_ratings.json', 'utf8')).hga;
const isDerby = id => { const m = matchById.get(id); const t = m && getTravelAdjustment(m.homeTeam, m.awayTeam, m.venueLocation, homeCities); return !!(t && t.isLocalDerby); };

const scoreById = new Map(score.map(s => [s.matchId, s]));
const rows = elo.map(e => {
  const s = scoreById.get(e.matchId);
  if (!s || !ridge.has(e.matchId) || !ridgeTotal.has(e.matchId)) return null;
  const year = Number((e.season.match(/\d{4}/) || [0])[0]);
  return {
    matchId: e.matchId, season: e.season, year, date: e.date,
    eloDiff: e.homeRatingPre + HGA - e.awayRatingPre,
    eloProb: e.homeWinProbModel,
    smHome: s.predHomeScore, smAway: s.predAwayScore,
    smMargin: s.predHomeScore - s.predAwayScore, smTotal: s.predHomeScore + s.predAwayScore,
    // live total: average of the scoring model's and the ridge total (2026-10-02,
    // total-candidates.js: 2024-26 MAE 17.31 vs 17.89, better every season)
    liveTotal: (s.predHomeScore + s.predAwayScore + ridgeTotal.get(e.matchId)) / 2,
    rmMargin: ridge.get(e.matchId),
    derby: isDerby(e.matchId),
    rmLive: ridge.get(e.matchId) - (isDerby(e.matchId) ? RIDGE_HGA : 0),
    eloDiffLive: e.homeRatingPre + HGA - e.awayRatingPre - (isDerby(e.matchId) ? HGA : 0),
    lineupNet: lineups.has(e.matchId) ? lineups.get(e.matchId).net : 0,
    home: e.homeScore, away: e.awayScore, margin: e.homeScore - e.awayScore, total: e.homeScore + e.awayScore,
    outcome: e.homeScore > e.awayScore ? 1 : e.homeScore < e.awayScore ? 0 : 0.5,
  };
}).filter(Boolean).sort((a, b) => new Date(a.date) - new Date(b.date));

// ── small stats kit ──
function ols(X, y) {
  // normal equations with a tiny ridge for stability; X rows include the intercept column
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let p = 0; p < k; p++) { b[p] += X[i][p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += X[i][p] * X[i][q]; }
  for (let p = 1; p < k; p++) A[p][p] += 1e-6;
  // gaussian elimination
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < k; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let q = c; q < k; q++) A[r][q] -= f * A[c][q]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}
const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const Phi = (x, m, s) => 0.5 * (1 + erf((x - m) / (s * Math.SQRT2)));
const brier = (p, o) => (p - o) ** 2;
const logloss = (p, o) => { const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return -(o * Math.log(c) + (1 - o) * Math.log(1 - c)); };

// Margin feature sets to compare. Each maps a row to a feature vector
// (intercept first); the prediction is OLS on the training seasons.
const MODELS = {
  'Elo only': r => [1, r.eloDiff],
  'Score model only': r => [1, r.smMargin],
  'Elo + score model': r => [1, r.eloDiff, r.smMargin],
  'Ridge only': r => [1, r.rmMargin],
  'Score + ridge': r => [1, r.smMargin, r.rmMargin],
  'Score + ridge + lineup (live)': r => [1, r.smMargin, r.rmLive, r.lineupNet],
};
// The blend averaged with Elo for the live win chance. Was 'Elo + score
// model' until 2026-10-02; the ridge version won the nested walk-forward test
// in rating-candidates.js (2024-26 Brier 0.1785 vs 0.1805).
// Lineup strength added 2026-10-02 (player-value.js).
const LIVE = 'Score + ridge + lineup (live)';

const years = [...new Set(rows.map(r => r.year))].sort();
const testYears = years.filter(y => y >= 2019); // need 2 seasons of history to fit on
const results = {};
for (const name of Object.keys(MODELS)) results[name] = { absErr: [], sqErr: [], brier: [], logloss: [], probs: [] };
const eloLogistic = { brier: [], logloss: [] };

for (const y of testYears) {
  const train = rows.filter(r => r.year < y), test = rows.filter(r => r.year === y);
  for (const [name, feat] of Object.entries(MODELS)) {
    const w = ols(train.map(feat), train.map(r => r.margin));
    const resid = train.map(r => r.margin - dot(w, feat(r)));
    const s = sd(resid);
    for (const r of test) {
      const mu = dot(w, feat(r));
      const p = 1 - Phi(0, mu, s); // P(margin > 0) = expected score, draw = half (2026-10-17)
      const R = results[name];
      R.absErr.push(Math.abs(r.margin - mu)); R.sqErr.push((r.margin - mu) ** 2);
      R.brier.push(brier(p, r.outcome)); if (r.outcome !== 0.5) R.logloss.push(logloss(p, r.outcome));
      R.probs.push({ p, o: r.outcome, year: y });
    }
  }
  for (const r of test) { eloLogistic.brier.push(brier(r.eloProb, r.outcome)); if (r.outcome !== 0.5) eloLogistic.logloss.push(logloss(r.eloProb, r.outcome)); }
}
const nTest = results['Elo only'].absErr.length;
console.log(`=== Margin / win-probability predictor, walk-forward by season (${testYears[0]}-${testYears[testYears.length - 1]}, ${nTest} test matches) ===`);
console.log('model'.padEnd(28) + 'margin MAE  RMSE    Brier   LogLoss');
console.log('Elo logistic prob (H2H now)'.padEnd(28) + '    -        -     ' + mean(eloLogistic.brier).toFixed(4) + '  ' + mean(eloLogistic.logloss).toFixed(4));
for (const [name, R] of Object.entries(results)) {
  console.log(name.padEnd(28) + mean(R.absErr).toFixed(2).padStart(8) + Math.sqrt(mean(R.sqErr)).toFixed(2).padStart(8) + '   ' + mean(R.brier).toFixed(4) + '  ' + mean(R.logloss).toFixed(4));
}
// Recent seasons matter most (the league changed a lot: 8 -> 18 teams, scoring up)
const recent = r => r.year >= 2024;
console.log('\n--- same, 2024-2026 test seasons only ---');
for (const [name, R] of Object.entries(results)) {
  const idx = R.probs.map((x, i) => (x.year >= 2024 ? i : -1)).filter(i => i >= 0);
  const pick = arr => idx.map(i => arr[i]);
  console.log(name.padEnd(28) + mean(pick(R.absErr)).toFixed(2).padStart(8) + Math.sqrt(mean(pick(R.sqErr))).toFixed(2).padStart(8) + '   ' + mean(pick(R.brier)).toFixed(4));
}

// The live H2H is Elo's own logistic probability. Compare it, the blend's
// normal-margin probability, and a 50/50 average of the two, on the recent
// era specifically -- 18 teams since 2023, scoring up; older seasons are a
// different competition.
{
  const blendProbs = results[LIVE].probs;
  const oldProbs = results['Elo + score model'].probs; // the blend before 2026-10-02
  const recentIdx = blendProbs.map((x, i) => (x.year >= 2024 ? i : -1)).filter(i => i >= 0);
  const testRows = rows.filter(r => r.year >= testYears[0]);
  const rec = recentIdx.map(i => ({ elo: testRows[i].eloProb, blend: blendProbs[i].p, old: oldProbs[i].p, o: blendProbs[i].o }));
  const score = f => ({ b: mean(rec.map(x => brier(f(x), x.o))), l: mean(rec.filter(x => x.o !== 0.5).map(x => logloss(f(x), x.o))) });
  const e = score(x => x.elo), b = score(x => x.blend), avg = score(x => (x.elo + x.blend) / 2), oldAvg = score(x => (x.elo + x.old) / 2);
  console.log('\n--- win probability, 2024-2026 (' + rec.length + ' matches) ---');
  console.log(`Elo logistic (current H2H)   Brier ${e.b.toFixed(4)}  LogLoss ${e.l.toFixed(4)}`);
  console.log(`score + ridge blend (normal) Brier ${b.b.toFixed(4)}  LogLoss ${b.l.toFixed(4)}`);
  console.log(`average of the two (LIVE)    Brier ${avg.b.toFixed(4)}  LogLoss ${avg.l.toFixed(4)}`);
  console.log(`old live: avg(Elo, Elo+score) Brier ${oldAvg.b.toFixed(4)}  LogLoss ${oldAvg.l.toFixed(4)}`);
  // Same three over the WHOLE walk-forward period, so the recent-era pick
  // isn't cherry-picked from a window where it happens to look good.
  const all = blendProbs.map((x, i) => ({ elo: testRows[i].eloProb, blend: x.p, o: x.o, year: x.year }));
  const scoreAll = f => ({ b: mean(all.map(x => brier(f(x), x.o))), l: mean(all.filter(x => x.o !== 0.5).map(x => logloss(f(x), x.o))) });
  const ea = scoreAll(x => x.elo), ba = scoreAll(x => x.blend), aa = scoreAll(x => (x.elo + x.blend) / 2);
  console.log(`--- same, all ${all.length} test matches 2019-2026 ---`);
  console.log(`Elo logistic ${ea.b.toFixed(4)}/${ea.l.toFixed(4)}  blend ${ba.b.toFixed(4)}/${ba.l.toFixed(4)}  average ${aa.b.toFixed(4)}/${aa.l.toFixed(4)}  (Brier/LogLoss)`);
  for (const y of testYears) {
    const ys = all.filter(x => x.year === y);
    const B = f => mean(ys.map(x => brier(f(x), x.o))).toFixed(4);
    console.log(`  ${y}: n=${String(ys.length).padStart(3)}  Elo ${B(x => x.elo)}  average ${B(x => (x.elo + x.blend) / 2)}`);
  }
}

// Margin SPREAD check: the board turns the H2H prob into a margin
// distribution (mean solved from the prob, fixed SD). Is SD 24.90 right for
// the current era? PIT test: each actual margin's percentile under the
// predicted distribution should be uniform across 10 bins.
{
  const invPhi = p => { // bisection is plenty here
    let lo = -10, hi = 10; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (Phi(m, 0, 1) < p) lo = m; else hi = m; } return (lo + hi) / 2;
  };
  const recentRows = rows.filter(r => r.year >= 2024);
  console.log('\n--- margin spread (PIT uniformity, 2024-2026, ' + recentRows.length + ' matches) ---');
  for (const SD of [24.9, 26.0, 26.5, 27.0, 28.0]) {
    const bins = new Array(10).fill(0);
    let ll = 0;
    for (const r of recentRows) {
      const mu = SD * invPhi(r.eloProb); // the board's effectiveMargin: P(margin > 0) = win chance
      const u = Phi(r.margin, mu, SD);
      bins[Math.min(9, Math.floor(u * 10))]++;
      ll += -0.5 * ((r.margin - mu) / SD) ** 2 - Math.log(SD);
    }
    const exp = recentRows.length / 10;
    const chi = bins.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    console.log(`  SD ${SD.toFixed(1)}: PIT chi2 ${chi.toFixed(2)} (pass < 16.9)  mean log-lik ${(ll / recentRows.length).toFixed(4)}  tails ${bins[0]}/${bins[9]} of ~${exp.toFixed(0)}`);
  }
  const totResid = recentRows.map(r => r.total - r.liveTotal), smResid = recentRows.map(r => r.total - r.smTotal);
  console.log(`  match-total residual SD 2024+: ${sd(totResid).toFixed(2)} (scoring model alone ${sd(smResid).toFixed(2)}), bias ${mean(totResid).toFixed(2)}, MAE ${mean(totResid.map(Math.abs)).toFixed(2)} vs ${mean(smResid.map(Math.abs)).toFixed(2)}`);
}

// Calibration of the chosen blend: predicted vs observed home-win rate by decile
function calibrationTable(probs) {
  const sorted = probs.slice().sort((a, b) => a.p - b.p);
  const out = [];
  for (let d = 0; d < 10; d++) {
    const chunk = sorted.slice(Math.floor(d * sorted.length / 10), Math.floor((d + 1) * sorted.length / 10));
    out.push({ pred: mean(chunk.map(c => c.p)), obs: mean(chunk.map(c => c.o)), n: chunk.length });
  }
  return out;
}
console.log('\n--- calibration (' + LIVE + '), deciles of predicted home-win prob ---');
let chi = 0;
for (const b of calibrationTable(results[LIVE].probs)) {
  const se = Math.sqrt(b.pred * (1 - b.pred) / b.n); chi += ((b.obs - b.pred) / se) ** 2;
  console.log(`  pred ${(b.pred * 100).toFixed(1).padStart(5)}%  observed ${(b.obs * 100).toFixed(1).padStart(5)}%  (n=${b.n})`);
}
console.log(`  chi-square over 10 deciles: ${chi.toFixed(2)} (95% threshold for 10 bins ~ 18.3)`);

// ── Team scores: raw score-model vs coherent (total +/- margin)/2 ──
// Coherent = the per-team scores that reproduce the SAME margin the H2H/line
// markets use and the SAME total the totals market uses.
const errRaw = [], errCoh = [];
for (const y of testYears) {
  const train = rows.filter(r => r.year < y);
  const w = ols(train.map(MODELS[LIVE]), train.map(r => r.margin));
  for (const r of rows.filter(x => x.year === y)) {
    const m = dot(w, MODELS[LIVE](r));
    const cohHome = (r.liveTotal + m) / 2, cohAway = (r.liveTotal - m) / 2;
    errRaw.push(r.home - r.smHome, r.away - r.smAway);
    errCoh.push(r.home - cohHome, r.away - cohAway);
  }
}
console.log('\n=== Team scores (both teams, every test match) ===');
console.log(`raw score-model team score   MAE ${mean(errRaw.map(Math.abs)).toFixed(2)}  bias ${mean(errRaw).toFixed(2)}  SD ${sd(errRaw).toFixed(2)}`);
console.log(`coherent (total +/- margin)/2 MAE ${mean(errCoh.map(Math.abs)).toFixed(2)}  bias ${mean(errCoh).toFixed(2)}  SD ${sd(errCoh).toFixed(2)}`);
const skewOf = a => { const m = mean(a), s = sd(a); return mean(a.map(v => ((v - m) / s) ** 3)); };
console.log(`coherent residual skew ${skewOf(errCoh).toFixed(3)} (raw ${skewOf(errRaw).toFixed(3)})`);

// Final fit on everything up to now -- what the live model should use.
const allW = ols(rows.map(MODELS[LIVE]), rows.map(r => r.margin));
const allResidSD = sd(rows.map(r => r.margin - dot(allW, MODELS[LIVE](r))));
const recentRows = rows.filter(r => r.year >= 2024);
const recentResidSD = sd(recentRows.map(r => r.margin - dot(allW, MODELS[LIVE](r))));
const cohRecent = []; recentRows.forEach(r => { const m = dot(allW, MODELS[LIVE](r)); cohRecent.push(r.home - (r.liveTotal + m) / 2, r.away - (r.liveTotal - m) / 2); });
console.log('\n=== Live parameters (fit on all ' + rows.length + ' matches) ===');
console.log(`margin = ${allW[0].toFixed(3)} + ${allW[1].toFixed(4)} * scoreModelMargin + ${allW[2].toFixed(4)} * ridgeMargin + ${allW[3].toFixed(4)} * lineupNet`);
console.log(`margin residual SD: ${allResidSD.toFixed(2)} all-time, ${recentResidSD.toFixed(2)} 2024+`);
console.log(`coherent team-score residual SD (2024+): ${sd(cohRecent).toFixed(2)}, skew ${skewOf(cohRecent).toFixed(3)}`);

// ── The live model, exactly as predict-round.js / betting-odds-model.js run it ──
// 1. win prob = average of Elo's logistic prob and the score-model + ridge
//    margin blend's normal prob (rating-candidates.js: nested walk-forward
//    winner on 2024-26 -- see above);
// 2. one margin distribution per match: Normal(effective margin, SD), the
//    mean solved so P(margin > 0) matches (1) exactly -- (1) is an expected
//    score, draws counting half, like Australian dead-heat rules (since
//    2026-10-17; it used to solve P(margin > 0.5)) -- SD chosen here by
//    maximum likelihood on the modern era (2024+);
// 3. per-team scores = (total +/- effective margin)/2, total from the score
//    model -- so the scores shown, the line and the H2H all agree.
function invPhiStd(p) { let lo = -10, hi = 10; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (Phi(m, 0, 1) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
const testRowsAll = rows.filter(r => r.year >= testYears[0]);
// Elo half as predict-round.js computes it: derby rule, plus the lineup shift
// converted to Elo points.
const eloLive = r => 1 / (1 + Math.pow(10, -(r.eloDiffLive + allW[3] * r.lineupNet / eloParams.marginSlope) / 400));
const ensembleRows = results[LIVE].probs.map((x, i) => ({ ...testRowsAll[i], pEns: (eloLive(testRowsAll[i]) + x.p) / 2 }));
{
  const rec = ensembleRows.filter(r => r.year >= 2024);
  console.log(`
LIVE win chance as predict-round.js computes it, 2024-26: Brier ${mean(rec.map(r => brier(r.pEns, r.outcome))).toFixed(4)}  LogLoss ${mean(rec.filter(r => r.outcome !== 0.5).map(r => logloss(r.pEns, r.outcome))).toFixed(4)}  (n=${rec.length}; team-news career-games shift not included)`);
}
const modern = ensembleRows.filter(r => r.year >= 2024);
let bestSD = null, bestLL = -Infinity;
for (let s = 22; s <= 32.001; s += 0.25) {
  let ll = 0;
  for (const r of modern) { const mu = s * invPhiStd(r.pEns); ll += -0.5 * ((r.margin - mu) / s) ** 2 - Math.log(s); }
  if (ll > bestLL) { bestLL = ll; bestSD = s; }
}
const cohModern = [];
const bins = new Array(10).fill(0);
for (const r of modern) {
  const m = bestSD * invPhiStd(r.pEns);
  cohModern.push(r.home - (r.liveTotal + m) / 2, r.away - (r.liveTotal - m) / 2);
  bins[Math.min(9, Math.floor(Phi(r.margin, m, bestSD) * 10))]++;
}
const expBin = modern.length / 10;
const pitChi = bins.reduce((s, c) => s + (c - expBin) ** 2 / expBin, 0);
const totalResidModern = modern.map(r => r.total - r.liveTotal);
console.log(`\n=== Live model params (modern era 2024+, n=${modern.length}) ===`);
console.log(`full-game margin SD (max likelihood): ${bestSD.toFixed(2)}  -- PIT chi2 ${pitChi.toFixed(2)} (pass < 16.9)`);
console.log(`match total residual SD: ${sd(totalResidModern).toFixed(2)}`);
console.log(`team score residual SD: ${sd(cohModern).toFixed(2)}, skew ${skewOf(cohModern).toFixed(3)}`);

function halfSpreads() {
  const modernIds = new Set(modern.map(r => r.matchId));
  const ms = allMatches.filter(m => modernIds.has(m.matchId) && m.homeQtr && m.awayQtr && m.homeQtr.every(v => v != null) && m.awayQtr.every(v => v != null));
  return {
    h1TotalSD: +sd(ms.map(m => m.homeQtr[0] + m.homeQtr[1] + m.awayQtr[0] + m.awayQtr[1])).toFixed(2),
    q1TotalSD: +sd(ms.map(m => m.homeQtr[0] + m.awayQtr[0])).toFixed(2),
    n: ms.length,
  };
}
console.log(`1st-half / 1st-quarter total spreads (2024+): ${halfSpreads().h1TotalSD} / ${halfSpreads().q1TotalSD}`);

if (process.argv.includes('--write')) {
  // Merge: keep sections other scripts own (roster-backtest.js writes .roster).
  const prev = fs.existsSync('data/model_params.json') ? JSON.parse(fs.readFileSync('data/model_params.json', 'utf8')) : {};
  const params = {
    ...prev,
    fittedAt: new Date().toISOString(), matches: rows.length, modernEraMatches: modern.length,
    hga: HGA,
    // margin blend used for the second half of the win-prob average
    blend: { intercept: allW[0], scoreModelMargin: allW[1], ridgeMargin: allW[2], lineupNet: allW[3], residualSD: +allResidSD.toFixed(2) },
    fullMarginSD: bestSD,
    matchTotalSD: +sd(totalResidModern).toFixed(2),
    teamScore: { residualSD: +sd(cohModern).toFixed(2), skew: +skewOf(cohModern).toFixed(3) },
    // 1st-half / 1st-quarter TOTAL spreads (betting-odds-model.js), re-measured
    // weekly on the modern era like the full-game ones. They were constants
    // from August (12.87 / 9.18) and had drifted narrow as scoring rose
    // (2024-26 on 2026-10-17: 13.47 / 9.37). Raw spread, as when they were
    // validated: the model barely explains a game's scoring pace at that level.
    halves: halfSpreads(),
  };
  fs.writeFileSync('data/model_params.json', JSON.stringify(params, null, 1));
  console.log('\nWritten: data/model_params.json');
}
