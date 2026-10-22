// Turns the point predictions already in data/round5_2026_prediction_snapshot.json
// into full "true odds" (fair, no-vig, model-derived) across a betting-site
// style set of markets, for the mock artifact. Point predictions become
// probability distributions using empirical residual spreads fit against
// real match history (elo_history.json / score_history.json / matches.json),
// approximated as normal — a simplification worth stating plainly: these
// are illustrative "true odds" from this project's model, not a real
// market and not validated the way the moneyline/roster/travel/weather
// work earlier in this project was.
//
// Quarter/half-level TOTAL spreads use raw historical variance of actual
// Q1/H1 totals (not a residual against an independently-fitted Q1/H1
// model, since none exists) — checked whether blendShare's own total
// prediction has enough skill to justify a smaller residual SD instead,
// and it barely moves the number (H1 total: 12.87 unconditional vs 12.71
// residual, Q1: 9.18 vs 9.05) — blendShare mostly captures team-vs-team
// skill (who's better), which matters for MARGIN, not the overall scoring
// pace of a game, which matters for TOTAL. Not worth the change.
//
// Q1/H1 MARGIN spreads, by contrast, USED to be the same kind of raw
// unconditional variance (19.64 / 11.86) — but blendShare's own margin
// prediction turned out to have real skill (its residual SD is
// meaningfully smaller: measured directly against 243 real matches). Using
// the unconditional variance alongside a real, skilled prediction was
// needlessly wide the whole time. Fixed to the residual SD around the
// SAME calibrated margin the model actually uses (see RHO_H1_FULL/
// RHO_Q1_FULL below) — backtested via the usual PIT calibration check:
// H1 chi2 goes from 15.15 (barely passing) to 2.23; Q1 from 9.22 to 3.79.
// Log-likelihood improves too, not just the calibration shape.
const fs = require('fs');

// Snapshot path comes from the command line (node betting-odds-model.js 6)
// so this never has to be hand-edited in step with predict-round.js.
const ROUND = Number(process.argv[2] || 6), SEASON = process.argv[3] || '2026';
const SNAPSHOT_PATH = `data/round${ROUND}_${SEASON}_prediction_snapshot.json`;
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
const profiles = JSON.parse(fs.readFileSync('data/quarter_profiles.json', 'utf8'));

// ---- empirical spreads ----
// Full-game spreads are re-fitted every week by backtest-model.js --write
// (modern era, 2024+) into data/model_params.json. 2026-09-25: the margin
// SD moved 24.90 -> ~25.75 (max likelihood on 282 modern matches; the old
// value passed calibration but ran slightly narrow, overpopulating both
// tails -- scoring is up, so margins spread wider than the all-history fit).
let MODEL_PARAMS = null;
try { MODEL_PARAMS = JSON.parse(fs.readFileSync('data/model_params.json', 'utf8')); }
catch (e) { console.log('(no data/model_params.json -- run backtest-model.js --write; using built-in spreads)'); }
// H1/Q1 total spreads re-measured weekly since 2026-10-17 (model_params.halves,
// backtest-model.js); the margin spreads are residuals around the propagated
// margin, validated together with RHO_H1_FULL/RHO_Q1_FULL, so they stay fixed.
const HALVES = MODEL_PARAMS && MODEL_PARAMS.halves ? MODEL_PARAMS.halves : null;
const SD = {
  q1: { margin: 10.71, total: HALVES ? HALVES.q1TotalSD : 9.18 },
  h1: { margin: 16.89, total: HALVES ? HALVES.h1TotalSD : 12.87 },
  full: { margin: MODEL_PARAMS ? MODEL_PARAMS.fullMarginSD : 24.90, total: 21.23 },
};
const RHO_H1_FULL = 0.856;
const RHO_Q1_FULL = 0.613; // real Q1-vs-full margin correlation, current era — stable at 0.617/0.608 split across both halves of the data
// The H1/Q1 propagation coefficient (rho * sd_h1 / sd_full) is a regression
// slope measured together with sd_full = 24.90 when H1/Q1 were validated --
// keep that validated pairing even though the PRICING SD for the full-game
// margin is now re-fitted above.
const SD_FULL_AT_H1Q1_VALIDATION = 24.90;

// ---- First to Score / First Goal (full game only) ----
// Fitted by logistic regression of each match's pre-match Elo win probability
// against which team actually scored first / kicked the first goal, using
// the full scoring-event history (data/scoring_events.json, 2017-2026,
// n=726): logit(P(home first)) = a + b*logit(homeWinProb). Both real, not
// noise (LR test vs. an intercept-only null: First Score LR=15.46, First
// Goal LR=35.19 — both far past the 1-df chi-sq critical value of 10.83 at
// p<0.001), and calibration checked by decile of win probability (predicted
// tracks observed within sampling noise across all 10 bins). First Goal is
// the stronger/cleaner signal (b=0.36 vs 0.23) — behinds add scrappy noise
// (rushed behinds, stray touches) that a goal doesn't have, so who kicks the
// first major is a better tell of team quality than who scores first at all.
// Both coefficients are compressed well below 1 — first-score/first-goal is
// a much weaker signal of team strength than the full match result, exactly
// as you'd expect from one early, mostly-lucky event in a low-scoring sport.
const FIRST_SCORE_COEF = { a: -0.0588, b: 0.2329 };
const FIRST_GOAL_COEF = { a: 0.0799, b: 0.3595 };

function logit(p) { const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(c / (1 - c)); }
function invLogit(x) { return 1 / (1 + Math.exp(-x)); }

// Whether that first score is a goal or a behind is independent of which
// team gets it, and independent of team strength — checked directly against
// history: P(goal | home scored first)=0.522 vs P(goal | away scored
// first)=0.478 (well within sampling noise for n~360 each), and
// corr(homeWinProb, first score is goal)=0.028 with no trend across win-
// probability deciles. So "first scoring play" (team x type) factors
// cleanly as P(team first) x P(goal | first), with the latter a flat 0.500
// (363 goals / 363 behinds out of 726 matches — a dead 50/50 split).
const P_FIRST_SCORE_IS_GOAL = 0.5;

