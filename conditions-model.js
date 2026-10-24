// Match-conditions adjustment to the predicted TOTAL: wind, rain and kickoff
// time, fitted on the MODEL's own total error (added 2026-10-17 peer review).
//
// Why this replaced the old fixed weather constants (-0.517 pts per km/h of
// wind, -9.5 for rain): those were fitted on raw totals minus the season
// average, in-sample, before the ratings existed. The ratings already know a
// lot of that (a team that plays at a windy ground has its attack rated down),
// so on top of the live model they double-counted: with archived weather, the
// old adjustment made 2024-26 totals WORSE (MAE 16.79 vs 16.51 without it).
// It also missed the biggest pattern left in the totals: scoring falls steadily
// with kickoff time (2023-26 residual +7.8 before 1pm, +3.1 1-3pm, +0.8 3-5pm,
// -4.3 6-7pm, -6.4 after 7pm). Night games are calmer, so the old wind term
// pushed night totals UP, the wrong way.
//
// The fix: one regression of (actual total - model total) on wind, a rain
// flag and kickoff hour, on every match since 2019 with archived match-window
// weather (Open-Meteo archive, rain rescaled to BOM's daily total:
// fetch-openmeteo-historical.js). Each feature is centred on its training mean,
// so the adjustment averages zero and the overall scoring level still comes
// from the ratings. Walk-forward (fit on earlier seasons only), printed below.
//
// Live use (predict-round.js via weather-adjustment.js): kickoff hour is known
// exactly; rain enters as the forecast CHANCE of rain times the rain effect
// (an expected value; the old code ignored the probability and switched the
// full step on or off from the deterministic forecast); forecast wind is
// shrunk 20% toward the training mean, because forecast wind regresses that
// much onto the archived value (2026 rounds 3-10: slope 0.80, corr 0.85).
//
// Rain AMOUNT (2026-10-24): the on/off rain flag became log(1 + mm of rain in
// the match window). Wet games' residuals grow with the amount (0.1-1mm -8.3,
// 1-3mm -18.5, 3mm+ -27.7, n=40/12/2), and walk-forward 2022-26 the amount
// beats the flag: all games MAE 16.86 vs 16.98, wet games 18.00 vs 19.30.
// Live, the term is the forecast chance of rain times log(1 + forecast mm),
// with at least 0.5mm (a typical wet game) assumed when it does rain.
//
// SUPERSEDED for live use 2026-10-25: that walk-forward fed in the rain that
// actually fell, which the board never knows. On archived FORECASTS the same
// slope over-cut wet games (worse than no rain term at all), so the live rain
// term is now fitted on forecasts by forecast-rain-fit.js (capped at 1mm) and
// stored as conditions.forecastRain. This fit still sets wind and kickoff time.
//
// Writes the coefficients to data/model_params.json (.conditions).
// Usage: node conditions-model.js [--write]

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8')).sort((a, b) => new Date(a.date) - new Date(b.date));
const score = new Map(JSON.parse(fs.readFileSync('data/score_history.json', 'utf8')).map(s => [s.matchId, s]));
const ridgeTot = new Map(JSON.parse(fs.readFileSync('data/ridge_total_history.json', 'utf8')).map(s => [s.matchId, s.predTotal]));
const om = JSON.parse(fs.readFileSync('data/openmeteo_historical.json', 'utf8'));
const venues = (v => (Array.isArray(v) ? v : v.venues))(JSON.parse(fs.readFileSync('data/venues_raw.json', 'utf8')));
const tzByVenue = Object.fromEntries(venues.map(v => [v.providerId, v.timezone]));
const STATE_TZ = { VIC: 'Australia/Melbourne', NSW: 'Australia/Sydney', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', WA: 'Australia/Perth', TAS: 'Australia/Hobart', NT: 'Australia/Darwin', ACT: 'Australia/Sydney' };
const year = m => Number((m.season.match(/\d{4}/) || [0])[0]);
const { localHour } = require('./weather-adjustment');

const FROM = 2019;          // first season with dependable match-window weather and ratings
const RAIN_MM = 0.1;        // "it rained during the match"
const FEATS = ['wind', 'rainLog', 'hour'];

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function solve(M, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (!f) continue; for (let q = c; q < n; q++) M[r][q] -= f * M[c][q]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / M[i][i]);
}

const rows = [];
for (const m of matches) {
  const s = score.get(m.matchId), rt = ridgeTot.get(m.matchId), w = om[m.matchId];
  if (!s || rt == null || !w || w.duringMatchWindKmh == null) continue;
  const tz = tzByVenue[m.venue] || STATE_TZ[m.venueState] || 'Australia/Melbourne';
  rows.push({
    y: year(m), base: (s.predHomeScore + s.predAwayScore + rt) / 2, act: m.homeScore + m.awayScore,
    wind: w.duringMatchWindKmh, rain: w.duringMatchRainMm > RAIN_MM ? 1 : 0, rainLog: Math.log1p(w.duringMatchRainMm > RAIN_MM ? w.duringMatchRainMm : 0), hour: localHour(new Date(m.date).getTime(), tz),
  });
}

