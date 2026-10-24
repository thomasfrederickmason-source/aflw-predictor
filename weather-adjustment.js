// Match-window weather adjustment to predicted TOTAL score (not margin/win
// probability — no home/away directional effect was found; rain and wind
// suppress both teams roughly evenly). Validated in openmeteo-signal-check.js
// against 477 matches with a reliable Open-Meteo-vs-BOM rescale (see
// fetch-openmeteo-historical.js for what "reliable" means here) — isolating
// the match window (kickoff to kickoff+2h) sharpened the correlation to
// roughly double the daily-total version (r~0.15-0.18 vs r~0.07-0.08).
//
// Deliberately NOT a continuous per-mm rain slope: a first attempt at a
// multivariate linear fit gave -10.4 points per mm of rain, which is only
// sane within the observed range — during-match rain in this dataset maxes
// out at 2.85mm (rain heavy enough to still be falling in a specific 2h
// window and also match BOM's real daily total is rare), so a linear
// per-mm slope extrapolated to a "moderate" 5mm+ match would predict an
// absurd near-zero score. The data only supports a threshold effect:
//   - no measurable rain during the match (n=444): score resid +0.8
//   - any rain during the match, >0.1mm (n=33): score resid -9.5
// So rain is modelled as a fixed step, not scaled by how much rain.
//
// Wind DOES have a stable, well-populated range (1.4-42 km/h, n=477) and a
// close-to-linear relationship, so it's applied as a continuous slope
// centred on the dataset's own mean wind (15.7 km/h) — i.e. zero
// adjustment at a typical match's wind level, moving away from there in
// either direction, rather than extrapolating from a wind=0 intercept
// that's rarely observed.

const RAIN_STEP_POINTS = -9.5; // total-score points, split between both teams
const RAIN_THRESHOLD_MM = 0.1;
const WIND_SLOPE_PER_KMH = -0.517; // total-score points per km/h away from baseline
const WIND_BASELINE_KMH = 15.73; // mean during-match wind in the validation set

// Kickoff hour (with minutes as a fraction) at the venue, e.g. 19.25 = 7:15pm.
function localHour(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ms));
  const h = Number(parts.find(p => p.type === 'hour').value) % 24, m = Number(parts.find(p => p.type === 'minute').value);
  return h + m / 60;
}

// LIVE adjustment since 2026-10-17 (conditions-model.js): wind, chance of rain
// and kickoff time, with coefficients fitted on the model's own total error and
// stored in data/model_params.json (.conditions). Every term is centred on its
// training mean, so it moves a total only away from typical conditions.
//   windKmh   forecast mean wind during the match (null = unknown -> no wind term)
//   rainProb  forecast chance of rain during the match, 0-1 (null = unknown)
//   rainMm    forecast mm of rain in the match window (scales the rain term; null = 0)
//   kickoffMs, timeZone  the bounce, for the kickoff-time term
// Returns { totalScoreAdjustment, note, parts }.
let CONDITIONS = null;
try { CONDITIONS = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data/model_params.json'), 'utf8')).conditions || null; } catch (e) { /* run conditions-model.js --write */ }
function getConditionsAdjustment({ windKmh = null, rainProb = null, rainMm = null, kickoffMs = null, timeZone = 'Australia/Melbourne' } = {}) {
  const C = CONDITIONS;
  if (!C) { const old = getWeatherAdjustment(rainProb != null && rainProb >= 0.5 ? 1 : 0, windKmh); return { ...old, parts: [] }; }
  const parts = [];
  let adj = 0;
  if (windKmh != null) {
    const eff = C.windMean + C.forecastWindShrink * (windKmh - C.windMean); // forecast wind regresses toward the archive mean
    const a = C.windPerKmh * (eff - C.windMean);
    adj += a; parts.push({ k: 'wind', pts: a, text: `wind ${Math.round(windKmh)}km/h` });
  }
  if (rainProb != null && C.forecastRain) {
    // fitted on archived FORECASTS (forecast-rain-fit.js): the forecast amount only counts up to maxMm,
    // because heavier forecasts didn't score any lower (the archive slope below over-cut wet forecasts)
    const R = C.forecastRain;
    const mm = Math.min(Math.max(rainMm || 0, R.minMm), R.maxMm);
    const a = R.coef * (rainProb * Math.log1p(mm) - R.mean);
    adj += a; parts.push({ k: 'rain', pts: a, text: `${Math.round(rainProb * 100)}% chance of rain, ${(+(rainMm || 0).toFixed(1))}mm forecast` });
  } else if (rainProb != null && C.rainLog != null) {
    // expected log(1 + mm): chance of rain x how heavy, at least a typical wet game's amount
    const mm = Math.max(rainMm || 0, C.rainMinMm);
    const a = C.rainLog * (rainProb * Math.log1p(mm) - C.rainLogMean);
    adj += a; parts.push({ k: 'rain', pts: a, text: `${Math.round(rainProb * 100)}% chance of rain, ${(+mm.toFixed(1))}mm` });
  } else if (rainProb != null) {
    const a = C.rain * (rainProb - C.rainShare);
    adj += a; parts.push({ k: 'rain', pts: a, text: `${Math.round(rainProb * 100)}% chance of rain` });
  }
  if (kickoffMs != null) {
    const hr = localHour(kickoffMs, timeZone);
    const a = C.perHour * (hr - C.hourMean);
    const hh = Math.floor(hr), mm = Math.round((hr - hh) * 60);
    adj += a; parts.push({ k: 'time', pts: a, text: `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}${hh >= 12 ? 'pm' : 'am'} local kickoff` });
  }
  const shown = parts.filter(p => Math.abs(p.pts) >= 0.5);
  return { totalScoreAdjustment: adj, parts, note: shown.length ? shown.map(p => `${p.text} ${p.pts >= 0 ? '+' : ''}${p.pts.toFixed(1)}`).join('; ') : null };
}

// LEGACY (fixed constants, replaced 2026-10-17; kept for the old signal-check
// scripts). Returns { totalScoreAdjustment, note } — totalScoreAdjustment in points,
// to be split evenly between predicted home/away scores by the caller.
function getWeatherAdjustment(duringMatchRainMm, duringMatchWindKmh) {
  let adj = 0;
  const parts = [];
  if (duringMatchRainMm != null && duringMatchRainMm > RAIN_THRESHOLD_MM) {
    adj += RAIN_STEP_POINTS;
    parts.push(`rain during match (${duringMatchRainMm.toFixed(1)}mm forecast): ${RAIN_STEP_POINTS} pts`);
  }
  if (duringMatchWindKmh != null) {
    const windAdj = WIND_SLOPE_PER_KMH * (duringMatchWindKmh - WIND_BASELINE_KMH);
    adj += windAdj;
    if (Math.abs(windAdj) >= 0.5) parts.push(`wind ${duringMatchWindKmh.toFixed(0)}km/h vs ${WIND_BASELINE_KMH.toFixed(0)}km/h baseline: ${windAdj >= 0 ? '+' : ''}${windAdj.toFixed(1)} pts`);
  }
  return { totalScoreAdjustment: adj, note: parts.length ? parts.join('; ') : null };
}

module.exports = { getWeatherAdjustment, getConditionsAdjustment, localHour };
