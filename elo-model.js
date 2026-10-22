// AFLW team-strength Elo model.
//
// Approach: standard Elo with a margin-of-victory multiplier (so a 60-point
// belting moves ratings more than a 1-point squeaker) and an empirically-fit
// home-ground advantage, run chronologically over the full match history.
// Ratings partially regress toward the league mean between seasons (new
// season = fresh opportunities, last year's form shouldn't fully carry over),
// and expansion teams enter at the *current* league-average rating rather
// than the global 1500 baseline, since they're joining an already-established
// competition, not starting the whole league from scratch.
//
// This gives: (1) a same-season-updating power rating per team, usable to
// generate win-probability and expected-margin predictions before each
// round, and (2) a backtest against both actual results and, where we have
// it, real bookmaker odds — to sanity-check the model before trusting it
// with money.

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const oddsData = JSON.parse(fs.readFileSync('data/matches_with_odds.json', 'utf8'));
const oddsById = new Map(oddsData.map(m => [m.matchId, m]));

// --- config ---
const START_RATING = 1500;
// Tuned via tune-elo.js grid search (minimizing walk-forward Brier score
// across all 726 matches) — K=40 was a clear, stable optimum (Brier rises
// monotonically past it up to K=200), HGA had almost no effect on
// calibration (15 vs 30 vs 45 all near-identical), regression=1/3 was best
// among {0, 0.2, 1/3, 0.5, 0.67}. Note this was tuned in-sample (same data
// being scored) — a mild overfitting risk worth revisiting once there's
// enough live-prediction history to validate out-of-sample.
const K_BASE = 40;
const SEASON_REGRESSION = 1 / 3;
const HGA_DEFAULT = 15;

// finals matches are lower sample size per team and can whipsaw ratings —
// still update on them, just don't let them dominate; no special-case for now,
// K_BASE applies uniformly (kept simple for v1).

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// MOV multiplier, same shape as FiveThirtyEight's NFL Elo: bigger margins move
// ratings more, but with diminishing returns, and it's dampened when the
// result was already expected (a big favourite blowing out a big underdog
// shouldn't swing ratings as much as an upset blowout).
// A draw used to give log(0 + 1) = 0, so it never moved anyone's rating even
// when a heavy favourite was held (12 draws since 2017). It now counts like a
// one-point game, with no winner for the autocorrelation term (2026-10-17;
// Brier 0.18760 -> 0.18758 all-time, 2024+ level).
function movMultiplier(margin, eloDiffWinner) {
  return Math.log(Math.max(Math.abs(margin), 1) + 1) * (2.2 / ((margin === 0 ? 0 : eloDiffWinner) * 0.001 + 2.2));
}

// Sort all matches chronologically (across season labels, which aren't sort-safe as strings).
const sorted = matches
  .filter(m => m.homeScore != null && m.awayScore != null)
  .sort((a, b) => new Date(a.date) - new Date(b.date));

const ratings = new Map(); // team -> rating
let currentSeason = null;
const history = []; // per-match log for backtesting

function getRating(team) {
  if (!ratings.has(team)) {
    // New/expansion team: enter at the CURRENT league average, not the global
    // 1500 baseline, since they're joining an established competition.
    const vals = [...ratings.values()];
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : START_RATING;
    ratings.set(team, avg);
  }
  return ratings.get(team);
}

for (const m of sorted) {
  if (m.season !== currentSeason) {
    // New season: regress every existing team's rating toward the league mean.
    if (currentSeason !== null) {
      const vals = [...ratings.values()];
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      for (const [team, r] of ratings) ratings.set(team, r + (mean - r) * SEASON_REGRESSION);
    }
    currentSeason = m.season;
  }

  const homeR = getRating(m.homeTeam);
  const awayR = getRating(m.awayTeam);
  const homeExpected = expectedScore(homeR + HGA_DEFAULT, awayR);
  const homeActual = m.homeScore > m.awayScore ? 1 : m.homeScore < m.awayScore ? 0 : 0.5;

  const winnerEloDiff = m.homeScore >= m.awayScore ? (homeR + HGA_DEFAULT - awayR) : (awayR - homeR - HGA_DEFAULT);
  const mult = movMultiplier(m.margin, winnerEloDiff);
  const delta = K_BASE * mult * (homeActual - homeExpected);

  history.push({
    matchId: m.matchId, season: m.season, round: m.round, date: m.date,
    homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    homeRatingPre: homeR, awayRatingPre: awayR,
    homeWinProbModel: homeExpected,
    homeScore: m.homeScore, awayScore: m.awayScore, margin: m.margin, totalScore: m.totalScore,
    homeWin: m.homeScore > m.awayScore,
  });

  ratings.set(m.homeTeam, homeR + delta);
  ratings.set(m.awayTeam, awayR - delta);
}

