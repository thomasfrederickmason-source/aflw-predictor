// Walk-forward test: can a ridge attack/defence model improve the TOTAL?
// (2026-10-02, same day the ridge margin rating went live.)
//
// Live total = the scoring model (score-model.js: multiplicative attack x
// defence, EMA-updated). Candidate: before each match, refit additive team
// ratings to ALL earlier team scores at once --
//   points = league level + attack(team) - defence(opponent) + home edge
// -- weighted like the ridge margin rating (recent rounds most, earlier
// seasons discounted, ridge pull to average). Settings are tuned on earlier
// seasons only for each test season (nested walk-forward), then the total is
// scored on 2024-26 against the scoring model and a blend of the two.
//
// Usage: node total-candidates.js

const fs = require('fs');
const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeScore != null && m.awayScore != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));
const score = new Map(JSON.parse(fs.readFileSync('data/score_history.json', 'utf8')).map(s => [s.matchId, s]));
const year = m => Number((m.season.match(/\d{4}/) || [0])[0]);
const seasonFirst = {};
for (const m of matches) if (!(m.season in seasonFirst)) seasonFirst[m.season] = new Date(m.date).getTime();
const seasonIdx = Object.fromEntries(Object.keys(seasonFirst).sort((a, b) => seasonFirst[a] - seasonFirst[b]).map((s, i) => [s, i]));
const roundKey = m => m.season + '|' + m.round;
const roundIdx = {};
{ let g = 0; for (const m of matches) if (!(roundKey(m) in roundIdx)) roundIdx[roundKey(m)] = g++; }
const teams = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]))].sort();
const ti = Object.fromEntries(teams.map((t, i) => [t, i]));
const T = teams.length;
const K = 2 * T + 2; // attack[T], defence[T], level, home

