// Generates model predictions for the upcoming round and saves a snapshot
// so it can be checked against the actual result once the round is played —
// this is the real out-of-sample test the historical backtest couldn't give us.
//
// HOW A PREDICTION IS BUILT (see MODEL.md for the full write-up):
//   1. Elo (results-based team strength) -> a win probability.
//   2. Scoring model (attack/defence) -> each side's points -> the TOTAL.
//   3. Ridge rating (every recent result refit at once) -> a margin.
//   4. Win chance = average of Elo's probability and a scoring-model + ridge
//      margin blend (walk-forward winner: rating-candidates.js, backtest-model.js).
//   5. ONE margin: the centre of the margin distribution that reproduces
//      that win chance. Predicted scores = (total ± margin) / 2.
//   So the predicted score, H2H, line and totals all tell the same story.
//   Adjustments: team news (unplanned outs), local-derby travel, weather.
//
// Also applies the player-availability adjustment (roster-adjustment.js,
// validated in roster-signal-check.js) when AFL.com.au has published team
// sheets for these matches — usually only ~1-2 days before the round, so
// re-run this script closer to game day to pick it up (it's a no-op, same
// prediction as before, on any match whose team sheet isn't named yet).

const fs = require('fs');
const { buildCareerGamesPlayed, getRosterAdjustment } = require('./roster-adjustment');
const { buildTeamHomeCities, getTravelAdjustment } = require('./travel-adjustment');
const { buildPlayerValues } = require('./player-value');
const { getConditionsAdjustment } = require('./weather-adjustment');

const ratings = JSON.parse(fs.readFileSync('data/elo_ratings.json', 'utf8'));
const scoreRatings = JSON.parse(fs.readFileSync('data/score_ratings.json', 'utf8'));
const upcomingOdds = JSON.parse(fs.readFileSync('data/upcoming_round_odds.json', 'utf8'));
const rosters = JSON.parse(fs.readFileSync('data/rosters.json', 'utf8'));
const historicalMatches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
let openmeteoForecast = [];
try { openmeteoForecast = JSON.parse(fs.readFileSync('data/openmeteo_forecast.json', 'utf8')); } catch (e) { /* run fetch-openmeteo-forecast.js first */ }
const weatherByTeamPair = new Map(openmeteoForecast.map(f => [`${f.homeTeam}|${f.awayTeam}`, f]));
const { normalCDF, marginForProb } = require('./stats');
// Every tuned number comes from the file the model that fitted it wrote --
// no hand-copied constants (the old MARGIN_INTERCEPT had gone stale).
const ELO_PARAMS = JSON.parse(fs.readFileSync('data/elo_params.json', 'utf8'));      // elo-model.js
const MODEL_PARAMS = JSON.parse(fs.readFileSync('data/model_params.json', 'utf8'));  // backtest-model.js --write
const RIDGE = JSON.parse(fs.readFileSync('data/ridge_ratings.json', 'utf8'));          // ridge-model.js
if (MODEL_PARAMS.blend.ridgeMargin == null) throw new Error('model_params.json predates the ridge blend -- run node backtest-model.js --write');
if (!RIDGE.totals) throw new Error('ridge_ratings.json has no totals block -- run node ridge-model.js');
const HGA = ELO_PARAMS.hga;
const AFLW_COMP_ID = 3;
// Round comes from the command line (node predict-round.js 6) so this and
// upcoming_round_odds.json can never silently disagree; defaults to 6.
const ROUND_NUMBER = Number(process.argv[2] || 6), SEASON_YEAR = process.argv[3] || '2026';
const SNAPSHOT_PATH = `data/round${ROUND_NUMBER}_${SEASON_YEAR}_prediction_snapshot.json`;

// oddsportal full names -> our short nicknames used as Elo keys
const TEAM_MAP = {
  'North Melbourne W': 'Kangaroos', 'Western Bulldogs W': 'Bulldogs',
  'Adelaide Crows W': 'Crows', 'West Coast Eagles W': 'Eagles',
  'Sydney Swans W': 'Swans', 'St Kilda W': 'St Kilda',
  'GWS Giants W': 'GIANTS', 'Port Adelaide W': 'Power',
  'Melbourne Demons W': 'Demons', 'Brisbane Lions W': 'Lions',
  'Collingwood Magpies W': 'Magpies', 'Hawthorn Hawks W': 'Hawks',
  'Gold Coast Suns W': 'SUNS', 'Geelong Cats W': 'Cats',
  'Fremantle Dockers W': 'Dockers', 'Carlton Blues W': 'Blues',
  'Essendon Bombers W': 'Bombers', 'Richmond W': 'Richmond',
};

