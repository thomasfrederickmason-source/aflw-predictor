// Candidate #2 (2026-10-02): rate teams on SCORING SHOTS as well as points.
// Kicking accuracy is largely luck week to week, so a ridge rating fitted to
// a blend of the points margin and the shots margin (scaled to points) may
// predict better than points alone.
//   target = (1 - a) * points margin + a * shots margin * points-per-shot
// a = 0 is today's live ridge rating. The ridge settings AND a are tuned on
// earlier seasons only, per test season, exactly like ridge-model.js; the
// live win-chance structure (average of Elo and a [scoring-model, ridge]
// margin blend) is then scored on that season.
// Also tests the same idea for the TOTAL (ridge attack/defence on shots).
//
// Usage: node shots-candidates.js

const fs = require('fs');
const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeScore != null && m.awayScore != null && m.homeGoals != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));
const elo = new Map(JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8')).map(e => [e.matchId, e]));
const score = new Map(JSON.parse(fs.readFileSync('data/score_history.json', 'utf8')).map(s => [s.matchId, s]));
const year = m => Number((m.season.match(/\d{4}/) || [0])[0]);
const seasonFirst = {};
for (const m of matches) if (!(m.season in seasonFirst)) seasonFirst[m.season] = new Date(m.date).getTime();
const seasonIdx = Object.fromEntries(Object.keys(seasonFirst).sort((a, b) => seasonFirst[a] - seasonFirst[b]).map((s, i) => [s, i]));
const roundKey = m => m.season + '|' + m.round;
const roundIdx = {}; { let g = 0; for (const m of matches) if (!(roundKey(m) in roundIdx)) roundIdx[roundKey(m)] = g++; }
const teams = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]))].sort();
const ti = Object.fromEntries(teams.map((t, i) => [t, i]));
const K = teams.length + 1, TT = teams.length, KT = 2 * TT + 2;
const shots = (g, b) => g + b;
const PPS = matches.reduce((s, m) => s + m.homeScore + m.awayScore, 0) / matches.reduce((s, m) => s + shots(m.homeGoals, m.homeBehinds) + shots(m.awayGoals, m.awayBehinds), 0);
const T = matches.map(m => new Date(m.date).getTime());
const SI = matches.map(m => seasonIdx[m.season]), RI = matches.map(m => roundIdx[roundKey(m)]);
const H = matches.map(m => ti[m.homeTeam]), A = matches.map(m => ti[m.awayTeam]);
const PM = matches.map(m => m.homeScore - m.awayScore);
const SM = matches.map(m => (shots(m.homeGoals, m.homeBehinds) - shots(m.awayGoals, m.awayBehinds)) * PPS);
const HP = matches.map(m => m.homeScore), AP = matches.map(m => m.awayScore);
const HS = matches.map(m => shots(m.homeGoals, m.homeBehinds) * PPS), AS = matches.map(m => shots(m.awayGoals, m.awayBehinds) * PPS);

