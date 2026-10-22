// Candidates #3-#6 from the 2026-10-02 improvement list, each tested the same
// way as the live model: walk-forward by season (fit on earlier seasons only,
// score the next), headline numbers on 2024-26.
//
//   #3 margin/total SPREAD that varies by game (bigger predicted totals or
//      mismatches may swing more) -- scored by the log-likelihood of the
//      actual margin/total, the proper score for line/total prices.
//   #4 away-favourite problem: travel distance, days' rest, local-derby flag
//      as fitted features rather than the hard "no HGA in a derby" rule.
//   #5 player values from fantasy points (AFL.com.au per-player stats)
//      instead of career games: lineup strength vs the team's usual strength.
//   #6 new-season starting point: the same lineup measure in rounds 1-3,
//      where it captures off-season list changes (retirements, recruits).
//
// Baseline = the live model as predict-round.js runs it: win% = average of
// Elo (local derby: no HGA) and a normal blend of [scoring-model margin,
// ridge margin (derby: no HGA)] + team-news adjustment (career games of
// unavailable players).
//
// Usage: node improvement-candidates.js

const fs = require('fs');
const COORDS = require('./venue-coords');
const { buildTeamHomeCities } = require('./travel-adjustment');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeScore != null && m.awayScore != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));
const elo = new Map(JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8')).map(e => [e.matchId, e]));
const score = new Map(JSON.parse(fs.readFileSync('data/score_history.json', 'utf8')).map(s => [s.matchId, s]));
const ridge = new Map(JSON.parse(fs.readFileSync('data/ridge_history.json', 'utf8')).map(r => [r.matchId, r.predMargin]));
const ridgeTot = new Map(JSON.parse(fs.readFileSync('data/ridge_total_history.json', 'utf8')).map(r => [r.matchId, r.predTotal]));
const rosters = JSON.parse(fs.readFileSync('data/rosters.json', 'utf8'));
const pstats = JSON.parse(fs.readFileSync('data/player_stats.json', 'utf8'));
const ELO = JSON.parse(fs.readFileSync('data/elo_params.json', 'utf8'));
const RIDGE_HGA = JSON.parse(fs.readFileSync('data/ridge_ratings.json', 'utf8')).hga;
const PARAMS = JSON.parse(fs.readFileSync('data/model_params.json', 'utf8'));
const ROSTER_REASONS = new Set(PARAMS.roster.countedReasons);
const year = m => Number((m.season.match(/\d{4}/) || [0])[0]);

// ── stats kit ──
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const Phi = (x, m, s) => 0.5 * (1 + erf((x - m) / (s * Math.SQRT2)));
const invPhi = p => { let lo = -10, hi = 10; for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (Phi(m, 0, 1) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const ll = (p, o) => { const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return -(o * Math.log(c) + (1 - o) * Math.log(1 - c)); };
function solve(M, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (!f) continue; for (let q = c; q < n; q++) M[r][q] -= f * M[c][q]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / M[i][i]);
}
function ols(X, y) {
  const k = X[0].length, M = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let p = 0; p < k; p++) { b[p] += X[i][p] * y[i]; for (let q = 0; q < k; q++) M[p][q] += X[i][p] * X[i][q]; }
  for (let p = 1; p < k; p++) M[p][p] += 1e-6;
  return solve(M, b);
}
const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);
const expectedScore = (rA, rB) => 1 / (1 + Math.pow(10, (rB - rA) / 400));

// ── per-match context: travel, rest, derby ──
const homeCity = buildTeamHomeCities(matches);
const km = (a, b) => { const R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); };
const lastPlayed = new Map();

// ── player values (point-in-time) from fantasy points ──
// value = recency-weighted average fantasy points per game, shrunk toward a
// newcomer prior. Only games BEFORE the match being predicted count.
const HALF_LIFE = Number(process.env.HL || 20); // games
const DECAY = Math.pow(0.5, 1 / HALF_LIFE);
const PRIOR_N = Number(process.env.PN || 4);
const pv = new Map(); // id -> { s: weighted fp sum, w: weight sum, games }
let newcomerPrior = 30; // refreshed from the data as we go: avg fp of players in their first 3 games
const debutFP = [];
const valueOf = id => { const p = pv.get(id); return p ? (p.s + PRIOR_N * newcomerPrior) / (p.w + PRIOR_N) : newcomerPrior; };
const careerGames = new Map();
// a team's usual lineup strength: exponentially weighted over its previous lineups
const teamBase = new Map(); // team -> { s, w }
const TEAM_DECAY = Number(process.env.TD || 0.85);

