// Ridge team ratings -- the third model (added 2026-10-02, see MODEL.md).
//
// Before each match, every team's rating is refit to the margins of ALL
// earlier matches at once: predicted margin = rating(home) - rating(away) +
// home advantage, fitted by weighted least squares. Recent rounds weigh most
// (exp(-age/tau), age in rounds), earlier seasons are discounted by gamma per
// season, and a ridge penalty (lambda) pulls teams with little data to the
// league average. Unlike Elo it doesn't lurch after one upset: every recent
// result counts at once.
//
// Walk-forward evidence (rating-candidates.js): win% = average of Elo and a
// [scoring-model margin, ridge margin] blend beat the live Elo + score model
// on 2024-26 with the settings re-tuned each season on earlier seasons only
// (Brier 0.1785 vs 0.1805, log loss 0.5330 vs 0.5398).
//
// Settings (tau, gamma, lambda) are tuned on every completed season before the
// current one, by Brier of a walk-forward ridge-only win probability. That
// takes ~50s, so it only re-runs when a new season starts (or --retune).
//
// Writes:
//   data/ridge_params.json   settings + what they were tuned on
//   data/ridge_history.json  pre-match ridge margin for every match (walk-forward)
//   data/ridge_ratings.json  current ratings + home advantage, for the next round
//   data/ridge_total_history.json  pre-match ridge TOTAL per match (the totals model below)
//   (ridge_ratings.json also carries a totals block: level, home edge, attack, defence)
//
// Usage: node ridge-model.js [--retune]

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeScore != null && m.awayScore != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));
const year = m => Number((m.season.match(/\d{4}/) || [0])[0]);

const seasonFirst = {};
for (const m of matches) if (!(m.season in seasonFirst)) seasonFirst[m.season] = new Date(m.date).getTime();
const seasonIdx = Object.fromEntries(Object.keys(seasonFirst).sort((a, b) => seasonFirst[a] - seasonFirst[b]).map((s, i) => [s, i]));
const roundKey = m => m.season + '|' + m.round;
const roundIdx = {};
{ let g = 0; for (const m of matches) if (!(roundKey(m) in roundIdx)) roundIdx[roundKey(m)] = g++; }
const teams = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]))].sort();
const ti = Object.fromEntries(teams.map((t, i) => [t, i]));
const K = teams.length + 1; // ratings + home advantage
// Scoring shots (2026-10-02, shots-candidates.js): the rating is fitted to a
// mix of the points margin and the scoring-shots margin (goals + behinds,
// scaled to points), because kicking accuracy is mostly luck week to week.
// target = (1 - a) * points margin + a * shots margin * points per shot.
// Nested walk-forward 2024-26: Brier 0.1773 vs 0.1785 points-only, better in
// every season. `a` is tuned with the other settings.
const shotsOf = (g, b) => (g || 0) + (b || 0);
const PPS = matches.reduce((s, m) => s + m.homeScore + m.awayScore, 0) /
  matches.reduce((s, m) => s + shotsOf(m.homeGoals, m.homeBehinds) + shotsOf(m.awayGoals, m.awayBehinds), 0);
const target = (p, a) => p.homeGoals == null ? p.homeScore - p.awayScore
  : (1 - a) * (p.homeScore - p.awayScore) + a * (shotsOf(p.homeGoals, p.homeBehinds) - shotsOf(p.awayGoals, p.awayBehinds)) * PPS;

function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; if (!f) continue; for (let q = c; q < n; q++) A[r][q] -= f * A[c][q]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Fit on matches[0..upto) that started before `beforeMs`, weighted as seen
// from (seasonI, roundI). Returns [rating per team..., hga].
function fitAt(upto, beforeMs, seasonI, roundI, { tau, gamma, lambda, a = 0 }) {
  const A = Array.from({ length: K }, () => new Array(K).fill(0));
  const b = new Array(K).fill(0);
  let any = false;
  for (let j = 0; j < upto; j++) {
    const p = matches[j];
    if (new Date(p.date).getTime() >= beforeMs) break;
    const w = Math.pow(gamma, seasonI - seasonIdx[p.season]) * Math.exp(-(roundI - roundIdx[roundKey(p)]) / tau);
    if (w < 1e-6) continue;
    any = true;
    const idx = [ti[p.homeTeam], ti[p.awayTeam], K - 1], val = [1, -1, 1];
    const y = target(p, a);
    for (let u = 0; u < 3; u++) { b[idx[u]] += w * val[u] * y; for (let v = 0; v < 3; v++) A[idx[u]][idx[v]] += w * val[u] * val[v]; }
  }
  for (let k = 0; k < K - 1; k++) A[k][k] += lambda;
  A[K - 1][K - 1] += 1; // light pull on home advantage too
  return any ? solve(A, b) : new Array(K).fill(0);
}