// Venue town -> time zone, for fixtures written before fetch-upcoming-round.js
// carried venueTimezone (the kickoff-time term needs the LOCAL hour).
const TOWN_TZ = {
  Perth: 'Australia/Perth', Mandurah: 'Australia/Perth',
  Adelaide: 'Australia/Adelaide', Unley: 'Australia/Adelaide', Glenelg: 'Australia/Adelaide', 'Noarlunga Downs': 'Australia/Adelaide',
  Brisbane: 'Australia/Brisbane', 'Gold Coast': 'Australia/Brisbane', Ipswich: 'Australia/Brisbane', Stafford: 'Australia/Brisbane', Mackay: 'Australia/Brisbane', Cairns: 'Australia/Brisbane', Maroochydore: 'Australia/Brisbane', Brendale: 'Australia/Brisbane', Burpengary: 'Australia/Brisbane', Queensland: 'Australia/Brisbane',
  Darwin: 'Australia/Darwin', 'Alice Springs': 'Australia/Darwin',
  Hobart: 'Australia/Hobart', Launceston: 'Australia/Hobart',
  Sydney: 'Australia/Sydney', Canberra: 'Australia/Sydney', 'Coffs Harbour': 'Australia/Sydney', 'Wagga Wagga': 'Australia/Sydney', Marrickville: 'Australia/Sydney',
};

function expectedScore(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }
function marketImpliedProb(homeOdds, awayOdds) {
  const rawHome = 1 / homeOdds, rawAway = 1 / awayOdds;
  const overround = rawHome + rawAway;
  return { homeProb: rawHome / overround, overround };
}

// Trailing league-average team score, read from what score-model.js
// actually fitted (data/score_baseline.json) rather than hand-copied --
// the attack/defense ratings are relative to it, so the two must agree.
let LEAGUE_AVG_SCORE = 39.5;
try { LEAGUE_AVG_SCORE = JSON.parse(fs.readFileSync('data/score_baseline.json', 'utf8')).leagueAvgTeamScore; }
catch (e) { console.log('(no data/score_baseline.json -- run score-model.js; falling back to ' + LEAGUE_AVG_SCORE + ')'); }

// AFL.com.au nickname (matchItems) -> our short Elo-key nickname. Same
// short forms as TEAM_MAP's values, just here so we can match matchItems'
// team.nickname to upcomingOdds' already-mapped homeTeam/awayTeam.
const AFL_NICKNAME_TO_ELOKEY = {
  Kangaroos: 'Kangaroos', Bulldogs: 'Bulldogs', Crows: 'Crows', Eagles: 'Eagles',
  Swans: 'Swans', 'St Kilda': 'St Kilda', GIANTS: 'GIANTS', Power: 'Power',
  Demons: 'Demons', Lions: 'Lions', Magpies: 'Magpies', Hawks: 'Hawks',
  SUNS: 'SUNS', Cats: 'Cats', Dockers: 'Dockers', Blues: 'Blues',
  Bombers: 'Bombers', Richmond: 'Richmond',
  // matchItems still says "Freo" for 2026 fixtures (fetch-upcoming-round.js's
  // NICKNAME_FIXES). Without these, Dockers games silently got no matchId,
  // so no team-news or lineup adjustment (found 2026-10-09, round 9).
  Freo: 'Dockers', 'West Coast Eagles': 'Eagles',
};

async function getToken() {
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', {
    method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' },
  });
  return (await res.json()).token;
}