function solve(M, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (!f) continue; for (let q = c; q < n; q++) M[r][q] -= f * M[c][q]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / M[i][i]);
}
function marginHistory({ tau, gamma, lambda, a }) {
  const out = new Float64Array(matches.length);
  let lastT = -1, fit = null;
  for (let i = 0; i < matches.length; i++) {
    if (T[i] !== lastT) {
      const M = Array.from({ length: K }, () => new Float64Array(K)), b = new Float64Array(K);
      let any = false;
      for (let j = 0; j < i && T[j] < T[i]; j++) {
        const w = Math.pow(gamma, SI[i] - SI[j]) * Math.exp(-(RI[i] - RI[j]) / tau);
        if (w < 1e-6) continue; any = true;
        const y = (1 - a) * PM[j] + a * SM[j], h = H[j], aw = A[j], Hh = K - 1;
        M[h][h] += w; M[aw][aw] += w; M[Hh][Hh] += w; M[h][aw] -= w; M[aw][h] -= w; M[h][Hh] += w; M[Hh][h] += w; M[aw][Hh] -= w; M[Hh][aw] -= w;
        b[h] += w * y; b[aw] -= w * y; b[Hh] += w * y;
      }
      for (let k = 0; k < K - 1; k++) M[k][k] += lambda; M[K - 1][K - 1] += 1;
      fit = any ? solve(M.map(r => Array.from(r)), Array.from(b)) : new Array(K).fill(0);
      lastT = T[i];
    }
    out[i] = fit[H[i]] - fit[A[i]] + fit[K - 1];
  }
  return out;
}
function totalHistory({ tau, gamma, lambda, a }) {
  const out = new Float64Array(matches.length).fill(NaN);
  let lastT = -1, f = null;
  for (let i = 0; i < matches.length; i++) {
    if (T[i] !== lastT) {
      const M = Array.from({ length: KT }, () => new Float64Array(KT)), b = new Float64Array(KT);
      let any = false;
      for (let j = 0; j < i && T[j] < T[i]; j++) {
        const w = Math.pow(gamma, SI[i] - SI[j]) * Math.exp(-(RI[i] - RI[j]) / tau);
        if (w < 1e-6) continue; any = true;
        for (const [tm, op, pts, home] of [[H[j], A[j], (1 - a) * HP[j] + a * HS[j], 1], [A[j], H[j], (1 - a) * AP[j] + a * AS[j], 0]]) {
          const idx = home ? [tm, TT + op, 2 * TT, 2 * TT + 1] : [tm, TT + op, 2 * TT], val = home ? [1, -1, 1, 1] : [1, -1, 1];
          for (let u = 0; u < idx.length; u++) { b[idx[u]] += w * val[u] * pts; for (let v = 0; v < idx.length; v++) M[idx[u]][idx[v]] += w * val[u] * val[v]; }
        }
      }
      for (let k = 0; k < 2 * TT; k++) M[k][k] += lambda; M[2 * TT][2 * TT] += 1e-3; M[2 * TT + 1][2 * TT + 1] += 1;
      f = any ? solve(M.map(r => Array.from(r)), Array.from(b)) : null;
      lastT = T[i];
    }
    if (f) out[i] = 2 * f[2 * TT] + f[H[i]] - f[TT + A[i]] + f[A[i]] - f[TT + H[i]] + f[2 * TT + 1];
  }
  return out;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const Phi = (x, m, s) => 0.5 * (1 + erf((x - m) / (s * Math.SQRT2)));
const ll = (p, o) => { const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return -(o * Math.log(c) + (1 - o) * Math.log(1 - c)); };
function ols(X, y) {
  const k = X[0].length, M = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let p = 0; p < k; p++) { b[p] += X[i][p] * y[i]; for (let q = 0; q < k; q++) M[p][q] += X[i][p] * X[i][q]; }
  for (let p = 1; p < k; p++) M[p][p] += 1e-6;
  return solve(M, b);
}
const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);
const O = matches.map(m => m.homeScore > m.awayScore ? 1 : m.homeScore < m.awayScore ? 0 : 0.5);
const Y = matches.map(year);
const okRow = i => elo.has(matches[i].matchId) && score.has(matches[i].matchId);
const SMM = matches.map(m => { const s = score.get(m.matchId); return s ? s.predHomeScore - s.predAwayScore : NaN; });
const SMT = matches.map(m => { const s = score.get(m.matchId); return s ? s.predHomeScore + s.predAwayScore : NaN; });
const EP = matches.map(m => { const e = elo.get(m.matchId); return e ? e.homeWinProbModel : NaN; });

// ridge-only Brier on given years (how ridge-model.js tunes)
function tuneBrier(hist, years) {
  const br = [];
  for (const y of years) {
    const tr = [], te = [];
    for (let i = 0; i < matches.length; i++) { if (Y[i] < y) tr.push(i); else if (Y[i] === y) te.push(i); }
    if (!te.length || tr.length < 20) continue;
    const w = ols(tr.map(i => [1, hist[i]]), tr.map(i => PM[i]));
    const s = sd(tr.map(i => PM[i] - w[0] - w[1] * hist[i]));
    for (const i of te) br.push((1 - Phi(0.5, w[0] + w[1] * hist[i], s) - O[i]) ** 2);
  }
  return mean(br);
}
// live structure on one test year
function liveOn(hist, y) {
  const tr = [], te = [];
  for (let i = 0; i < matches.length; i++) { if (!okRow(i)) continue; if (Y[i] < y) tr.push(i); else if (Y[i] === y) te.push(i); }
  const f = i => [1, SMM[i], hist[i]];
  const w = ols(tr.map(f), tr.map(i => PM[i]));
  const s = sd(tr.map(i => PM[i] - dot(w, f(i))));
  return te.map(i => { const p = (EP[i] + 1 - Phi(0.5, dot(w, f(i)), s)) / 2; return { i, y, p, br: (p - O[i]) ** 2, ll: O[i] === 0.5 ? null : ll(p, O[i]), ae: Math.abs(PM[i] - dot(w, f(i))) }; });
}