// Pre-match ridge margin for every match, refit once per kickoff time.
function history(hp) {
  const out = new Map();
  let lastT = -1, fit = null;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i], t = new Date(m.date).getTime();
    if (t !== lastT) { fit = fitAt(i, t, seasonIdx[m.season], roundIdx[roundKey(m)], hp); lastT = t; }
    out.set(m.matchId, fit[ti[m.homeTeam]] - fit[ti[m.awayTeam]] + fit[K - 1]);
  }
  return out;
}

// ── tuning: Brier of a walk-forward normal win prob from the ridge margin ──
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const Phi = (x, m, s) => 0.5 * (1 + erf((x - m) / (s * Math.SQRT2)));
function tuneScore(hist, years) {
  const rows = matches.map(m => ({ y: year(m), ms: hist.get(m.matchId), margin: m.homeScore - m.awayScore, o: m.homeScore > m.awayScore ? 1 : m.homeScore < m.awayScore ? 0 : 0.5 }));
  const br = [];
  for (const y of years) {
    const train = rows.filter(r => r.y < y), test = rows.filter(r => r.y === y);
    if (!test.length || train.length < 20) continue;
    // margin = a + b * ridge margin, least squares on earlier seasons
    const mx = mean(train.map(r => r.ms)), my = mean(train.map(r => r.margin));
    const bxy = train.reduce((s, r) => s + (r.ms - mx) * (r.margin - my), 0) / train.reduce((s, r) => s + (r.ms - mx) ** 2, 0);
    const a = my - bxy * mx;
    const s = sd(train.map(r => r.margin - (a + bxy * r.ms)));
    for (const r of test) br.push((1 - Phi(0.5, a + bxy * r.ms, s) - r.o) ** 2);
  }
  return mean(br);
}

const CURRENT = Math.max(...matches.map(year));
const lastMatchMs = new Date(matches[matches.length - 1].date).getTime();
// More than two months since the last result: the next game opens a new season.
const NEW_SEASON = Date.now() - lastMatchMs > 60 * 24 * 3600 * 1000;
const forSeason = NEW_SEASON ? CURRENT + 1 : CURRENT;
const tuneYears = [...new Set(matches.map(year))].filter(y => y >= 2019 && y < forSeason).sort();
const tunedOn = tuneYears[0] + '-' + tuneYears[tuneYears.length - 1];

let params = fs.existsSync('data/ridge_params.json') ? JSON.parse(fs.readFileSync('data/ridge_params.json', 'utf8')) : null;
if (!params || params.tunedOn !== tunedOn || params.a == null || process.argv.includes('--retune')) {
  const t0 = Date.now();
  let best = null;
  for (const tau of [12, 20, 40, 80, 1e9]) for (const gamma of [0.05, 0.1, 0.2, 0.35, 0.5]) for (const lambda of [0.25, 0.5, 1, 2, 4]) for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    const s = tuneScore(history({ tau, gamma, lambda, a }), tuneYears);
    if (!best || s < best.s) best = { hp: { tau, gamma, lambda, a }, s };
  }
  params = { ...(params && params.totals ? { totals: params.totals } : {}), ...best.hp, tunedOn, tuneBrier: +best.s.toFixed(4), tunedAt: new Date().toISOString() };
  fs.writeFileSync('data/ridge_params.json', JSON.stringify(params, null, 1));
  console.log(`Tuned on ${tunedOn} (${((Date.now() - t0) / 1000).toFixed(0)}s): tau=${params.tau >= 1e9 ? 'none' : params.tau} rounds, gamma=${params.gamma}/season, lambda=${params.lambda}, shots share a=${params.a}  (Brier ${params.tuneBrier})`);
} else {
  console.log(`Settings tuned on ${tunedOn}: tau=${params.tau >= 1e9 ? 'none' : params.tau} rounds, gamma=${params.gamma}/season, lambda=${params.lambda}, shots share a=${params.a}`);
}
const hp = { tau: params.tau, gamma: params.gamma, lambda: params.lambda, a: params.a };

