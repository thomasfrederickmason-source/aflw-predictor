// Player values and lineup strength (added 2026-10-02, improvement-candidates.js).
//
// A player's value = her recency-weighted average fantasy points per game
// (half-life 20 games), shrunk toward what a newcomer typically scores (worth
// 4 games of evidence). Only games BEFORE the match being predicted count.
// A lineup's strength = the sum of its named players' values (emergencies
// excluded). What moves the prediction is how far today's lineup is from the
// team's USUAL strength (exponentially weighted over its previous lineups,
// 0.85 per game): the ratings already reflect the usual team, so only the
// difference is news. This covers game-day team news (a star out, a star
// back) AND off-season list changes (round 1 lineups vs last season's).
//
// Walk-forward 2024-26, applied to both halves of the win chance like team
// news: Brier 0.1666 vs 0.1735, log loss 0.5097 vs 0.5209, better in every
// season; rounds 1-3 (2019-26) 0.1676 vs 0.1724. Settings untuned: every
// half-life 10-40 / team decay 0.7-0.95 / prior 2-8 combination tested gave
// 0.169-0.171 (vs 0.1747 without, blend-only version).
//
// Data: data/player_stats.json (fetch-player-stats.js), data/rosters.json.

const fs = require('fs');

const HALF_LIFE = 20, DECAY = Math.pow(0.5, 1 / HALF_LIFE), PRIOR_N = 4, TEAM_DECAY = 0.85;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const namedIds = side => (side && side.positions ? side.positions : []).filter(p => p.position !== 'EMERG').map(p => p.playerId || (p.player && p.player.playerId)).filter(Boolean);

// Walks every completed match in date order. Returns the per-match pre-game
// lineup numbers (for the backtest) and the state as of now (for live use).
function buildPlayerValues() {
  const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
    .filter(m => m.homeScore != null && m.awayScore != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const rosters = JSON.parse(fs.readFileSync('data/rosters.json', 'utf8'));
  const pstats = JSON.parse(fs.readFileSync('data/player_stats.json', 'utf8'));

  const pv = new Map(); // playerId -> { s, w, games }
  const debutFP = [];
  let newcomerPrior = 30;
  const valueOf = id => { const p = pv.get(id); return p ? (p.s + PRIOR_N * newcomerPrior) / (p.w + PRIOR_N) : newcomerPrior; };
  const teamBase = new Map(); // team -> { s, w }
  const lastSize = new Map(); // team -> players in its latest lineup
  const baseOf = team => { const b = teamBase.get(team); return b ? b.s / b.w : null; };
  const strengthOf = ids => ids.reduce((acc, id) => acc + valueOf(id), 0);
  const history = new Map(); // matchId -> { homeDelta, awayDelta, net }

  for (const m of matches) {
    const ro = rosters[m.matchId];
    const lineup = {};
    if (ro) for (const [team, side] of [[m.homeTeam, ro.homeTeam], [m.awayTeam, ro.awayTeam]]) {
      const ids = namedIds(side);
      if (ids.length < 16) continue; // no usable team sheet
      const strength = strengthOf(ids), base = baseOf(team);
      lineup[team] = { strength, n: ids.length, delta: base == null ? null : strength - base };
    }
    const H = lineup[m.homeTeam], A = lineup[m.awayTeam];
    if (H && A && H.delta != null && A.delta != null) history.set(m.matchId, { homeDelta: H.delta, awayDelta: A.delta, net: H.delta - A.delta });
    // fold the match in, after "predicting" it
    for (const team of [m.homeTeam, m.awayTeam]) {
      const L = lineup[team];
      if (L) { const b = teamBase.get(team) || { s: 0, w: 0 }; teamBase.set(team, { s: b.s * TEAM_DECAY + L.strength, w: b.w * TEAM_DECAY + 1 }); lastSize.set(team, L.n); }
    }
    for (const p of pstats[m.matchId] || []) {
      if (p.fp == null) continue;
      const q = pv.get(p.id) || { s: 0, w: 0, games: 0 };
      if (q.games < 3) { debutFP.push(p.fp); if (debutFP.length > 400) debutFP.shift(); }
      pv.set(p.id, { s: q.s * DECAY + p.fp, w: q.w * DECAY + 1, games: q.games + 1 });
    }
    if (debutFP.length >= 50) newcomerPrior = mean(debutFP);
  }

  // Live: how far a named lineup is from the team's usual strength, in fantasy
  // points. null when the team isn't named yet, has no history, or the sheet is
  // still an extended squad (more players than a real lineup: early in the week
  // the emergencies are listed as interchange, so the final 21 isn't known).
  function lineupDelta(team, ids) {
    if (!ids || ids.length < 16) return null;
    if (lastSize.has(team) && ids.length > lastSize.get(team)) return null;
    const base = baseOf(team);
    return base == null ? null : strengthOf(ids) - base;
  }
  // the players whose absence/presence matters most, for the printout
  function biggestChanges(team, ids, usualIds, n = 3) {
    const now = new Set(ids), usual = new Set(usualIds);
    const outs = [...usual].filter(id => !now.has(id)).map(id => ({ id, v: valueOf(id) })).sort((a, b) => b.v - a.v).slice(0, n);
    const ins = [...now].filter(id => !usual.has(id)).map(id => ({ id, v: valueOf(id) })).sort((a, b) => b.v - a.v).slice(0, n);
    return { outs, ins };
  }
  return { history, valueOf, baseOf, lineupDelta, biggestChanges, newcomerPrior: () => newcomerPrior };
}

module.exports = { buildPlayerValues, namedIds };