const rows = [];
for (const m of matches) {
  const e = elo.get(m.matchId), s = score.get(m.matchId);
  const t = new Date(m.date).getTime();
  const ro = rosters[m.matchId];
  const sides = ro ? [[m.homeTeam, ro.homeTeam], [m.awayTeam, ro.awayTeam]] : [];
  // lineup strength before the match
  const lineup = {};
  for (const [team, side] of sides) {
    if (!side) continue;
    const named = side.positions.filter(p => p.position !== 'EMERG').map(p => p.playerId);
    const strength = named.reduce((acc, id) => acc + valueOf(id), 0);
    const base = teamBase.get(team);
    const outs = (side.outs || []).filter(o => ROSTER_REASONS.has(o.reason)).reduce((acc, o) => acc + (careerGames.get(o.player ? o.player.playerId : o.playerId) || 0), 0);
    lineup[team] = { strength, delta: base ? strength - base.s / base.w : null, outsGames: outs, n: named.length };
  }
  if (e && s && ridge.has(m.matchId) && ridgeTot.has(m.matchId)) {
    const hc = homeCity.get(m.homeTeam), ac = homeCity.get(m.awayTeam), v = COORDS[m.venueLocation];
    const hKm = hc && v && COORDS[hc] ? km(COORDS[hc], v) : null, aKm = ac && v && COORDS[ac] ? km(COORDS[ac], v) : null;
    const derby = hKm != null && aKm != null && hKm < 100 && aKm < 100;
    const rest = team => { const l = lastPlayed.get(team); return l == null ? 14 : Math.min(14, (t - l) / 86400000); };
    const eloProb = expectedScore(e.homeRatingPre + ELO.hga - (derby ? ELO.hga : 0), e.awayRatingPre);
    const H = lineup[m.homeTeam], A = lineup[m.awayTeam];
    rows.push({
      id: m.matchId, year: year(m), season: m.season, round: m.round,
      roundNo: Number((String(m.round).match(/\d+/) || [99])[0]),
      eloDiff: e.homeRatingPre + ELO.hga - (derby ? ELO.hga : 0) - e.awayRatingPre,
      eloProb, smMargin: s.predHomeScore - s.predAwayScore,
      smTotal: s.predHomeScore + s.predAwayScore, liveTotal: (s.predHomeScore + s.predAwayScore + ridgeTot.get(m.matchId)) / 2,
      ridge: ridge.get(m.matchId) - (derby ? RIDGE_HGA : 0), ridgeRaw: ridge.get(m.matchId),
      derby: derby ? 1 : 0,
      travel: hKm != null && aKm != null ? (aKm - hKm) / 1000 : 0,
      awayInterstate: aKm != null && aKm > 500 ? 1 : 0, homeInterstate: hKm != null && hKm > 500 ? 1 : 0,
      restDiff: rest(m.homeTeam) - rest(m.awayTeam),
      shortH: rest(m.homeTeam) < 6 ? 1 : 0, shortA: rest(m.awayTeam) < 6 ? 1 : 0,
      careerNet: H && A ? A.outsGames - H.outsGames : 0,
      lineupNet: H && A && H.delta != null && A.delta != null ? H.delta - A.delta : 0,
      hasLineup: !!(H && A && H.delta != null && A.delta != null),
      margin: m.homeScore - m.awayScore, total: m.homeScore + m.awayScore,
      o: m.homeScore > m.awayScore ? 1 : m.homeScore < m.awayScore ? 0 : 0.5,
    });
  }
  // fold the match in (after predicting it)
  lastPlayed.set(m.homeTeam, t); lastPlayed.set(m.awayTeam, t);
  for (const [team, side] of sides) {
    if (!side) continue;
    for (const p of side.positions) if (p.position !== 'EMERG') careerGames.set(p.playerId, (careerGames.get(p.playerId) || 0) + 1);
    const L = lineup[team];
    if (L) { const b = teamBase.get(team) || { s: 0, w: 0 }; teamBase.set(team, { s: b.s * TEAM_DECAY + L.strength, w: b.w * TEAM_DECAY + 1 }); }
  }
  for (const p of pstats[m.matchId] || []) {
    if (p.fp == null) continue;
    const q = pv.get(p.id) || { s: 0, w: 0, games: 0 };
    if (q.games < 3) { debutFP.push(p.fp); if (debutFP.length > 400) debutFP.shift(); }
    pv.set(p.id, { s: q.s * DECAY + p.fp, w: q.w * DECAY + 1, games: q.games + 1 });
  }
  if (debutFP.length >= 50) newcomerPrior = mean(debutFP);
}
const matchTeams = new Map(matches.map(m => [m.matchId, [m.homeTeam, m.awayTeam]]));
const TEST = [2024, 2025, 2026];
const FROM = 2019;
console.log(`${rows.length} matches with every input; testing ${TEST.join('-')} (fit on ${FROM}+ earlier seasons)\n`);