function buildFirstScoreMarkets(pHome) {
  const x = logit(pHome);
  const pHomeFirstScore = invLogit(FIRST_SCORE_COEF.a + FIRST_SCORE_COEF.b * x);
  const pHomeFirstGoal = invLogit(FIRST_GOAL_COEF.a + FIRST_GOAL_COEF.b * x);
  const pAwayFirstScore = 1 - pHomeFirstScore;
  return {
    firstScore: { homeOdds: probToOdds(pHomeFirstScore), awayOdds: probToOdds(pAwayFirstScore) },
    firstGoal: { homeOdds: probToOdds(pHomeFirstGoal), awayOdds: probToOdds(1 - pHomeFirstGoal) },
    firstScoringPlay: {
      homeGoal: probToOdds(pHomeFirstScore * P_FIRST_SCORE_IS_GOAL),
      homeBehind: probToOdds(pHomeFirstScore * (1 - P_FIRST_SCORE_IS_GOAL)),
      awayGoal: probToOdds(pAwayFirstScore * P_FIRST_SCORE_IS_GOAL),
      awayBehind: probToOdds(pAwayFirstScore * (1 - P_FIRST_SCORE_IS_GOAL)),
    },
  };
}

// ---- team total (full game only): skew-corrected, not plain normal ----
// A single team's full-game score isn't symmetric around its prediction —
// it's bounded below by 0 but not above, so blowouts stretch a real right
// tail that a plain normal doesn't have. Measured on RESIDUALS (actual -
// predicted score, from data/score_history.json, current era 2024+) so
// team-strength differences aren't mistaken for skew — the residual is
// what's left after the prediction already accounts for who's playing.
// Backtested against all 726 real matches via a PIT calibration check
// (are real outcomes' percentiles under the model uniformly distributed,
// as they should be for a correctly-shaped distribution): plain normal
// chi2=28.99 against a p<.05 threshold of 16.9 — fails; skew-normal
// chi2=8.41 — passes clean. This is the only market using it (see the
// buildTeamTotalMarket / skewNormalCDF machinery below) since it's the
// only one validated against real residuals at this level so far.
// Re-measured weekly by backtest-model.js around the COHERENT team scores
// ((total ± margin)/2) the board now shows -- 2026-09-25: 17.49 / 0.556,
// essentially the old values, so the skew-normal shape carries over.
const TEAM_TOTAL_SD = MODEL_PARAMS ? MODEL_PARAMS.teamScore.residualSD : 17.52;
const TEAM_TOTAL_SKEW = MODEL_PARAMS ? MODEL_PARAMS.teamScore.skew : 0.597;

// ---- match total (full game only): also skew-corrected, weaker skew ----
// Measured directly on MATCH total residuals (actual combined score -
// predicted combined score), not copied from the team-total skew above —
// skew doesn't carry over additively when you sum two teams' scores. A
// blowout for one side often coincides with a low score for the other, so
// the two teams' residuals aren't independent/reinforcing: if they were
// independent with equal sd/skew, combining them would predict skew ~0.42,
// but the real measured match-total skew is ~0.25 — confirms real
// cancellation, not just independence-driven dilution. Stable across 4
// data splits (0.19-0.31, current era). Backtest: plain normal was already
// passing calibration here (chi2=10.31 vs a 16.9 threshold, unlike team
// totals' 28.99) — skew-normal still measurably improves it (chi2=7.86,
// log-likelihood ratio 1.005), just a smaller fix than the team-total one.
const MATCH_TOTAL_SD = MODEL_PARAMS ? MODEL_PARAMS.matchTotalSD : 22.03; // 22.77 on 2024+ as of 2026-09-25
const MATCH_TOTAL_SKEW = 0.248;

