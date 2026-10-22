// Player-availability adjustment, validated in roster-signal-check.js
// against 726 matches of history: margin ≈ 0.087 * netOutsAdvantageUnplanned
// + 2.242, where netOutsAdvantageUnplanned is (away team's departed
// players' prior-games-played summed) minus (home team's), counting every
// out EXCEPT "Managed" planned rests (which are confounded with already
// being a heavy favourite and reverse/dilute the signal if included). That
// means Omitted (dropped by selectors) DOES count, exactly as it did in the
// validation -- Injured/Illness/Suspension/Personal Reason/Omitted.
//
// BUG FIXED 2026-09-25: the live team sheet nests the player id
// (out.player.playerId) while the stored history fetch-rosters.js writes is
// flattened (out.playerId). This file read only the flat form, so every live
// out looked up `undefined`, counted as 0 career games, and the adjustment
// was silently +0.0 on every prediction since it was added. Both shapes are
// read now (idOf below).
// Correlation is modest (r≈0.10 on margin) but real and monotonic across
// buckets — see README for the validation writeup. Treat this as a small
// nudge, not a headline feature.
//
// Practical limit: AFL.com.au only publishes team sheets ~1-2 days before
// a match (matchRoster returns empty ins/outs/positions with status
// "SCHEDULED" before then) — this can't inform predictions made further
// out, only ones re-run once teams are named.

// UPDATED 2026-09-25 from a walk-forward test (roster-backtest.js), which
// supersedes the correlation-only check above:
//  * only genuinely unavailable players count -- Injured, Illness,
//    Suspension, Personal Reason. Omitted (dropped for form) and Managed
//    (planned rest) are selection decisions, not lost strength; counting them
//    made Brier WORSE out of sample (0.1848 vs 0.1846 with no adjustment),
//    while the unavailable-only version improved it (0.1841).
//  * slope re-fitted against the Elo RESIDUAL with point-in-time career games:
//    ~0.064 pts per career game (t=2.4), not 0.087 (which was fitted against
//    raw margin with "games as of today").
// Both are re-fitted weekly by `roster-backtest.js --write` into
// data/model_params.json and read here.
const fs = require('fs');
let MARGIN_SLOPE = 0.0638;
let COUNTED_REASONS = new Set(['Injured', 'Illness', 'Suspension', 'Personal Reason']);
let ELO_MARGIN_SLOPE = 0.0843; // margin points per Elo point, from elo-model.js
try {
  const p = JSON.parse(fs.readFileSync('data/model_params.json', 'utf8'));
  if (p.roster) { MARGIN_SLOPE = p.roster.slopePerCareerGame; COUNTED_REASONS = new Set(p.roster.countedReasons); }
} catch (e) { /* defaults above */ }
try { ELO_MARGIN_SLOPE = JSON.parse(fs.readFileSync('data/elo_params.json', 'utf8')).marginSlope; } catch (e) { /* default */ }

let cachedToken = null;
async function getToken() {
  if (cachedToken) return cachedToken;
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' },
  });
  const { token } = await res.json();
  cachedToken = token;
  return token;
}

// Games-played counts as of "now" for every player who has ever appeared,
// built from the full historical roster set. Good enough for a live
// upcoming-round adjustment (doesn't need to be point-in-time-accurate the
// way the historical backtest does).
function buildCareerGamesPlayed(rosters) {
  const gamesPlayed = new Map();
  for (const matchId in rosters) {
    const r = rosters[matchId];
    for (const side of [r.homeTeam, r.awayTeam]) {
      if (!side) continue;
      for (const p of side.positions) {
        gamesPlayed.set(p.playerId, (gamesPlayed.get(p.playerId) || 0) + 1);
      }
    }
  }
  return gamesPlayed;
}

// Live AFL.com.au team sheets nest the id under .player; stored history is flat.
function idOf(entry) { return (entry && entry.player && entry.player.playerId) || (entry && entry.playerId) || null; }

function unplannedOutsImportance(side, gamesPlayed) {
  let sum = 0, n = 0;
  const names = [];
  for (const o of side.outs || []) {
    if (!COUNTED_REASONS.has(o.reason)) continue;
    const games = gamesPlayed.get(idOf(o)) || 0;
    sum += games;
    n++;
    const pn = o.player && o.player.playerName;
    names.push(`${pn ? pn.givenName + ' ' + pn.surname : o.name || idOf(o)} (${o.reason}, ${games} gms)`);
  }
  return { sum, n, names };
}

// Returns { marginAdjustment, eloDiffAdjustment, homeOuts, awayOuts } for a
// given matchId, or null if team sheets aren't out yet (roster empty).
async function getRosterAdjustment(matchId, gamesPlayed) {
  const token = await getToken();
  const res = await fetch(`https://api.afl.com.au/cfs/afl/matchRoster/full/${matchId}`, {
    headers: { 'x-media-mis-token': token },
  });
  if (!res.ok) return null;
  const d = await res.json();
  const mr = d.matchRoster;
  if (!mr || !mr.homeTeam || !mr.awayTeam) return null;
  if (!mr.homeTeam.positions || mr.homeTeam.positions.length === 0) return null; // team sheet not named yet

  const named = side => (side.positions || []).filter(p => p.position !== 'EMERG').map(p => idOf(p.player) || idOf(p)).filter(Boolean);
  const home = unplannedOutsImportance(mr.homeTeam, gamesPlayed);
  const away = unplannedOutsImportance(mr.awayTeam, gamesPlayed);
  const netAdvantage = away.sum - home.sum; // positive = home advantaged
  const marginAdjustment = MARGIN_SLOPE * netAdvantage;

  return {
    marginAdjustment,
    // The same shift expressed in Elo points (Elo's margin = slope * eloDiff),
    // so Elo's win probability moves by exactly marginAdjustment's worth.
    // (It used to pass netAdvantage straight through, which only worked
    // because the old 0.087 happened to be close to Elo's 0.084.)
    eloDiffAdjustment: marginAdjustment / ELO_MARGIN_SLOPE,
    homeOutsCount: home.n, awayOutsCount: away.n,
    homeOutsImportance: home.sum, awayOutsImportance: away.sum,
    homeOuts: home.names, awayOuts: away.names,
    // named 22s, for the lineup-strength adjustment (player-value.js)
    homeNamed: named(mr.homeTeam), awayNamed: named(mr.awayTeam),
  };
}

module.exports = { buildCareerGamesPlayed, getRosterAdjustment, MARGIN_SLOPE, idOf };