// ── win-probability candidates: features for the margin blend ──
// p = average(Elo prob, normal blend prob); blend fitted on earlier seasons.
function walk(feat, years = TEST, filter = () => true) {
  const out = [];
  for (const y of years) {
    const tr = rows.filter(r => r.year < y && r.year >= 2017), te = rows.filter(r => r.year === y && filter(r));
    const w = ols(tr.map(feat), tr.map(r => r.margin));
    const s = sd(tr.map(r => r.margin - dot(w, feat(r))));
    for (const r of te) { const mu = dot(w, feat(r)); const p = (r.eloProb + 1 - Phi(0.5, mu, s)) / 2; out.push({ ...r, mu, p, w }); }
  }
  return out;
}
const score_ = res => ({ n: res.length, brier: mean(res.map(x => (x.p - x.o) ** 2)), ll: mean(res.filter(x => x.o !== 0.5).map(x => ll(x.p, x.o))), mae: mean(res.map(x => Math.abs(x.margin - x.mu))) });
const fmt = s => `n=${s.n}  Brier ${s.brier.toFixed(4)}  LogLoss ${s.ll.toFixed(4)}  blend MAE ${s.mae.toFixed(2)}`;
const byYear = res => TEST.map(y => mean(res.filter(x => x.year === y).map(x => (x.p - x.o) ** 2)).toFixed(4)).join('/');

// live team-news adjustment is added on top of the blend at a fixed slope
const SLOPE = PARAMS.roster.slopePerCareerGame;
const BASE = r => [1, r.smMargin, r.ridge];
const cands = {
  'LIVE (derby: no HGA; career-games team news)': { f: BASE, adj: r => SLOPE * r.careerNet },
  '#4 derby as a fitted feature (not forced to 0)': { f: r => [1, r.smMargin, r.ridgeRaw, r.derby], adj: r => SLOPE * r.careerNet },
  '#4 + travel distance (away km - home km)': { f: r => [1, r.smMargin, r.ridge, r.travel], adj: r => SLOPE * r.careerNet },
  '#4 + interstate flags': { f: r => [1, r.smMargin, r.ridge, r.awayInterstate - r.homeInterstate], adj: r => SLOPE * r.careerNet },
  '#4 + days rest difference': { f: r => [1, r.smMargin, r.ridge, r.restDiff], adj: r => SLOPE * r.careerNet },
  '#4 + short-break flags (<6 days)': { f: r => [1, r.smMargin, r.ridge, r.shortH - r.shortA], adj: r => SLOPE * r.careerNet },
  '#5 fantasy-point lineup strength (replaces career games)': { f: r => [1, r.smMargin, r.ridge, r.lineupNet], adj: () => 0 },
  '#5 lineup strength + career games': { f: r => [1, r.smMargin, r.ridge, r.lineupNet], adj: r => SLOPE * r.careerNet },
  '#5 career games fitted as a feature': { f: r => [1, r.smMargin, r.ridge, r.careerNet], adj: () => 0 },
};
const results = {};
console.log('=== Win chance, walk-forward 2024-26 ===');
for (const [name, c] of Object.entries(cands)) {
  const res = walk(r => c.f(r)).map(x => { const mu = x.mu + c.adj(x); return { ...x, mu }; });
  // re-derive p with the adjustment inside the blend (same as predict-round.js)
  const res2 = [];
  for (const y of TEST) {
    const tr = rows.filter(r => r.year < y), te = res.filter(r => r.year === y);
    const w = ols(tr.map(c.f), tr.map(r => r.margin));
    const s = sd(tr.map(r => r.margin - dot(w, c.f(r))));
    for (const r of te) res2.push({ ...r, p: (r.eloProb + 1 - Phi(0.5, r.mu, s)) / 2 });
  }
  results[name] = res2;
  const w = ols(rows.filter(r => r.year >= FROM).map(c.f), rows.filter(r => r.year >= FROM).map(r => r.margin));
  console.log(name.padEnd(58) + fmt(score_(res2)) + '  by season ' + byYear(res2) + (w.length > 3 ? `  [extra coef ${w[3].toFixed(3)}]` : ''));
}