// Fit on `train`: returns { means, coef } with features centred on the training means.
function fit(train) {
  const means = Object.fromEntries(FEATS.map(f => [f, mean(train.map(r => r[f]))]));
  const k = FEATS.length + 1, M = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (const r of train) {
    const x = [1, ...FEATS.map(f => r[f] - means[f])], y = r.act - r.base;
    for (let p = 0; p < k; p++) { b[p] += x[p] * y; for (let q = 0; q < k; q++) M[p][q] += x[p] * x[q]; }
  }
  const w = solve(M, b);
  // standard errors, for the printout
  const res = train.map(r => r.act - r.base - w.reduce((s, v, i) => s + v * (i ? r[FEATS[i - 1]] - means[FEATS[i - 1]] : 1), 0));
  const s2 = mean(res.map(v => v * v));
  const se = FEATS.map((_, j) => { const e = new Array(k).fill(0); e[j + 1] = 1; return Math.sqrt(s2 * solve(M.map(row => row.slice()), e)[j + 1]); });
  return { means, coef: Object.fromEntries(FEATS.map((f, i) => [f, w[i + 1]])), se: Object.fromEntries(FEATS.map((f, i) => [f, se[i]])), n: train.length };
}
const adj = (F, r) => FEATS.reduce((s, f) => s + F.coef[f] * (r[f] - F.means[f]), 0);
const OLD = r => -0.517 * (r.wind - 15.73) + (r.rain ? -9.5 : 0); // the constants this replaces

// ── walk-forward evidence ──
const stat = e => `MAE ${mean(e.map(Math.abs)).toFixed(2)}  RMSE ${Math.sqrt(mean(e.map(v => v * v))).toFixed(2)}`;
for (const TEST of [[2024, 2025, 2026], [2022, 2023, 2024, 2025, 2026]]) {
  const none = [], old = [], neu = [];
  for (const y of TEST) {
    const F = fit(rows.filter(r => r.y >= FROM && r.y < y));
    for (const r of rows.filter(r => r.y === y)) { none.push(r.act - r.base); old.push(r.act - r.base - OLD(r)); neu.push(r.act - r.base - adj(F, r)); }
  }
  console.log(`Walk-forward totals ${TEST[0]}-${TEST[TEST.length - 1]} (n=${none.length}): no adjustment ${stat(none)} | old weather constants ${stat(old)} | conditions model ${stat(neu)}`);
}

// ── live fit: every season from FROM ──
const F = fit(rows.filter(r => r.y >= FROM));
console.log(`\nConditions fit on ${F.n} matches ${FROM}+ (each centred on its mean):`);
console.log(`  wind  ${F.coef.wind.toFixed(3)} pts per km/h (SE ${F.se.wind.toFixed(3)}), mean ${F.means.wind.toFixed(1)} km/h`);
console.log(`  rain  ${F.coef.rainLog.toFixed(2)} pts per log(1 + mm) of rain during the match (SE ${F.se.rainLog.toFixed(2)}): 1mm ${(F.coef.rainLog * Math.log(2)).toFixed(1)}, 3mm ${(F.coef.rainLog * Math.log(4)).toFixed(1)}`);
console.log(`  time  ${(3 * F.coef.hour).toFixed(2)} pts per 3 hours later kickoff (SE ${(3 * F.se.hour).toFixed(2)}), mean kickoff ${Math.floor(F.means.hour)}:${String(Math.round((F.means.hour % 1) * 60)).padStart(2, '0')}`);

if (process.argv.includes('--write')) {
  const path = 'data/model_params.json';
  const params = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
  params.conditions = {
    windPerKmh: +F.coef.wind.toFixed(4), windMean: +F.means.wind.toFixed(2), forecastWindShrink: 0.8,
    rainLog: +F.coef.rainLog.toFixed(3), rainLogMean: +F.means.rainLog.toFixed(4), rainMinMm: 0.5,
    perHour: +F.coef.hour.toFixed(4), hourMean: +F.means.hour.toFixed(3),
    fittedOn: F.n, fromSeason: FROM, fittedAt: new Date().toISOString(),
    // the live rain term comes from forecast-rain-fit.js; keep it across this refit
    ...(params.conditions && params.conditions.forecastRain ? { forecastRain: params.conditions.forecastRain } : {}),
  };
  fs.writeFileSync(path, JSON.stringify(params, null, 1));
  console.log(`\nWritten: conditions settings to ${path}`);
}