// ---- normal distribution helpers ----
function erf(x) {
  // Abramowitz-Stegun approximation, good to ~1e-7
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t = 1/(1+p*x);
  const y = 1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normalCDF(x, mean=0, sd=1) { return 0.5*(1+erf((x-mean)/(sd*Math.SQRT2))); }
function normalPDF(x, mean=0, sd=1) { return Math.exp(-((x-mean)**2)/(2*sd*sd)) / (sd*Math.sqrt(2*Math.PI)); }

// Inverse standard normal CDF (probit), Acklam's rational approximation —
// used to find the margin-distribution mean that exactly reproduces the
// calibrated Elo win probability, so H2H and every margin-derived market
// (line, bands, alt lines) stay consistent with each other instead of the
// margin-normal model silently disagreeing with the validated Elo number.
function invNormalCDF(p) {
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pLow=0.02425, pHigh=1-pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2*Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2*Math.log(1-p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// bivariate normal CDF via numerical integration of the conditional
// distribution: Phi2(x,y;rho) = integral_{-inf}^{x} phi(t) * CDF((y-rho*t)/sqrt(1-rho^2)) dt
function bivariateNormalCDF(x, y, rho, steps = 4000) {
  // x is a z-score, but callers also pass huge sentinel values standing in for
  // +/-infinity (see betting-odds-model's grid cuts) — those blow z1/z2 up to
  // +-50000+, which forces dt so coarse the integral silently collapses to
  // garbage. Beyond +-8 the standard normal PDF is ~0, so clamp the upper
  // bound there; it doesn't change the true integral (negligible mass past 8)
  // and keeps steps sized to where the density actually lives.
  const lo = -8, hi = Math.min(x, 8);
  if (hi <= lo) return 0;
  const dt = (hi - lo) / steps;
  const denom = Math.sqrt(1 - rho * rho);
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const t = lo + i * dt;
    const w = (i === 0 || i === steps) ? 0.5 : 1;
    sum += w * normalPDF(t) * normalCDF((y - rho * t) / denom);
  }
  return sum * dt;
}

// Skew-normal distribution: same family as the normal, plus one shape
// parameter for asymmetry (alpha=0 reduces to a plain normal). Fit here by
// method of moments from a target mean/sd/skew — standard closed-form
// formulas, e.g. Azzalini (1985). Compute delta from skewness, alpha from
// delta, then omega/xi so the fitted distribution's own mean and sd exactly
// match the targets (not just its scale parameter).
function fitSkewNormal(targetMean, targetSD, targetSkew) {
  const g1 = Math.max(-0.99, Math.min(0.99, targetSkew)); // |skew| < ~0.995 is the family's hard limit
  const term = Math.pow(Math.abs(g1) * 2 / (4 - Math.PI), 2 / 3);
  const delta = Math.sign(g1) * Math.sqrt(Math.PI / 2 * term / (1 + term));
  const alpha = delta / Math.sqrt(1 - delta * delta);
  const omega = targetSD / Math.sqrt(1 - 2 * delta * delta / Math.PI);
  const xi = targetMean - omega * delta * Math.sqrt(2 / Math.PI);
  return { xi, omega, alpha };
}

// No closed form — numerically integrate the skew-normal PDF, same
// trapezoidal approach as bivariateNormalCDF above.
function skewNormalCDF(x, xi, omega, alpha, steps = 1500) {
  const lo = xi - 8 * omega, hi = x;
  if (hi <= lo) return 0;
  const dt = (hi - lo) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const t = lo + i * dt;
    const w = (i === 0 || i === steps) ? 0.5 : 1;
    const z = (t - xi) / omega;
    sum += w * (2 / omega) * normalPDF(z) * normalCDF(alpha * z);
  }
  return sum * dt;
}

function probToOdds(p) {
  const clamped = Math.min(Math.max(p, 0.001), 0.999);
  return +(1 / clamped).toFixed(2);
}

// The "main" line shown for every over/under-style market should be the
// real fair coin-flip point (real bookmakers set their line this way too —
// it's what makes the market a genuine contest), NOT just the point
// forecast rounded to a half-integer. Those only coincide when the
// distribution is symmetric; for a skewed one they can be several points
// apart (found live: Kangaroos' team total was showing 63.5 @ 2.21/1.83 as
// "the" line, when the real 50/50 point is 61.5 @ 2.01/1.99 — two points
// off, entirely from using the mean instead of the median-ish point).
// Scans half-integer candidates around the point forecast and keeps
// whichever is closest to a literal 50/50 split. For a symmetric
// distribution (plain normal) this returns exactly the same value the old
// round-to-nearest-half-point logic did, so it's a safe, principled
// replacement everywhere, not just for the skewed markets.
function findFiftyFiftyLine(cdfAt, guess, radius) {
  const center = Math.round(guess);
  let best = center + 0.5, bestDiff = Infinity;
  for (let k = -radius; k <= radius; k++) {
    const line = center + k + 0.5;
    const d = Math.abs(cdfAt(line) - 0.5);
    if (d < bestDiff) { bestDiff = d; best = line; }
  }
  return best;
}

// P(draw) = P(margin falls in the continuity-corrected band around the
// single integer value 0), i.e. [-0.5, 0.5] — matches are integer-scored,
// so this is the standard continuity correction for approximating a
// discrete point mass with a continuous normal, and matches the same
// +-0.5 convention bandProbs() already uses for every other integer
// margin bucket below. (This used to be a +-1 band, which is wide enough
// to double-count part of the margin=1 and margin=-1 outcomes — real,
// decisive 1-point wins — into the draw price, inflating it.)
function marginProbs(predMargin, sd) {
  const pHome = 1 - normalCDF(0.5, predMargin, sd);
  const pAway = normalCDF(-0.5, predMargin, sd);
  const pDraw = 1 - pHome - pAway;
  return { pHome, pAway, pDraw: Math.max(pDraw, 0) };
}

function bandProbs(predMargin, sd, bands) {
  // bands: array of [lo,hi] inclusive point-margin ranges, e.g. [1,24]
  // returns per-band prob for home winning by that much, and away
  const out = [];
  for (const [lo, hi] of bands) {
    const homeP = normalCDF(hi + 0.5, predMargin, sd) - normalCDF(lo - 0.5, predMargin, sd);
    const awayP = normalCDF(-lo + 0.5, predMargin, sd) - normalCDF(-hi - 0.5, predMargin, sd);
    out.push({ range: hi === Infinity ? `${lo}+` : `${lo}-${hi}`, homeP: Math.max(homeP,0), awayP: Math.max(awayP,0) });
  }
  return out;
}

// Anchored on mainLine (the exact half-point line already quoted as the
// "current" line for this market) and stepped outward symmetrically, so
// mainLine is always exactly one of the returned entries — the picker UI
// looks up the current line by exact value to know which entry to show
// as selected by default. (Previously this derived its own center from
// predMargin independently of the real line's rounding, so the two only
// coincided by chance — most of the time the "current" line wasn't in
// its own alt-line list at all.)
function altLines(mainLine, predMargin, sd, step, span) {
  const lines = [];
  const n = Math.floor(span / step);
  for (let k = -n; k <= n; k++) {
    const line = mainLine + k * step;
    const homeP = 1 - normalCDF(line, predMargin, sd); // home covers if margin > line
    lines.push({ line: +line.toFixed(1), homeOdds: probToOdds(homeP), awayOdds: probToOdds(1 - homeP) });
  }
  return lines;
}

function altTotals(mainTotal, predTotal, sd, step, span) {
  const lines = [];
  const n = Math.floor(span / step);
  for (let k = -n; k <= n; k++) {
    const line = mainTotal + k * step;
    const overP = 1 - normalCDF(line, predTotal, sd);
    lines.push({ line: +line.toFixed(1), overOdds: probToOdds(overP), underOdds: probToOdds(1 - overP) });
  }
  return lines;
}

// Same anchor-on-mainTotal stepping as altTotals(), but priced off a fitted
// skew-normal instead of a plain one — shared by the match Total Points
// market and Team Total below.
function skewAltTotals(mainTotal, xi, omega, alpha, step, span) {
  const lines = [];
  const n = Math.floor(span / step);
  for (let k = -n; k <= n; k++) {
    const line = mainTotal + k * step;
    if (line < 0) continue;
    const overP = 1 - skewNormalCDF(line, xi, omega, alpha);
    lines.push({ line: +line.toFixed(1), overOdds: probToOdds(overP), underOdds: probToOdds(1 - overP) });
  }
  return lines;
}

// Full-game Team Total — the one market that uses the skew-corrected
// distribution (see TEAM_TOTAL_SD/SKEW above) instead of a plain normal.
function buildTeamTotalMarket(predScore) {
  const { xi, omega, alpha } = fitSkewNormal(predScore, TEAM_TOTAL_SD, TEAM_TOTAL_SKEW);
  const cdfAt = (line) => skewNormalCDF(line, xi, omega, alpha);
  const value = Math.max(0.5, findFiftyFiftyLine(cdfAt, predScore, 15));
  const overP = 1 - skewNormalCDF(value, xi, omega, alpha);
  return {
    predScore: +predScore.toFixed(1),
    value,
    overOdds: probToOdds(overP),
    underOdds: probToOdds(1 - overP),
    altTotals: skewAltTotals(value, xi, omega, alpha, 1, 30),
  };
}

// ---- 1st Quarter only: discrete, texture-corrected distribution ----
// The "Behind Tax" analysis (5,808 real AFLW team-quarters) found the
// continuous-normal approximation used everywhere else in this file is a
// poor fit specifically at 1st-quarter level: a quarter score is always
// 6*goals + 1*behind, so for any given shot count only every 5th total is
// even reachable, and real quarter shot counts are low enough (~3-8) that
// this doesn't average out into something smooth. Totals landing one or
// two points above a multiple of 6 are structurally common (a mostly-goals
// quarter); totals four or five points above are structurally rare (needs
// an unusually behind-heavy conversion rate) — chi-square against a
// smoothed local baseline came back at 2247, against a p<.05 threshold of
// just 55. Quarter margins show the same effect, weaker (198 vs a
// threshold of 80). Full Game and 1st Half keep the smooth continuous
// model: the same test found the effect washes out to non-significant
// (full margin) or only barely over the line (full total) there.
//
// TEXTURE below is the empirical (observed count / smoothed local trend)
// ratio by residue, fit against that real data. It's applied as a
// multiplicative correction to the continuity-corrected normal PMF, then
// renormalized — so every Q1 market (H2H, line, total, bands, alt lines)
// derives from one consistent, real-shaped discrete distribution instead
// of a smooth curve that's measurably wrong at this level.
const Q1_TOTAL_TEXTURE = [1.0863, 1.4502, 1.2811, 0.8177, 0.4521, 0.1948]; // index = value mod 6
const Q1_MARGIN_TEXTURE = [1.0325, 0.9899, 0.8233, 0.7833, 0.8210, 1.0423]; // index = ((value%6)+6)%6
const Q1_MARGIN_MAX = 120; // PMF support; a Q1 margin this large has ~zero real probability either way
const Q1_TOTAL_MAX = 200; // PMF support; a Q1 total this large has ~zero real probability

// Q1 MARGIN: built by directly enumerating goals/behinds rather than the
// texture-corrected normal above. At quarter level the counts are small
// enough (~1.3 goals, ~1.6 behinds a side) that WHICH combination of goals
// and behinds produces a given margin matters — e.g. +10 via "1 goal + 4
// points" vs "2 goals - 2 points" aren't interchangeable, they have
// genuinely different real-world likelihoods depending on actual scoring
// rates, and a single scalar texture-by-margin-mod-6 correction can't tell
// them apart. Modelled as independent Poisson(goals)/Poisson(behinds) for
// each team (mean/variance ratio checked against real Q1 counts: goals
// 1.08, behinds 1.25 — close enough to Poisson for this), goals/behinds
// rates split from the calibrated predicted score via the era's real Q1
// conversion rate (ACC_Q1=0.462, measured on scoring_events.json 2024+, n=
// 486 team-quarters). Backtested via the same PIT/chi-square method used
// throughout this file, on the same 243-match 2024+ era sample: this beats
// the old texture-normal model for MARGIN specifically (chi2 8.23 -> 3.30,
// and stable in both halves of the data: 8.83->4.54 / 10.62->7.34) — but
// tried the same enumeration for Q1 TOTAL too and it was WORSE there
// (chi2 4.45 -> 10.79, and fails the second-half split at 15.70), so TOTAL
// still uses the texture-normal model below; only MARGIN was swapped.
const ACC_Q1 = 0.462;
const PTS_PER_SHOT_Q1 = 6 * ACC_Q1 + 1 * (1 - ACC_Q1);
const Q1_ENUM_MAX_GOALS = 10, Q1_ENUM_MAX_BEHINDS = 14;

function poissonPMF(lambda, maxK) {
  const pmf = new Array(maxK + 1);
  pmf[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxK; k++) pmf[k] = pmf[k - 1] * lambda / k;
  return pmf;
}

function q1MarginPMFFromScore(effHome, effAway) {
  const homeShots = Math.max(0.5, effHome) / PTS_PER_SHOT_Q1, awayShots = Math.max(0.5, effAway) / PTS_PER_SHOT_Q1;
  const hgP = poissonPMF(homeShots * ACC_Q1, Q1_ENUM_MAX_GOALS);
  const hbP = poissonPMF(homeShots * (1 - ACC_Q1), Q1_ENUM_MAX_BEHINDS);
  const agP = poissonPMF(awayShots * ACC_Q1, Q1_ENUM_MAX_GOALS);
  const abP = poissonPMF(awayShots * (1 - ACC_Q1), Q1_ENUM_MAX_BEHINDS);
  const pmf = {};
  for (let hgk = 0; hgk <= Q1_ENUM_MAX_GOALS; hgk++) {
    for (let hbk = 0; hbk <= Q1_ENUM_MAX_BEHINDS; hbk++) {
      const pHomeScore = hgP[hgk] * hbP[hbk];
      if (pHomeScore < 1e-9) continue;
      const homeScore = hgk * 6 + hbk;
      for (let agk = 0; agk <= Q1_ENUM_MAX_GOALS; agk++) {
        for (let abk = 0; abk <= Q1_ENUM_MAX_BEHINDS; abk++) {
          const p = pHomeScore * agP[agk] * abP[abk];
          if (p < 1e-9) continue;
          const margin = homeScore - (agk * 6 + abk);
          pmf[margin] = (pmf[margin] || 0) + p;
        }
      }
    }
  }
  return pmf;
}

function buildDiscretePMF(mean, sd, texture, minK, maxK, floorAtZero) {
  const raw = {};
  for (let k = minK; k <= maxK; k++) {
    let p;
    if (floorAtZero && k === 0) {
      p = normalCDF(0.5, mean, sd); // quarter totals can't be negative — fold all sub-0 mass into k=0
    } else {
      p = Math.max(normalCDF(k + 0.5, mean, sd) - normalCDF(k - 0.5, mean, sd), 0);
    }
    const r = ((k % 6) + 6) % 6;
    raw[k] = p * texture[r];
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  const pmf = {};
  for (const k in raw) pmf[k] = raw[k] / sum; // renormalize back to a proper distribution
  return pmf;
}

function pmfSum(pmf, lo, hi) {
  let s = 0;
  for (let k = lo; k <= hi; k++) { const v = pmf[k]; if (v) s += v; }
  return s;
}

function q1AltLines(mainLine, pmf, step, span) {
  const lines = [];
  const n = Math.floor(span / step);
  for (let k = -n; k <= n; k++) {
    const line = mainLine + k * step;
    const homeP = pmfSum(pmf, Math.ceil(line), Q1_MARGIN_MAX);
    lines.push({ line: +line.toFixed(1), homeOdds: probToOdds(homeP), awayOdds: probToOdds(1 - homeP) });
  }
  return lines;
}

function q1AltTotals(mainTotal, pmf, step, span) {
  const lines = [];
  const n = Math.floor(span / step);
  for (let k = -n; k <= n; k++) {
    const line = mainTotal + k * step;
    if (line < 0) continue; // no such thing as a negative points total
    const overP = pmfSum(pmf, Math.ceil(line), Q1_TOTAL_MAX);
    lines.push({ line: +line.toFixed(1), overOdds: probToOdds(overP), underOdds: probToOdds(1 - overP) });
  }
  return lines;
}

// Same 50/50 search as findFiftyFiftyLine, but against a discrete PMF
// (Q1's margin/total use the texture-corrected discrete distribution, not
// a continuous CDF) — sums the PMF's tail instead of evaluating a CDF.
function findFiftyFiftyPmf(pmf, guess, radius, maxBound) {
  const center = Math.round(guess);
  let best = center + 0.5, bestDiff = Infinity;
  for (let k = -radius; k <= radius; k++) {
    const line = center + k + 0.5;
    const homeP = pmfSum(pmf, Math.ceil(line), maxBound);
    const d = Math.abs(homeP - 0.5);
    if (d < bestDiff) { bestDiff = d; best = line; }
  }
  return best;
}

// calibratedMargin: optional — Q1's own margin propagated from Full Game's
// calibration via their real, measured correlation (RHO_Q1_FULL=0.613,
// same regression-propagation approach as H1's RHO_H1_FULL — see the
// comment where H1 is built in the main loop below). Backtested the same
// way: raw Q1 margin fails a PIT calibration check in the second half of
// 243 real matches (chi2=18.66 vs a 16.9 threshold) while the propagated
// version passes consistently in both halves (12.64/11.44).
function buildQ1Markets(predHome, predAway, calibratedMargin) {
  const predMargin = predHome - predAway;
  const predTotal = predHome + predAway;
  const sd = SD.q1;
  const effectiveMargin = calibratedMargin != null ? calibratedMargin : predMargin;

  // Effective per-team scores that reproduce (effectiveMargin, predTotal)
  // exactly — same split used to validate this against real Q1 goals/
  // behinds counts (see q1MarginPMFFromScore above).
  const effHome = (predTotal + effectiveMargin) / 2, effAway = (predTotal - effectiveMargin) / 2;
  const marginPmf = q1MarginPMFFromScore(effHome, effAway);
  const totalPmf = buildDiscretePMF(predTotal, sd.total, Q1_TOTAL_TEXTURE, 0, Q1_TOTAL_MAX, true);

  const pHome = pmfSum(marginPmf, 1, Q1_MARGIN_MAX);
  const pAway = pmfSum(marginPmf, -Q1_MARGIN_MAX, -1);
  const pDraw = marginPmf[0] || 0;

  const lineVal = findFiftyFiftyPmf(marginPmf, effectiveMargin, 20, Q1_MARGIN_MAX);
  const totalLineVal = Math.max(0.5, findFiftyFiftyPmf(totalPmf, predTotal, 15, Q1_TOTAL_MAX));
  const lineHomeP = pmfSum(marginPmf, Math.ceil(lineVal), Q1_MARGIN_MAX);
  const totalOverP = pmfSum(totalPmf, Math.ceil(totalLineVal), Q1_TOTAL_MAX);

  function bandProbsPmf(bands) {
    return bands.map(([lo, hi]) => {
      const hiK = hi === Infinity ? Q1_MARGIN_MAX : hi;
      const homeP = pmfSum(marginPmf, lo, hiK);
      const awayP = pmfSum(marginPmf, -hiK, -lo);
      return { range: hi === Infinity ? `${lo}+` : `${lo}-${hi}`, homeOdds: probToOdds(homeP), awayOdds: probToOdds(awayP) };
    });
  }

  return {
    label: '1st Quarter',
    predHome: +predHome.toFixed(1), predAway: +predAway.toFixed(1),
    predMargin: +predMargin.toFixed(1), predTotal: +predTotal.toFixed(1),
    h2hIsCalibrated: calibratedMargin != null,
    h2h: { homeOdds: probToOdds(pHome), awayOdds: probToOdds(pAway), drawOdds: pDraw > 0.003 ? probToOdds(pDraw) : null },
    line: { value: lineVal, homeOdds: probToOdds(lineHomeP), awayOdds: probToOdds(1 - lineHomeP) },
    total: { value: totalLineVal, overOdds: probToOdds(totalOverP), underOdds: probToOdds(1 - totalOverP) },
    // Full Game's 24.5/39.5 thresholds (mirroring Sportsbet's real markets)
    // are meaningless at quarter scale — a 25+ point Q1 margin is a near-
    // impossible blowout, so those bands were paying ~1000/1000 dummy odds.
    // Q1 gets its own, actually-contested thresholds instead: 6.5 (roughly
    // "more than a goal") and 11.5 (roughly "more than two goals").
    marginBands6: bandProbsPmf([[1, 6], [7, Infinity]]),
    marginBands11: bandProbsPmf([[1, 11], [12, Infinity]]),
    altLines: q1AltLines(lineVal, marginPmf, 1, 15),
    altTotals: q1AltTotals(totalLineVal, totalPmf, 1, 14),
    // Full margin distribution (every value with non-negligible probability)
    // for the expandable "every margin" table in the app — the enumeration
    // model produces real per-point shape (peaks at clean goal multiples,
    // troughs at awkward ones) that the summary markets above don't show.
    marginPmf: Object.entries(marginPmf)
      .map(([k, p]) => [+k, +p.toFixed(4)])
      .filter(([, p]) => p >= 0.0003)
      .sort((a, b) => a[0] - b[0]),
    _effectiveMargin: +effectiveMargin.toFixed(1),
  };
}

function blendShare(scorer, concedeAgainst) {
  const p1 = profiles[scorer], p2 = profiles[concedeAgainst];
  if (!p1 || !p2) return [0.25, 0.25, 0.25, 0.25];
  const blend = p1.forShare.map((v, i) => (v + p2.againstShare[i]) / 2);
  const sum = blend.reduce((a, b) => a + b, 0);
  return blend.map(v => v / sum);
}

function levelMarkets(label, predHome, predAway, sd, calibratedHomeProb) {
  const predMargin = predHome - predAway;
  const predTotal = predHome + predAway;

  // Full-game H2H uses the project's actual calibrated Elo win probability
  // (validated separately — see calibration-report.js), not one re-derived
  // from the margin-normal approximation, which disagrees with it at the
  // tails (GIANTS v Power: margin-normal model alone implied GIANTS ~7%
  // vs Elo's calibrated 28% — Elo is the one with an actual calibration
  // check behind it). Rather than let H2H and the margin-derived markets
  // (line/bands/alt lines) silently contradict each other, solve for the
  // EFFECTIVE margin-distribution mean that reproduces the calibrated win
  // probability exactly (same spread, shifted centre), and use that
  // effective mean for every margin-based market at this level, INCLUDING
  // the draw price — pHome/pAway/pDraw all come from one marginProbs() call
  // at this one mean, so they always sum to exactly 1. (Previously pDraw was
  // computed separately from the raw, pre-calibration margin — for a match
  // where the raw score-model margin implied a blowout but Elo's calibrated
  // probability said it was closer, that left the draw priced far too long.)
  // Q1/H1 have no independently-calibrated win model, so they keep the raw
  // score-model margin — a rougher estimate, noted via h2hIsCalibrated.
  let effectiveMargin = predMargin;
  if (calibratedHomeProb != null) {
    // solves P(margin > 0) = calibratedHomeProb. The win chance is an EXPECTED
    // SCORE (draw = half a win: what Elo predicts and the backtests grade), so
    // it is matched to P(margin > 0) = P(win) + P(draw)/2. Before 2026-10-17
    // this solved P(margin > 0.5), which put every margin 0.5 pts toward home.
    effectiveMargin = sd.margin * invNormalCDF(calibratedHomeProb);
  }
  const { pHome, pAway, pDraw } = marginProbs(effectiveMargin, sd.margin); // outright win / draw / loss
  // Head to head the way Australian bookmakers settle AFL: two outcomes, a
  // draw paying half (dead heat). Fair = 1 / (P(win) + P(draw)/2).
  const pHomeDH = 1 - normalCDF(0, effectiveMargin, sd.margin);
  const twoWay = label === 'Full Game';

  // Main line is the genuine 50/50 point (see findFiftyFiftyLine) — margin
  // is symmetric here so this lands on the same half-point the old
  // round-to-nearest logic gave; it's really the total below where this
  // matters, since a skewed distribution's mean isn't its median.
  const lineVal = findFiftyFiftyLine((line) => normalCDF(line, effectiveMargin, sd.margin), effectiveMargin, 20);

  // Match total: skew-corrected at Full Game (measured directly on match-
  // total residuals — see MATCH_TOTAL_SD/SKEW above), plain normal at 1st
  // Half (not independently validated at that level).
  let totalLineVal, totalOverP, altTotalsOut;
  if (label === 'Full Game') {
    const mt = fitSkewNormal(predTotal, MATCH_TOTAL_SD, MATCH_TOTAL_SKEW);
    const cdfAt = (line) => skewNormalCDF(line, mt.xi, mt.omega, mt.alpha);
    totalLineVal = Math.max(0.5, findFiftyFiftyLine(cdfAt, predTotal, 20));
    totalOverP = 1 - cdfAt(totalLineVal);
    altTotalsOut = skewAltTotals(totalLineVal, mt.xi, mt.omega, mt.alpha, 1, 30);
  } else {
    const cdfAt = (line) => normalCDF(line, predTotal, sd.total);
    totalLineVal = Math.max(0.5, findFiftyFiftyLine(cdfAt, predTotal, 20));
    totalOverP = 1 - cdfAt(totalLineVal);
    altTotalsOut = altTotals(totalLineVal, predTotal, sd.total, 1, 20);
  }

  return {
    label,
    predHome: +predHome.toFixed(1), predAway: +predAway.toFixed(1),
    predMargin: +predMargin.toFixed(1), predTotal: +predTotal.toFixed(1),
    h2hIsCalibrated: calibratedHomeProb != null,
    // Full Game: two-way, dead-heat rules (what every bookmaker offers for AFL);
    // the three-way result (with the draw as its own outcome) is in result3.
    // 1st Half keeps the three-way price.
    h2h: twoWay
      ? { homeOdds: probToOdds(pHomeDH), awayOdds: probToOdds(1 - pHomeDH), deadHeat: true }
      : { homeOdds: probToOdds(pHome), awayOdds: probToOdds(pAway), drawOdds: pDraw > 0.003 ? probToOdds(pDraw) : null },
    result3: { homeOdds: probToOdds(pHome), drawOdds: probToOdds(pDraw), awayOdds: probToOdds(pAway), pDraw: +pDraw.toFixed(4) },
    line: { value: lineVal, homeOdds: probToOdds(1 - normalCDF(lineVal, effectiveMargin, sd.margin)), awayOdds: probToOdds(normalCDF(lineVal, effectiveMargin, sd.margin)) },
    total: { value: totalLineVal, overOdds: probToOdds(totalOverP), underOdds: probToOdds(1 - totalOverP) },
    marginBands24: bandProbs(effectiveMargin, sd.margin, [[1,24],[25,Infinity]]).map(b => ({ range: b.range, homeOdds: probToOdds(b.homeP), awayOdds: probToOdds(b.awayP) })),
    marginBands39: bandProbs(effectiveMargin, sd.margin, [[1,39],[40,Infinity]]).map(b => ({ range: b.range, homeOdds: probToOdds(b.homeP), awayOdds: probToOdds(b.awayP) })),
    altLines: altLines(lineVal, effectiveMargin, sd.margin, 1, label === 'Full Game' ? 36 : 24),
    altTotals: altTotalsOut,
    _effectiveMargin: +effectiveMargin.toFixed(1),
    _pHome: pHomeDH, // expected score (draw = half) = the model's win chance at Full Game
  };
}

const output = [];
// Club names for the notes the board shows (the model keys teams by nickname).
const CLUB = { Kangaroos: 'North Melbourne', Bulldogs: 'Western Bulldogs', Crows: 'Adelaide', Eagles: 'West Coast', Swans: 'Sydney', GIANTS: 'GWS', Power: 'Port Adelaide', Demons: 'Melbourne', Lions: 'Brisbane', Magpies: 'Collingwood', Hawks: 'Hawthorn', SUNS: 'Gold Coast', Cats: 'Geelong', Dockers: 'Fremantle', Blues: 'Carlton', Bombers: 'Essendon' };
function readable(t) {
  if (!t) return null;
  let s = String(t).replace(/->/g, '→').replace(/ -- /g, ' — ');
  for (const [k, v] of Object.entries(CLUB)) s = s.replace(new RegExp('\\b' + k + '\\b', 'g'), v);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Every level shows predicted scores that reproduce ITS OWN margin and total
// (the ones its line/H2H/total markets are priced from) -- previously the
// shown scores were the raw scoring-model split and could flatly contradict
// the line (R7 2026: "Demons 32.9 - 52.2 Kangaroos" beside Kangaroos -1.5).
function makeCoherent(level) {
  const m = level._effectiveMargin, t = level.predTotal;
  level.predHome = +Math.max(0, (t + m) / 2).toFixed(1);
  level.predAway = +Math.max(0, (t - m) / 2).toFixed(1);
  level.predMargin = m;
  return level;
}

for (const p of snapshot.predictions) {
  // Raw scoring-model split: what the H1/Q1 machinery was validated on,
  // scaled (since 2026-10-02) so it adds up to the full-game total -- the
  // averaged total predicts H1 and Q1 totals better than the scoring model's
  // own (total-candidates.js: H1 MAE 10.71 vs 10.87, Q1 7.57 vs 7.65).
  // Older snapshots (before components existed) only have predHome/Away.
  const scale = p.components && p.components.totalScale ? p.components.totalScale : 1;
  const rawHome = (p.components ? p.components.scoreModelHome : p.predHomeScore) * scale;
  const rawAway = (p.components ? p.components.scoreModelAway : p.predAwayScore) * scale;
  const homeShare = blendShare(p.homeTeam, p.awayTeam);
  const awayShare = blendShare(p.awayTeam, p.homeTeam);
  const homeQ = homeShare.map(s => s * rawHome);
  const awayQ = awayShare.map(s => s * rawAway);

  // Full game: the coherent prediction (predicted score already agrees with
  // the win probability -- see predict-round.js).
  const full = levelMarkets('Full Game', p.predHomeScore, p.predAwayScore, SD.full, p.modelHomeProb);

  // H1 gets its own calibration too, propagated from Full Game's — H1's
  // raw margin (from blendShare) has no independent calibration of its
  // own, but it's derived from the same underlying prediction Full Game's
  // Elo calibration corrects, and H1/Full margins are correlated
  // (RHO_H1_FULL=0.856, fit from history, already used for the HT/FT
  // grid). Apply the standard regression-coefficient propagation for a
  // correlated variable (rho * sd_h1/sd_full) to carry Full Game's
  // calibration shift over to H1's own predicted margin. Backtested
  // against 243 real matches via the same PIT calibration check used
  // throughout this file: raw H1 margin fails it in the second half of
  // the data (chi2=20.6 vs a 16.9 threshold — passes in the first half,
  // so an in-sample-only check would've missed this) while the propagated
  // version passes cleanly in both halves (11.8/11.8). Costs a little raw
  // point-accuracy (MAE 12.65->13.26) for a genuinely better-calibrated
  // probability shape — the same trade-off Full Game's own calibration
  // already makes.
  // deltaFull is measured against the RAW scoring-model margin, exactly as
  // when H1/Q1 were validated (full.predMargin is the coherent one now).
  const deltaFull = full._effectiveMargin - (rawHome - rawAway);
  const h1RawMargin = (homeQ[0] + homeQ[1]) - (awayQ[0] + awayQ[1]);
  const deltaH1 = RHO_H1_FULL * (SD.h1.margin / SD_FULL_AT_H1Q1_VALIDATION) * deltaFull;
  const h1CalibratedMargin = h1RawMargin + deltaH1;
  const h1CalibratedHomeProb = 1 - normalCDF(0, h1CalibratedMargin, SD.h1.margin); // P(margin > 0): levelMarkets inverts it back to h1CalibratedMargin

  const h1 = levelMarkets('1st Half', homeQ[0] + homeQ[1], awayQ[0] + awayQ[1], SD.h1, h1CalibratedHomeProb);

  // Same propagation for Q1, using the real, separately-measured Q1-Full
  // correlation (RHO_Q1_FULL=0.613 — stable at 0.617/0.608 across both
  // halves of the data, not just assumed from H1's). Backtested the same
  // way: raw Q1 margin fails calibration in the second half (chi2=18.66 vs
  // 16.9) while the propagated version passes both halves (12.64/11.44).
  const q1RawMargin = homeQ[0] - awayQ[0];
  const deltaQ1 = RHO_Q1_FULL * (SD.q1.margin / SD_FULL_AT_H1Q1_VALIDATION) * deltaFull;
  const q1CalibratedMargin = q1RawMargin + deltaQ1;

  const q1 = buildQ1Markets(homeQ[0], awayQ[0], q1CalibratedMargin);
  // Team totals centred on the coherent scores, so "Kangaroos over 50.5"
  // can't quietly imply a different winner than the line does.
  full.homeTeamTotal = buildTeamTotalMarket(p.predHomeScore);
  full.awayTeamTotal = buildTeamTotalMarket(p.predAwayScore);
  makeCoherent(full); makeCoherent(h1); makeCoherent(q1);
  Object.assign(full, buildFirstScoreMarkets(full._pHome));

  // Double Half/Full result (HT/FT), 9-way grid, using bivariate normal
  // between H1 margin and Full margin (rho fit from history). Uses each
  // side's own CALIBRATED margin (_effectiveMargin), not the raw one —
  // SD.h1.margin is now the residual spread around H1's calibrated margin
  // specifically (see above), so pairing it with the raw margin here would
  // silently mismatch the two and undo that fit.
  const h1Margin = h1._effectiveMargin, fullMargin = full._effectiveMargin;
  const h1SD = SD.h1.margin, fullSD = SD.full.margin;
  // P(H1 margin <= a, Full margin <= b) via bivariate normal CDF in
  // standardized space (rho fit from history); inclusion-exclusion over
  // the three bands (away / draw / home, split at +-1 for the draw band)
  // gives each of the 9 HT/FT cells.
  const z1 = (x) => (x - h1Margin) / h1SD;
  const z2 = (x) => (x - fullMargin) / fullSD;
  const P = (a, b) => bivariateNormalCDF(z1(a), z2(b), RHO_H1_FULL);
  const NEG = -1e6, POS = 1e6;
  const grid = {};
  const cuts = [NEG, -0.5, 0.5, POS]; // draw band matches marginProbs()'s continuity correction
  const labels = ['Away', 'Draw', 'Home'];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const a0 = cuts[i], a1 = cuts[i+1], b0 = cuts[j], b1 = cuts[j+1];
      const val = P(a1,b1) - P(a0,b1) - P(a1,b0) + P(a0,b0);
      grid[`${labels[i]}/${labels[j]}`] = Math.max(val, 0);
    }
  }
  const htft = Object.entries(grid).map(([key, prob]) => ({ key, prob, odds: probToOdds(prob) }));

  output.push({
    homeTeam: p.homeTeam, awayTeam: p.awayTeam, venue: p.venue, date: p.date,
    marketHomeOdds: p.marketHomeOdds, marketAwayOdds: p.marketAwayOdds,
    levels: { full, h1, q1 },
    htft,
    // why the prediction is what it is, for Fairline's match page (2026-10-17)
    notes: {
      lineups: readable(p.lineupNote && !/not named yet/.test(p.lineupNote) ? p.lineupNote : 'Final teams not named yet, so no lineup adjustment. Re-priced once they are.'),
      teamNews: readable(p.rosterNote), conditions: readable(p.weatherNote), travel: readable(p.travelNote),
    },
  });
}

fs.writeFileSync('data/betting_odds_model.json', JSON.stringify(output, null, 1));
console.log(`Wrote data/betting_odds_model.json (${output.length} matches)`);
// ── Consistency gate ─────────────────────────────────────────────────────
// Every market for a match must tell the same story. If any check fails the
// run exits non-zero, so run-round.js stops before touching Fairline.
const problems = [];
console.log('\nmatch'.padEnd(26) + 'prediction'.padEnd(34) + 'H2H'.padEnd(15) + 'line'.padEnd(16) + 'total');
for (const m of output) {
  const f = m.levels.full;
  const snap = snapshot.predictions.find(p => p.homeTeam === m.homeTeam && p.awayTeam === m.awayTeam);
  const fav = f._effectiveMargin >= 0 ? m.homeTeam : m.awayTeam;
  const hcap = -f.line.value; // board/bookie convention: home handicap
  console.log(`${m.homeTeam} v ${m.awayTeam}`.padEnd(25) +
    `${f.predHome}-${f.predAway} (${fav} by ${Math.abs(f._effectiveMargin).toFixed(1)})`.padEnd(34) +
    `$${f.h2h.homeOdds}/$${f.h2h.awayOdds}`.padEnd(15) +
    `${m.homeTeam} ${hcap > 0 ? '+' : ''}${hcap}`.padEnd(16) + f.total.value);
  const tag = `${m.homeTeam} v ${m.awayTeam}`;
  for (const [key, lv] of Object.entries(m.levels)) {
    if (Math.abs((lv.predHome - lv.predAway) - lv._effectiveMargin) > 0.15) problems.push(`${tag} ${key}: predicted score ${lv.predHome}-${lv.predAway} doesn't match its margin ${lv._effectiveMargin}`);
    // Q1's line is the 50/50 point of a lumpy goals-and-behinds distribution,
    // which for a lopsided quarter can sit just over a point from the mean
    // (Richmond v Cats R8: mean -9.6, 50/50 line -8.5 at $2.06/$1.94), so it
    // gets a wider tolerance; every level's line must also actually be ~50/50.
    const tol = key === 'q1' ? 1.6 : 1.01;
    if (Math.abs(lv.line.value - lv._effectiveMargin) > tol) problems.push(`${tag} ${key}: line ${lv.line.value} is more than ${tol} points from the margin ${lv._effectiveMargin}`);
    const lineP = (1 / lv.line.homeOdds) / (1 / lv.line.homeOdds + 1 / lv.line.awayOdds);
    if (Math.abs(lineP - 0.5) > 0.06) problems.push(`${tag} ${key}: line ${lv.line.value} isn't a 50/50 line ($${lv.line.homeOdds}/$${lv.line.awayOdds})`);
  }
  const pH = (1 / f.h2h.homeOdds) / (1 / f.h2h.homeOdds + 1 / f.h2h.awayOdds + (f.h2h.drawOdds ? 1 / f.h2h.drawOdds : 0));
  if (snap && Math.abs(pH - snap.modelHomeProb) > 0.012) problems.push(`${tag}: H2H implies ${(pH * 100).toFixed(1)}% but the model says ${(snap.modelHomeProb * 100).toFixed(1)}%`);
  const ttGap = f.homeTeamTotal.predScore - f.awayTeamTotal.predScore;
  if (Math.abs(ttGap - f._effectiveMargin) > 0.15) problems.push(`${tag}: team totals imply a ${ttGap.toFixed(1)} margin vs ${f._effectiveMargin}`);
  if (Math.abs(f.homeTeamTotal.predScore + f.awayTeamTotal.predScore - f.predTotal) > 0.25) problems.push(`${tag}: team totals don't add up to the match total`);
}
if (problems.length) {
  console.log('\nCONSISTENCY CHECK FAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nConsistency check passed: scores, H2H, line, total and team totals agree for every match.');