const t0 = Date.now();
console.log(`points per scoring shot (scale): ${PPS.toFixed(3)}`);
const GRID = [];
for (const tau of [20, 40, 80]) for (const gamma of [0.1, 0.2, 0.35]) for (const lambda of [0.25, 0.5, 1, 2]) for (const a of [0, 0.25, 0.5, 0.75, 1]) GRID.push({ tau, gamma, lambda, a });
const hists = GRID.map(hp => ({ hp, h: marginHistory(hp) }));
console.log(`${GRID.length} margin histories in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const TEST = [2024, 2025, 2026];
const res = { base: [], cand: [] };
for (const y of TEST) {
  const tuneYears = [2019, 2020, 2021, 2022, 2023, 2024, 2025].filter(x => x < y);
  const scored = hists.map(x => ({ ...x, s: tuneBrier(x.h, tuneYears) }));
  const bestBase = scored.filter(x => x.hp.a === 0).sort((p, q) => p.s - q.s)[0];
  const bestCand = scored.sort((p, q) => p.s - q.s)[0];
  const rb = liveOn(bestBase.h, y), rc = liveOn(bestCand.h, y);
  res.base.push(...rb); res.cand.push(...rc);
  console.log(`${y}: points-only ridge ${JSON.stringify(bestBase.hp)} Brier ${mean(rb.map(r => r.br)).toFixed(4)}  |  tuned a: ${JSON.stringify(bestCand.hp)} Brier ${mean(rc.map(r => r.br)).toFixed(4)}`);
}
const fmt = r => `Brier ${mean(r.map(x => x.br)).toFixed(4)}  LogLoss ${mean(r.filter(x => x.ll != null).map(x => x.ll)).toFixed(4)}  margin MAE ${mean(r.map(x => x.ae)).toFixed(2)}`;
console.log(`\nWin chance, nested walk-forward 2024-26 (n=${res.base.length}):`);
console.log('  live (points ridge)     ' + fmt(res.base));
console.log('  shots-blend ridge       ' + fmt(res.cand));
// fixed-a sensitivity (settings tuned per year, a held fixed)
for (const a of [0.25, 0.5, 0.75, 1]) {
  const r = [];
  for (const y of TEST) {
    const tuneYears = [2019, 2020, 2021, 2022, 2023, 2024, 2025].filter(x => x < y);
    const best = hists.filter(x => x.hp.a === a).map(x => ({ ...x, s: tuneBrier(x.h, tuneYears) })).sort((p, q) => p.s - q.s)[0];
    r.push(...liveOn(best.h, y));
  }
  const by = TEST.map(y => mean(r.filter(x => x.y === y).map(x => x.br)).toFixed(4)).join('/');
  console.log(`  a fixed at ${a.toFixed(2)}         ` + fmt(r) + `   by season ${by}`);
}
console.log(`  (live by season ${TEST.map(y => mean(res.base.filter(x => x.y === y).map(x => x.br)).toFixed(4)).join('/')})`);

// ── totals: same idea for the ridge total ──
const TGRID = [];
for (const tau of [40, 80]) for (const gamma of [0.1, 0.2]) for (const lambda of [8, 16, 32]) for (const a of [0, 0.25, 0.5, 0.75, 1]) TGRID.push({ tau, gamma, lambda, a });
const thists = TGRID.map(hp => ({ hp, h: totalHistory(hp) }));
const TOT = matches.map(m => m.homeScore + m.awayScore);
const maeOn = (h, years) => { const e = []; for (let i = 0; i < matches.length; i++) if (years.includes(Y[i]) && !isNaN(h[i])) e.push(Math.abs(TOT[i] - h[i])); return mean(e); };
const tb = [], tc = [];
for (const y of TEST) {
  const tuneYears = [2019, 2020, 2021, 2022, 2023, 2024, 2025].filter(x => x < y);
  const sc = thists.map(x => ({ ...x, s: maeOn(x.h, tuneYears) }));
  const bb = sc.filter(x => x.hp.a === 0).sort((p, q) => p.s - q.s)[0], bc = sc.sort((p, q) => p.s - q.s)[0];
  const live = (h, i) => (SMT[i] + h[i]) / 2;
  const eb = [], ec = [];
  for (let i = 0; i < matches.length; i++) if (Y[i] === y && okRow(i) && !isNaN(bb.h[i]) && !isNaN(bc.h[i])) { eb.push(Math.abs(TOT[i] - live(bb.h, i))); ec.push(Math.abs(TOT[i] - live(bc.h, i))); }
  tb.push(...eb); tc.push(...ec);
  console.log(`totals ${y}: points ${JSON.stringify(bb.hp)} MAE ${mean(eb).toFixed(2)} | tuned a ${JSON.stringify(bc.hp)} MAE ${mean(ec).toFixed(2)}`);
}
console.log(`Live total (avg of scoring model + ridge total), MAE 2024-26: points ridge ${mean(tb).toFixed(2)}  shots-blend ridge ${mean(tc).toFixed(2)}  (n=${tb.length})`);
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