// --- current ratings table ---
const finalRatings = [...ratings.entries()].sort((a, b) => b[1] - a[1]);
// Label from the newest match actually rated, not a hand-typed round.
const lastRated = matches.reduce((a, b) => (new Date(b.date) > new Date(a.date) ? b : a));
console.log(`=== Current AFLW Elo Ratings (after ${lastRated.season.replace(/ NAB AFLW Season$/, '')} ${lastRated.round}: ${lastRated.homeTeam} v ${lastRated.awayTeam}) ===`);
finalRatings.forEach(([team, r], i) => console.log(`${(i+1).toString().padStart(2)}. ${team.padEnd(20)} ${r.toFixed(0)}`));

// --- backtest: model calibration (Brier score) ---
function brierScore(rows, probKey, outcomeKey) {
  const sq = rows.map(r => Math.pow(r[probKey] - (r[outcomeKey] ? 1 : 0), 2));
  return sq.reduce((a, b) => a + b, 0) / sq.length;
}
const modelBrier = brierScore(history, 'homeWinProbModel', 'homeWin');
console.log(`\nModel Brier score (all ${history.length} matches, lower=better, 0.25=coin flip): ${modelBrier.toFixed(4)}`);

// accuracy (simple correct-favourite rate)
const correctPicks = history.filter(r => (r.homeWinProbModel > 0.5) === r.homeWin).length;
console.log(`Model favourite-picked-winner rate: ${(100*correctPicks/history.length).toFixed(1)}%`);

// --- compare to market, where we have odds ---
const withOdds = history
  .map(r => ({ ...r, odds: oddsById.get(r.matchId) }))
  .filter(r => r.odds && r.odds.homeAvgOdds && r.odds.awayAvgOdds);

// convert bookmaker decimal odds to implied prob, removing the overround (vig)
function marketImpliedProb(homeOdds, awayOdds) {
  const rawHome = 1 / homeOdds, rawAway = 1 / awayOdds;
  const overround = rawHome + rawAway;
  return rawHome / overround; // normalized home win prob
}
withOdds.forEach(r => { r.homeWinProbMarket = marketImpliedProb(r.odds.homeAvgOdds, r.odds.awayAvgOdds); });

const marketBrier = brierScore(withOdds, 'homeWinProbMarket', 'homeWin');
const modelBrierOnSameSet = brierScore(withOdds, 'homeWinProbModel', 'homeWin');
console.log(`\n=== Model vs market, on the ${withOdds.length} matches where we have both ===`);
console.log(`Model Brier:  ${modelBrierOnSameSet.toFixed(4)}`);
console.log(`Market Brier: ${marketBrier.toFixed(4)}  (market should generally win — it prices in team news/form the Elo model can't see)`);

// --- margin/total regression (simple linear fit for now) ---
function linreg(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a,b)=>a+b,0)/n, meanY = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  for (let i=0;i<n;i++){ num += (xs[i]-meanX)*(ys[i]-meanY); den += (xs[i]-meanX)**2; }
  const slope = num/den, intercept = meanY - slope*meanX;
  return { slope, intercept };
}
const eloDiffs = history.map(r => r.homeRatingPre + HGA_DEFAULT - r.awayRatingPre);
const margins = history.map(r => r.margin);
const { slope, intercept } = linreg(eloDiffs, margins);
console.log(`\n=== Margin model ===`);
console.log(`predicted margin = ${slope.toFixed(4)} * eloDiff + ${intercept.toFixed(2)}`);
const predictedMargins = eloDiffs.map(d => slope*d + intercept);
const marginErrors = predictedMargins.map((p,i) => Math.abs(p - margins[i]));
console.log(`Mean absolute error: ${(marginErrors.reduce((a,b)=>a+b,0)/marginErrors.length).toFixed(1)} points`);

// average total score, recent era only (matches README note that scoring has trended up)
const recentTotals = history.filter(r => r.season.includes('2025') || r.season.includes('2026')).map(r => r.totalScore);
console.log(`\nAvg total score, current era (2025-26): ${(recentTotals.reduce((a,b)=>a+b,0)/recentTotals.length).toFixed(1)}`);

fs.writeFileSync('data/elo_ratings.json', JSON.stringify(Object.fromEntries(finalRatings), null, 2));
fs.writeFileSync('data/elo_history.json', JSON.stringify(history, null, 2));
// Everything downstream that needs HGA or the Elo->margin line reads it from
// here. predict-round.js used to hand-copy these and they went stale (the
// intercept sat at 0.21 while this fit had moved to 0.37).
fs.writeFileSync('data/elo_params.json', JSON.stringify({
  k: K_BASE, hga: HGA_DEFAULT, seasonRegression: SEASON_REGRESSION,
  marginSlope: slope, marginIntercept: intercept,
  fittedOn: history.length, lastMatch: `${lastRated.season} ${lastRated.round}`, fittedAt: new Date().toISOString(),
}, null, 1));
console.log('\nWritten: data/elo_ratings.json, data/elo_history.json, data/elo_params.json');