const hist = history(hp);
fs.writeFileSync('data/ridge_history.json', JSON.stringify(matches.map(m => ({ matchId: m.matchId, season: m.season, round: m.round, date: m.date, homeTeam: m.homeTeam, awayTeam: m.awayTeam, predMargin: +hist.get(m.matchId).toFixed(3) }))));

// Ratings for the next games: everything played so far, seen from one round on.
const lastSeasonI = Math.max(...Object.values(seasonIdx));
const fit = fitAt(matches.length, Infinity, lastSeasonI + (NEW_SEASON ? 1 : 0), Math.max(...Object.values(roundIdx)) + 1, hp);
const ratings = Object.fromEntries(teams.map(t => [t, +fit[ti[t]].toFixed(3)]));
fs.writeFileSync('data/ridge_ratings.json', JSON.stringify({ asOf: matches[matches.length - 1].season + ' ' + matches[matches.length - 1].round, newSeason: NEW_SEASON, hga: +fit[K - 1].toFixed(3), ratings, params: hp }, null, 1));

const sorted = Object.entries(ratings).filter(([t]) => matches.some(m => year(m) === CURRENT && (m.homeTeam === t || m.awayTeam === t))).sort((a, b) => b[1] - a[1]);
console.log(`Ridge ratings (points vs league average; home advantage ${fit[K - 1].toFixed(1)}):`);
sorted.forEach(([t, r], i) => console.log(`${String(i + 1).padStart(2)}. ${t.padEnd(10)} ${r >= 0 ? '+' : ''}${r.toFixed(1)}`));
console.log('Wrote data/ridge_params.json, data/ridge_history.json, data/ridge_ratings.json');