// Looks up matchIds for the configured round so we can check for a
// published team sheet per fixture. Best-effort: if this fails (API
// shape change, network issue), predictions still work, just without the
// roster adjustment.
async function getRoundMatchIds() {
  try {
    const token = await getToken();
    const seasonsRes = await fetch(`https://aflapi.afl.com.au/afl/v2/competitions/${AFLW_COMP_ID}/compseasons?pageSize=100`);
    const season = (await seasonsRes.json()).compSeasons.find(s => s.name.includes(SEASON_YEAR));
    if (!season) return {};
    const roundsRes = await fetch(`https://aflapi.afl.com.au/afl/v2/compseasons/${season.id}/rounds?pageSize=40`);
    const round = (await roundsRes.json()).rounds.find(r => r.roundNumber === ROUND_NUMBER);
    if (!round) return {};
    const itemsRes = await fetch(`https://api.afl.com.au/cfs/afl/matchItems/round/${round.providerId}`, {
      headers: { 'x-media-mis-token': token },
    });
    const items = (await itemsRes.json()).items || [];
    const byTeamPair = {};
    for (const item of items) {
      const home = AFL_NICKNAME_TO_ELOKEY[item.match.homeTeam.nickname];
      const away = AFL_NICKNAME_TO_ELOKEY[item.match.awayTeam.nickname];
      if (home && away) byTeamPair[`${home}|${away}`] = item.match.matchId;
    }
    return byTeamPair;
  } catch (e) {
    console.log(`(couldn't look up round matchIds for roster adjustment: ${e.message})`);
    return {};
  }
}