function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; if (!f) continue; for (let q = c; q < n; q++) A[r][q] -= f * A[c][q]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}
function ridgeTotals({ tau, gamma, lambda }) {
  const out = new Map();
  let lastT = -1, fit = null;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i], t0 = new Date(m.date).getTime();
    if (t0 !== lastT) {
      const A = Array.from({ length: K }, () => new Array(K).fill(0)), b = new Array(K).fill(0);
      let any = false;
      for (let j = 0; j < i; j++) {
        const p = matches[j];
        if (new Date(p.date).getTime() >= t0) break;
        const w = Math.pow(gamma, seasonIdx[m.season] - seasonIdx[p.season]) * Math.exp(-(roundIdx[roundKey(m)] - roundIdx[roundKey(p)]) / tau);
        if (w < 1e-6) continue;
        any = true;
        for (const [team, opp, pts, home] of [[p.homeTeam, p.awayTeam, p.homeScore, 1], [p.awayTeam, p.homeTeam, p.awayScore, 0]]) {
          const idx = [ti[team], T + ti[opp], 2 * T, 2 * T + 1], val = [1, -1, 1, home];
          for (let u = 0; u < 4; u++) { if (!val[u]) continue; b[idx[u]] += w * val[u] * pts; for (let v = 0; v < 4; v++) if (val[v]) A[idx[u]][idx[v]] += w * val[u] * val[v]; }
        }
      }
      for (let k = 0; k < 2 * T; k++) A[k][k] += lambda;
      A[2 * T][2 * T] += 1e-3; A[2 * T + 1][2 * T + 1] += 1;
      fit = any ? solve(A, b) : null;
      lastT = t0;
    }
    if (!fit) continue;
    const h = ti[m.homeTeam], a = ti[m.awayTeam];
    const homePts = fit[2 * T] + fit[h] - fit[T + a] + fit[2 * T + 1];
    const awayPts = fit[2 * T] + fit[a] - fit[T + h];
    out.set(m.matchId, homePts + awayPts);
  }
  return out;
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function rows(rt) {
  return matches.map(m => { const s = score.get(m.matchId); if (!s || !rt.has(m.matchId)) return null; return { y: year(m), sm: s.predHomeScore + s.predAwayScore, rt: rt.get(m.matchId), total: m.homeScore + m.awayScore }; }).filter(Boolean);
}
// Blend: total = a + b*sm + c*rt by least squares on earlier seasons.
function ols3(train) {
  const X = train.map(r => [1, r.sm, r.rt]), y = train.map(r => r.total);
  const A = Array.from({ length: 3 }, () => new Array(3).fill(0)), b = new Array(3).fill(0);
  X.forEach((x, i) => { for (let p = 0; p < 3; p++) { b[p] += x[p] * y[i]; for (let q = 0; q < 3; q++) A[p][q] += x[p] * x[q]; } });
  return solve(A, b);
}
const GRID = [];
for (const tau of [12, 20, 40, 80]) for (const gamma of [0.1, 0.2, 0.35, 0.5]) for (const lambda of [2, 4, 8, 16, 32, 64]) GRID.push({ tau, gamma, lambda });
const cache = new Map();
const rowsFor = hp => { const k = JSON.stringify(hp); if (!cache.has(k)) cache.set(k, rows(ridgeTotals(hp))); return cache.get(k); };
const res = { sm: [], rt: [], avg: [], ols: [] };
const t0 = Date.now();
for (const Y of [2024, 2025, 2026]) {
  let best = null;
  for (const hp of GRID) {
    const r = rowsFor(hp).filter(x => x.y >= 2019 && x.y < Y);
    const mae = mean(r.map(x => Math.abs(x.total - x.rt)));
    if (!best || mae < best.mae) best = { hp, mae };
  }
  const all = rowsFor(best.hp);
  const train = all.filter(x => x.y >= 2021 && x.y < Y), test = all.filter(x => x.y === Y);
  const w = ols3(train);
  for (const x of test) {
    res.sm.push(Math.abs(x.total - x.sm)); res.rt.push(Math.abs(x.total - x.rt));
    res.avg.push(Math.abs(x.total - (x.sm + x.rt) / 2)); res.ols.push(Math.abs(x.total - (w[0] + w[1] * x.sm + w[2] * x.rt)));
  }
  console.log(`${Y}: tuned on 2019-${Y - 1} -> tau=${best.hp.tau} gamma=${best.hp.gamma} lambda=${best.hp.lambda} | total MAE  scoring model ${mean(test.map(x => Math.abs(x.total - x.sm))).toFixed(2)}  ridge ${mean(test.map(x => Math.abs(x.total - x.rt))).toFixed(2)}  average ${mean(test.map(x => Math.abs(x.total - (x.sm + x.rt) / 2))).toFixed(2)}  fitted blend ${mean(test.map(x => Math.abs(x.total - (w[0] + w[1] * x.sm + w[2] * x.rt)))).toFixed(2)}`);
}
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)\n2024-26 total MAE (n=${res.sm.length}):  scoring model ${mean(res.sm).toFixed(2)}  |  ridge ${mean(res.rt).toFixed(2)}  |  average ${mean(res.avg).toFixed(2)}  |  fitted blend ${mean(res.ols).toFixed(2)}`);

// Does the averaged total also predict the FIRST HALF better? (If so, the
// 1st-half / 1st-quarter markets should scale with it rather than stay on the
// raw scoring model.) H1 total ~ c * full-game prediction, c fitted on
// earlier seasons only.
{
  const hp = { tau: 80, gamma: 0.1, lambda: 16 };
  const rt = ridgeTotals(hp);
  const r = matches.map(m => {
    const s = score.get(m.matchId);
    if (!s || !rt.has(m.matchId) || !Array.isArray(m.homeQtr) || m.homeQtr.length < 2) return null;
    const h1 = m.homeQtr[0] + m.homeQtr[1] + m.awayQtr[0] + m.awayQtr[1];
    const q1 = m.homeQtr[0] + m.awayQtr[0];
    const sm = s.predHomeScore + s.predAwayScore;
    return { y: year(m), sm, avg: (sm + rt.get(m.matchId)) / 2, h1, q1 };
  }).filter(Boolean);
  for (const [lab, key] of [['1st half', 'h1'], ['1st quarter', 'q1']]) {
    const e = { sm: [], avg: [] };
    for (const Y of [2024, 2025, 2026]) {
      const tr = r.filter(x => x.y >= 2021 && x.y < Y), te = r.filter(x => x.y === Y);
      for (const k of ['sm', 'avg']) {
        const c = tr.reduce((s, x) => s + x[key] * x[k], 0) / tr.reduce((s, x) => s + x[k] * x[k], 0);
        te.forEach(x => e[k].push(Math.abs(x[key] - c * x[k])));
      }
    }
    console.log(`${lab} total MAE 2024-26 (n=${e.sm.length}): from scoring-model total ${mean(e.sm).toFixed(2)}  |  from averaged total ${mean(e.avg).toFixed(2)}`);
  }
}