// heavy away favourites: actual minus predicted margin (watch item #4)
console.log('\nHeavy away favourites (blend margin <= -15), actual minus predicted margin, 2024-26:');
for (const name of Object.keys(cands)) {
  const h = results[name].filter(x => x.mu <= -15);
  const r = h.map(x => x.margin - x.mu);
  console.log('  ' + name.padEnd(58) + `n=${h.length}  bias ${mean(r).toFixed(1)} (SE ${(sd(r) / Math.sqrt(r.length)).toFixed(1)})`);
}

// #6: rounds 1-3 only, all test seasons from 2019 for sample size
console.log('\n=== #6 season start: rounds 1-3 only, walk-forward 2019-26 ===');
const early = r => r.roundNo <= 3;
const ALLY = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
for (const name of ['LIVE (derby: no HGA; career-games team news)', '#5 fantasy-point lineup strength (replaces career games)', '#5 lineup strength + career games']) {
  const c = cands[name];
  const out = [];
  for (const y of ALLY) {
    const tr = rows.filter(r => r.year < y), te = rows.filter(r => r.year === y && early(r));
    if (!te.length) continue;
    const w = ols(tr.map(c.f), tr.map(r => r.margin));
    const s = sd(tr.map(r => r.margin - dot(w, c.f(r))));
    for (const r of te) { const mu = dot(w, c.f(r)) + c.adj(r); out.push({ ...r, mu, p: (r.eloProb + 1 - Phi(0.5, mu, s)) / 2 }); }
  }
  console.log('  ' + name.padEnd(58) + fmt(score_(out)));
}
// and all rounds 2019-26 for the lineup measure, for power
console.log('\n=== #5 over every test season 2019-26 (more matches, less noise) ===');
for (const name of ['LIVE (derby: no HGA; career-games team news)', '#5 fantasy-point lineup strength (replaces career games)', '#5 lineup strength + career games']) {
  const c = cands[name];
  const out = [];
  for (const y of ALLY) {
    const tr = rows.filter(r => r.year < y), te = rows.filter(r => r.year === y);
    const w = ols(tr.map(c.f), tr.map(r => r.margin));
    const s = sd(tr.map(r => r.margin - dot(w, c.f(r))));
    for (const r of te) { const mu = dot(w, c.f(r)) + c.adj(r); out.push({ ...r, mu, p: (r.eloProb + 1 - Phi(0.5, mu, s)) / 2 }); }
  }
  console.log('  ' + name.padEnd(58) + fmt(score_(out)) + '  by season ' + ALLY.map(y => mean(out.filter(x => x.year === y).map(x => (x.p - x.o) ** 2)).toFixed(3)).join('/'));
}