async function main() {
  const matchIdByTeamPair = await getRoundMatchIds();
  const gamesPlayed = buildCareerGamesPlayed(rosters);
  const teamHomeCity = buildTeamHomeCities(historicalMatches);
  const playerValues = buildPlayerValues();

  console.log(`=== Round ${ROUND_NUMBER}, ${SEASON_YEAR} - Model vs Market ===\n`);
  const predictions = [];
  for (const o of upcomingOdds) {
    const homeTeam = TEAM_MAP[o.homeTeam], awayTeam = TEAM_MAP[o.awayTeam];
    const homeR = ratings[homeTeam], awayR = ratings[awayTeam];
    if (homeR == null || awayR == null) { console.log(`SKIP (unmapped team): ${o.homeTeam} vs ${o.awayTeam}`); continue; }

    // ── 1. Adjustments ──────────────────────────────────────────────────
    // Travel: a local derby removes home-ground advantage (Elo points).
    let travelEloAdj = 0, travelNote = null;
    const travelAdj = getTravelAdjustment(homeTeam, awayTeam, o.venueTown, teamHomeCity);
    const isLocalDerby = !!(travelAdj && travelAdj.isLocalDerby);
    if (isLocalDerby) {
      travelEloAdj = travelAdj.eloDiffAdjustment;
      travelNote = 'local derby: both teams are based within 100km of the venue, so no home-ground advantage';
    }
    // Team changes: validated as a MARGIN effect (0.087 pts per career game
    // of the players out). Fed to Elo as the equivalent Elo points and to the
    // blend as the margin shift itself, so both halves feel the same size.
    let rosterEloAdj = 0, rosterMarginAdj = 0, rosterNote = null;
    let lineupShift = 0, lineupNote = 'final teams not named yet (or still an extended squad) -- no lineup adjustment';
    const matchId = matchIdByTeamPair[`${homeTeam}|${awayTeam}`];
    if (matchId) {
      const adj = await getRosterAdjustment(matchId, gamesPlayed);
      // Lineup strength vs each team's usual (player-value.js, 2026-10-02):
      // shifts both halves of the win chance, like the team-news adjustment.
      const hD = adj ? playerValues.lineupDelta(homeTeam, adj.homeNamed) : null;
      const aD = adj ? playerValues.lineupDelta(awayTeam, adj.awayNamed) : null;
      if (hD != null && aD != null) {
        lineupShift = MODEL_PARAMS.blend.lineupNet * (hD - aD);
        const fp = v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`;
        lineupNote = `${homeTeam} ${fp(hD)} / ${awayTeam} ${fp(aD)} fantasy pts vs their usual lineup -> ${lineupShift >= 0 ? '+' : ''}${lineupShift.toFixed(1)} pts to ${homeTeam}`;
      }
      if (adj && (adj.homeOutsCount || adj.awayOutsCount)) {
        rosterEloAdj = adj.eloDiffAdjustment;
        rosterMarginAdj = adj.marginAdjustment;
        const side = rosterMarginAdj >= 0 ? homeTeam : awayTeam;
        rosterNote = `+${Math.abs(rosterMarginAdj).toFixed(1)} pts to ${side}` +
          (adj.homeOuts.length ? ` | ${homeTeam} out: ${adj.homeOuts.join(', ')}` : '') +
          (adj.awayOuts.length ? ` | ${awayTeam} out: ${adj.awayOuts.join(', ')}` : '');
      }
    }

    // ── 2. The three underlying models ─────────────────────────────────
    // Elo: team strength from results (win probability).
    const eloDiff = homeR + HGA - awayR + travelEloAdj;
    const lineupEloAdj = lineupShift / ELO_PARAMS.marginSlope;
    const eloHomeProb = expectedScore(homeR + HGA + travelEloAdj + rosterEloAdj + lineupEloAdj, awayR);
    // Scoring model: attack/defence -> each side's points (drives the TOTAL).
    const homeSR = scoreRatings[homeTeam] || { attack: 1, defense: 1 };
    const awaySR = scoreRatings[awayTeam] || { attack: 1, defense: 1 };
    let smHome = LEAGUE_AVG_SCORE * homeSR.attack * awaySR.defense;
    let smAway = LEAGUE_AVG_SCORE * awaySR.attack * homeSR.defense;
    // Match conditions (conditions-model.js, since 2026-10-17): wind, the
    // CHANCE of rain and kickoff time move the total, with coefficients fitted
    // on the model's own total error. Kickoff time is always known; wind and
    // rain need a forecast (within ~15 days), otherwise they count as typical.
    const wx = weatherByTeamPair.get(`${o.homeTeam}|${o.awayTeam}`);
    const rainProb = wx ? (wx.duringMatchMaxRainProbPct != null ? wx.duringMatchMaxRainProbPct / 100 : (wx.duringMatchRainMm > 0.1 ? 1 : 0)) : null;
    const cond = getConditionsAdjustment({ windKmh: wx ? wx.duringMatchWindKmh : null, rainProb, rainMm: wx ? wx.duringMatchRainMm : null, kickoffMs: o.date * 1000, timeZone: o.venueTimezone || TOWN_TZ[o.venueTown] || 'Australia/Melbourne' });
    const weatherTotalAdj = cond.totalScoreAdjustment;
    smHome += weatherTotalAdj / 2;
    smAway += weatherTotalAdj / 2;
    const weatherNote = cond.note ? `${weatherTotalAdj >= 0 ? '+' : ''}${weatherTotalAdj.toFixed(1)} pts to the total (${cond.note})` : null;
    const smMargin = smHome - smAway;
    // Ridge rating: home advantage dropped for a local derby, like Elo's.
    const ridgeMargin = (RIDGE.ratings[homeTeam] || 0) - (RIDGE.ratings[awayTeam] || 0) + (isLocalDerby ? 0 : RIDGE.hga);

    // ── 3. Win probability: average of Elo and the scoring + ridge blend ─
    // (2026-10-02: beat the old Elo + scoring blend in a nested walk-forward
    // test, 2024-26 Brier 0.1785 vs 0.1805 -- rating-candidates.js. Averaging
    // with Elo stops any one model's blind spot running away with a price.)
    const B = MODEL_PARAMS.blend;
    const blendMargin = B.intercept + B.scoreModelMargin * smMargin + B.ridgeMargin * ridgeMargin + lineupShift + rosterMarginAdj;
    // P(margin > 0): an expected score (draw = half), like Elo's (2026-10-17)
    const blendHomeProb = 1 - normalCDF(0, blendMargin, B.residualSD);
    const modelHomeProb = (eloHomeProb + blendHomeProb) / 2;

    // ── 4. ONE margin, ONE total, and the scores that match both ────────
    // Margin = the centre of the margin distribution that reproduces the win
    // probability exactly (same formula the odds builder uses), so the line,
    // H2H and predicted score can never disagree again.
    const predictedMargin = marginForProb(modelHomeProb, MODEL_PARAMS.fullMarginSD);
    // Total = average of the scoring model's total and the ridge total
    // (2026-10-02, total-candidates.js: 2024-26 MAE 17.31 vs 17.89, better
    // every season). Weather is applied once, to the average. The ridge
    // home edge goes for a local derby, like home advantage everywhere else.
    const RT = RIDGE.totals;
    const ridgeTotal = 2 * RT.level + (RT.attack[homeTeam] || 0) - (RT.defence[awayTeam] || 0) + (RT.attack[awayTeam] || 0) - (RT.defence[homeTeam] || 0) + (isLocalDerby ? 0 : RT.home);
    const predTotal = ((smHome + smAway - weatherTotalAdj) + ridgeTotal) / 2 + weatherTotalAdj;
    const predHomeScore = Math.max(3, (predTotal + predictedMargin) / 2);
    const predAwayScore = Math.max(3, (predTotal - predictedMargin) / 2);

    const hasMarket = o.homeAvgOdds != null && o.awayAvgOdds != null;
    const market = hasMarket ? marketImpliedProb(o.homeAvgOdds, o.awayAvgOdds) : null;
    const edge = market ? modelHomeProb - market.homeProb : null;

    const fav = predictedMargin >= 0 ? homeTeam : awayTeam;
    const when = new Date(o.date * 1000).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', minute: '2-digit' });
    console.log(`${homeTeam} v ${awayTeam}  (${o.venue}, ${when})`);
    console.log(`  PREDICTION  ${homeTeam} ${predHomeScore.toFixed(1)} - ${predAwayScore.toFixed(1)} ${awayTeam}   ->  ${fav} by ${Math.abs(predictedMargin).toFixed(1)}, total ${predTotal.toFixed(1)}`);
    console.log(`  WIN CHANCE  ${homeTeam} ${(modelHomeProb * 100).toFixed(0)}% ($${(1 / modelHomeProb).toFixed(2)})  /  ${awayTeam} ${((1 - modelHomeProb) * 100).toFixed(0)}% ($${(1 / (1 - modelHomeProb)).toFixed(2)})`);
    console.log(`  built from  Elo ${(eloHomeProb * 100).toFixed(0)}% + blend ${(blendHomeProb * 100).toFixed(0)}% (averaged)   |   scoring model: ${smMargin >= 0 ? homeTeam : awayTeam} by ${Math.abs(smMargin).toFixed(1)}   |   ridge: ${ridgeMargin >= 0 ? homeTeam : awayTeam} by ${Math.abs(ridgeMargin).toFixed(1)}`);
    console.log(`  total from  scoring model ${(smHome + smAway - weatherTotalAdj).toFixed(1)} + ridge ${ridgeTotal.toFixed(1)} (averaged)${weatherTotalAdj ? `, then weather ${weatherTotalAdj >= 0 ? '+' : ''}${weatherTotalAdj.toFixed(1)}` : ''}`);
    console.log(`  lineups     ${lineupNote}`);
    if (rosterNote) console.log(`  team news   ${rosterNote}`);
    if (travelNote) console.log(`  travel      ${travelNote}`);
    if (weatherNote) console.log(`  weather     ${weatherNote}`);
    if (hasMarket) {
      console.log(`  market      ${homeTeam} ${(market.homeProb * 100).toFixed(0)}% ($${o.homeAvgOdds}) / ${awayTeam} ${((1 - market.homeProb) * 100).toFixed(0)}% ($${o.awayAvgOdds}), edge ${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}pp`);
    }
    console.log('');

    predictions.push({
      date: o.date, homeTeam, awayTeam, venue: o.venue,
      // The prediction -- all mutually consistent:
      modelHomeProb, predictedMargin, predHomeScore, predAwayScore, predTotal,
      // How it was built (kept for transparency and for the H1/Q1 markets,
      // which were validated on the raw scoring-model split):
      // totalScale: the 1st-half/1st-quarter markets scale the scoring model's
      // split by this, so they move with the full-game total (the averaged
      // total predicts H1 and Q1 totals better too: total-candidates.js).
      components: { eloHomeProb, blendHomeProb, blendMargin, eloDiff, ridgeMargin, ridgeTotal, scoreModelHome: smHome, scoreModelAway: smAway, totalScale: predTotal / (smHome + smAway) },
      rosterAdjustmentApplied: !!rosterNote, rosterNote, rosterMarginAdjustment: rosterMarginAdj,
      lineupShift, lineupNote,
      travelAdjustmentApplied: !!travelNote, travelNote,
      weatherAdjustmentApplied: !!weatherNote, weatherNote, conditionsTotalAdjustment: +weatherTotalAdj.toFixed(2),
      marketHomeOdds: o.homeAvgOdds, marketAwayOdds: o.awayAvgOdds,
      marketHomeProb: market ? market.homeProb : null,
      edge,
      // filled in after the round is played:
      actualHomeScore: null, actualAwayScore: null,
    });
  }

  const roundName = (upcomingOdds.find(o => o.roundName) || {}).roundName || `Round ${ROUND_NUMBER}`;
  const snapshot = { capturedAt: new Date().toISOString(), round: `Round ${ROUND_NUMBER}, ${SEASON_YEAR}`, roundName, predictions };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`Saved snapshot to ${SNAPSHOT_PATH} - re-check after the round for a real out-of-sample validation.`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