// ── Totals: ridge attack/defence on points scored (added 2026-10-02) ──
// points = level + attack(team) - defence(opponent) + home edge, fitted the
// same way to every earlier team score at once. The live total is the
// average of this and the scoring model's total: 2024-26 nested walk-forward
// total MAE 17.31 vs 17.89, better in every season, and it predicts 1st-half
// and 1st-quarter totals better too (total-candidates.js).
const KT = 2 * teams.length + 2; // attack[T], defence[T], level, home
const TT = teams.length;
function fitTotalsAt(upto, beforeMs, seasonI, roundI, { tau, gamma, lambda }) {
  const A = Array.from({ length: KT }, () => new Array(KT).fill(0)), b = new Array(KT).fill(0);
  let any = false;
  for (let j = 0; j < upto; j++) {
    const p = matches[j];
    if (new Date(p.date).getTime() >= beforeMs) break;
    const w = Math.pow(gamma, seasonI - seasonIdx[p.season]) * Math.exp(-(roundI - roundIdx[roundKey(p)]) / tau);
    if (w < 1e-6) continue;
    any = true;
    for (const [team, opp, pts, home] of [[p.homeTeam, p.awayTeam, p.homeScore, 1], [p.awayTeam, p.homeTeam, p.awayScore, 0]]) {
      const idx = [ti[team], TT + ti[opp], 2 * TT, 2 * TT + 1], val = [1, -1, 1, home];
      for (let u = 0; u < 4; u++) { if (!val[u]) continue; b[idx[u]] += w * val[u] * pts; for (let v = 0; v < 4; v++) if (val[v]) A[idx[u]][idx[v]] += w * val[u] * val[v]; }
    }
  }
  for (let k = 0; k < 2 * TT; k++) A[k][k] += lambda;
  A[2 * TT][2 * TT] += 1e-3; A[2 * TT + 1][2 * TT + 1] += 1;
  return any ? solve(A, b) : null;
}
const totalOf = (f, h, a) => 2 * f[2 * TT] + f[ti[h]] - f[TT + ti[a]] + f[ti[a]] - f[TT + ti[h]] + f[2 * TT + 1];
function totalsHistory(hp) {
  const out = new Map();
  let lastT = -1, f = null;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i], t = new Date(m.date).getTime();
    if (t !== lastT) { f = fitTotalsAt(i, t, seasonIdx[m.season], roundIdx[roundKey(m)], hp); lastT = t; }
    if (f) out.set(m.matchId, totalOf(f, m.homeTeam, m.awayTeam));
  }
  return out;
}
{
  const scoreHist = new Map(JSON.parse(fs.readFileSync('data/score_history.json', 'utf8')).map(s => [s.matchId, s]));
  let tp = params.totals;
  if (!tp || tp.tunedOn !== tunedOn || process.argv.includes('--retune')) {
    const t0 = Date.now();
    let best = null;
    for (const tau of [12, 20, 40, 80]) for (const gamma of [0.1, 0.2, 0.35, 0.5]) for (const lambda of [2, 4, 8, 16, 32, 64]) {
      const h = totalsHistory({ tau, gamma, lambda });
      const errs = matches.filter(m => tuneYears.includes(year(m)) && h.has(m.matchId)).map(m => Math.abs(m.homeScore + m.awayScore - h.get(m.matchId)));
      const mae = errs.reduce((s, v) => s + v, 0) / errs.length;
      if (!best || mae < best.mae) best = { hp: { tau, gamma, lambda }, mae };
    }
    tp = { ...best.hp, tunedOn, tuneMAE: +best.mae.toFixed(2), tunedAt: new Date().toISOString() };
    params.totals = tp;
    fs.writeFileSync('data/ridge_params.json', JSON.stringify(params, null, 1));
    console.log(`Totals tuned on ${tunedOn} (${((Date.now() - t0) / 1000).toFixed(0)}s): tau=${tp.tau}, gamma=${tp.gamma}, lambda=${tp.lambda} (MAE ${tp.tuneMAE})`);
  } else {
    console.log(`Totals settings tuned on ${tunedOn}: tau=${tp.tau}, gamma=${tp.gamma}, lambda=${tp.lambda}`);
  }
  const thp = { tau: tp.tau, gamma: tp.gamma, lambda: tp.lambda };
  const th = totalsHistory(thp);
  fs.writeFileSync('data/ridge_total_history.json', JSON.stringify(matches.filter(m => th.has(m.matchId)).map(m => ({ matchId: m.matchId, predTotal: +th.get(m.matchId).toFixed(3) }))));
  const f = fitTotalsAt(matches.length, Infinity, lastSeasonI + (NEW_SEASON ? 1 : 0), Math.max(...Object.values(roundIdx)) + 1, thp);
  const saved = JSON.parse(fs.readFileSync('data/ridge_ratings.json', 'utf8'));
  saved.totals = {
    level: +f[2 * TT].toFixed(3), home: +f[2 * TT + 1].toFixed(3), params: thp,
    attack: Object.fromEntries(teams.map(t => [t, +f[ti[t]].toFixed(3)])),
    defence: Object.fromEntries(teams.map(t => [t, +f[TT + ti[t]].toFixed(3)])),
  };
  fs.writeFileSync('data/ridge_ratings.json', JSON.stringify(saved, null, 1));
  const recent = matches.filter(m => year(m) >= 2024 && th.has(m.matchId) && scoreHist.has(m.matchId));
  const mae = fn => recent.reduce((s, m) => s + Math.abs(m.homeScore + m.awayScore - fn(m)), 0) / recent.length;
  const sm = m => scoreHist.get(m.matchId).predHomeScore + scoreHist.get(m.matchId).predAwayScore;
  console.log(`Totals 2024+ MAE: scoring model ${mae(sm).toFixed(2)}, ridge ${mae(m => th.get(m.matchId)).toFixed(2)}, average (live) ${mae(m => (sm(m) + th.get(m.matchId)) / 2).toFixed(2)}  [settings tuned before 2026; 2024-25 rows are in-sample for the settings]`);
  console.log('Wrote data/ridge_total_history.json + totals block in data/ridge_ratings.json');
}