// Both halves shifted (as predict-round.js does with team news): the blend by
// its margin shift, Elo by the same shift converted to Elo points.
console.log('\n=== team news applied to BOTH halves (Elo and blend), 2024-26 ===');
for (const [label, useLineup, useCareer] of [['career games only (= live exactly)', false, true], ['lineup strength + career games', true, true], ['lineup strength only', true, false]]) {
  const out = [];
  for (const y of TEST) {
    const tr = rows.filter(r => r.year < y), te = rows.filter(r => r.year === y);
    const f = r => useLineup ? [1, r.smMargin, r.ridge, r.lineupNet] : [1, r.smMargin, r.ridge];
    const w = ols(tr.map(f), tr.map(r => r.margin));
    const s = sd(tr.map(r => r.margin - dot(w, f(r))));
    for (const r of te) {
      const lineupShift = useLineup ? w[3] * r.lineupNet : 0, careerShift = useCareer ? SLOPE * r.careerNet : 0;
      const mu = dot(w, f(r)) + careerShift;
      const eloP = 1 / (1 + Math.pow(10, -(r.eloDiff + (lineupShift + careerShift) / ELO.marginSlope) / 400));
      out.push({ ...r, mu, p: (eloP + 1 - Phi(0.5, mu, s)) / 2 });
    }
  }
  if (process.env.DUMP && useLineup && useCareer) for (const r of out.filter(r => r.year === 2026 && process.env.DUMP.split(',').some(t => matchTeams.get(r.id).includes(t)))) { const t = matchTeams.get(r.id); console.log('    DUMP', r.round.padEnd(9), t.join(' v ').padEnd(20), 'p(home)', (r.p * 100).toFixed(0).padStart(3) + '%', 'mu', r.mu.toFixed(1).padStart(6), 'lineupNet', r.lineupNet.toFixed(0).padStart(5), 'actual', String(r.margin).padStart(4)); }
  console.log('  ' + label.padEnd(40) + fmt(score_(out)) + '  by season ' + byYear(out) + '  tips ' + out.filter(x => x.o !== 0.5 && (x.p > 0.5) === (x.o === 1)).length + '/' + out.filter(x => x.o !== 0.5).length);
}
if (process.env.SKIP3) process.exit(0);
// ── #3 spread that varies by game ──
// Margin: Normal(mu, sd_i), mu solved so P(home win) = the live win chance.
// sd_i = exp(c0 + c1*(predicted total - 85)/10 + c2*|win chance - 0.5|*10).
// Fitted by maximum likelihood on earlier seasons (2021+), scored on the test season.
console.log('\n=== #3 margin spread: constant vs varying by game (log-likelihood per match, higher is better) ===');
const live = results['LIVE (derby: no HGA; career-games team news)'];
const liveAll = [];
for (const y of [2021, 2022, 2023, 2024, 2025, 2026]) {
  const tr = rows.filter(r => r.year < y), te = rows.filter(r => r.year === y);
  const c = cands['LIVE (derby: no HGA; career-games team news)'];
  const w = ols(tr.map(c.f), tr.map(r => r.margin));
  const s = sd(tr.map(r => r.margin - dot(w, c.f(r))));
  for (const r of te) { const mu = dot(w, c.f(r)) + c.adj(r); liveAll.push({ ...r, p: (r.eloProb + 1 - Phi(0.5, mu, s)) / 2 }); }
}
const zT = r => (r.liveTotal - 85) / 10, zP = r => Math.abs(r.p - 0.5) * 10;
const marginLL = (r, sdv) => { const mu = 0.5 - sdv * invPhi(1 - r.p); return -0.5 * ((r.margin - mu) / sdv) ** 2 - Math.log(sdv) - 0.9189; };
function fitSD(tr, useT, useP) {
  let best = null;
  for (let c1 = useT ? -0.1 : 0; c1 <= (useT ? 0.2001 : 0); c1 += 0.02) for (let c2 = useP ? -0.1 : 0; c2 <= (useP ? 0.1001 : 0); c2 += 0.01) for (let c0 = Math.log(20); c0 <= Math.log(32); c0 += 0.01) {
    const L = mean(tr.map(r => marginLL(r, Math.exp(c0 + c1 * zT(r) + c2 * zP(r)))));
    if (!best || L > best.L) best = { c0, c1, c2, L };
  }
  return best;
}
for (const [label, uT, uP] of [['constant spread (live)', false, false], ['spread grows with predicted total', true, false], ['spread varies with mismatch', false, true], ['both', true, true]]) {
  const out = [], fits = [];
  for (const y of TEST) {
    const tr = liveAll.filter(r => r.year < y && r.year >= 2021), te = liveAll.filter(r => r.year === y);
    const f = fitSD(tr, uT, uP); fits.push(f);
    for (const r of te) out.push(marginLL(r, Math.exp(f.c0 + f.c1 * zT(r) + f.c2 * zP(r))));
  }
  const f = fits[fits.length - 1];
  console.log(`  ${label.padEnd(36)} ${mean(out).toFixed(4)}   (last fit: sd = ${Math.exp(f.c0).toFixed(1)} x exp(${f.c1.toFixed(2)}*(total-85)/10 + ${f.c2.toFixed(2)}*|p-0.5|*10))`);
}
// Total: Normal(liveTotal + bias, sd_i), sd_i = exp(d0 + d1*(predicted total - 85)/10)
console.log('\n=== #3 total spread: constant vs growing with the predicted total (log-likelihood per match) ===');
const totLL = (r, b, sdv) => -0.5 * ((r.total - r.liveTotal - b) / sdv) ** 2 - Math.log(sdv) - 0.9189;
for (const useT of [false, true]) {
  const out = []; let last;
  for (const y of TEST) {
    const tr = liveAll.filter(r => r.year < y && r.year >= 2021), te = liveAll.filter(r => r.year === y);
    const b = mean(tr.map(r => r.total - r.liveTotal));
    let best = null;
    for (let d1 = useT ? -0.1 : 0; d1 <= (useT ? 0.3001 : 0); d1 += 0.01) for (let d0 = Math.log(14); d0 <= Math.log(30); d0 += 0.005) {
      const L = mean(tr.map(r => totLL(r, b, Math.exp(d0 + d1 * zT(r)))));
      if (!best || L > best.L) best = { d0, d1, L };
    }
    last = best;
    for (const r of te) out.push(totLL(r, b, Math.exp(best.d0 + best.d1 * zT(r))));
  }
  console.log(`  ${(useT ? 'spread grows with predicted total' : 'constant spread (live)').padEnd(36)} ${mean(out).toFixed(4)}   (last fit: sd = ${Math.exp(last.d0).toFixed(1)} x exp(${last.d1.toFixed(2)}*(total-85)/10))`);
}
