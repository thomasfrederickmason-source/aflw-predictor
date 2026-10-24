// The LIVE rain term, fitted on what was FORECAST, not on the rain that fell
// (added 2026-10-25).
//
// conditions-model.js fits rain on the archived (actual) amount. That's the
// right number for "how much does real rain cost", but the board never knows
// the real amount -- it prices from Open-Meteo's forecast, and the forecast
// amount is a noisy guess: across 320 matches 2024-26 the archived log(1+mm)
// rises only 0.28-0.44 per unit of forecast log(1+mm) (corr 0.51-0.65). The
// 2026-10-24 change plugged the forecast amount straight into the archive
// slope (-20.7 per log(1+mm)), so a 4.3mm forecast took 32 pts off a total,
// and the board swung 10-15 pts between hourly runs as the forecast moved.
// Scored on archived forecasts, that term was WORSE than no rain term at all
// (MAE 17.62 vs 17.39; wet-forecast games 19.72 vs 19.05, overshooting by
// +4.7). Grouped by forecast amount, games forecast wet finished ~7-8 under
// the model whether the forecast said 0.5mm or 4mm+.
//
// So live rain is: coef x (chance of rain x log(1 + forecast mm clamped to
// [minMm, maxMm]) - mean). The cap at 1mm is what the forecasts support; the
// coefficient is fitted here on two lead times pooled, because the board is
// priced all week and reprices to kickoff:
//   day0 = historical-forecast API (the latest run before each hour)
//   day1 = previous-runs API, the forecast issued ~24h earlier
// Wind and kickoff time stay as conditions-model.js fits them; this only
// replaces the rain term. Stored in data/model_params.json
// conditions.forecastRain, which conditions-model.js --write carries over.
//
// Archived forecast windows are cached per match in
// data/openmeteo_forecast_archive.json, so a refit only fetches new games.
// Usage: node forecast-rain-fit.js [--write]

const fs = require('fs');
const { execFileSync } = require('child_process');
const COORDS = require('./venue-coords');
const { localHour } = require('./weather-adjustment');

const FROM = 2024;           // previous-runs archive starts in 2024
const MIN_MM = 0.5, MAX_MM = 1;
const CACHE = 'data/openmeteo_forecast_archive.json';

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const score = new Map(JSON.parse(fs.readFileSync('data/score_history.json', 'utf8')).map(s => [s.matchId, s]));
const ridgeTot = new Map(JSON.parse(fs.readFileSync('data/ridge_total_history.json', 'utf8')).map(s => [s.matchId, s.predTotal]));
const om = JSON.parse(fs.readFileSync('data/openmeteo_historical.json', 'utf8'));
const venues = (v => (Array.isArray(v) ? v : v.venues))(JSON.parse(fs.readFileSync('data/venues_raw.json', 'utf8')));
const tzByVenue = Object.fromEntries(venues.map(v => [v.providerId, v.timezone]));
const STATE_TZ = { VIC: 'Australia/Melbourne', NSW: 'Australia/Sydney', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', WA: 'Australia/Perth', TAS: 'Australia/Hobart', NT: 'Australia/Darwin', ACT: 'Australia/Sydney' };
const params = JSON.parse(fs.readFileSync('data/model_params.json', 'utf8'));
const C = params.conditions;
const year = m => Number((m.season.match(/\d{4}/) || [0])[0]);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

function httpGetJson(url) {
  const j = JSON.parse(execFileSync('curl', ['-s', '--max-time', '60', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  if (j.error) throw new Error(j.reason);
  return j;
}

// ── archived forecasts for the match window (kickoff to kickoff+2h, UTC hours) ──
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const played = matches.filter(m => year(m) >= FROM && COORDS[m.venueLocation] && score.get(m.matchId) && ridgeTot.get(m.matchId) != null);
const groups = {};
for (const m of played.filter(m => !cache[m.matchId])) { const k = `${m.venueLocation}|${year(m)}`; (groups[k] = groups[k] || []).push(m); }
let fetched = 0;
for (const [k, list] of Object.entries(groups)) {
  const [lat, lon] = COORDS[k.split('|')[0]];
  const days = list.map(m => m.date.slice(0, 10)).sort();
  const end = new Date(new Date(days[days.length - 1]).getTime() + 86400000).toISOString().slice(0, 10);
  let h0, h1;
  try {
    h0 = httpGetJson(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation,precipitation_probability&start_date=${days[0]}&end_date=${end}&timezone=GMT`).hourly;
    h1 = httpGetJson(`https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_previous_day1,precipitation_probability_previous_day1&start_date=${days[0]}&end_date=${end}&timezone=GMT`).hourly;
  } catch (e) { console.log(`  ${k}: forecast archive fetch failed (${e.message}), skipped`); continue; }
  for (const m of list) {
    const ko = new Date(m.date).getTime();
    const win = (h, key, agg) => {
      let v = null;
      for (let i = 0; i < h.time.length; i++) {
        const t = new Date(h.time[i] + ':00Z').getTime();
        if (t < ko || t >= ko + 2 * 3600e3) continue;
        if (h[key][i] == null) return null;
        v = agg(v == null ? 0 : v, h[key][i]);
      }
      return v;
    };
    const sum = (a, b) => a + b;
    cache[m.matchId] = {
      d0: win(h0, 'precipitation', sum), p0: win(h0, 'precipitation_probability', Math.max),
      d1: win(h1, 'precipitation_previous_day1', sum), p1: win(h1, 'precipitation_probability_previous_day1', Math.max),
    };
    fetched++;
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}
console.log(`Archived forecasts: ${fetched} new match windows fetched, ${Object.keys(cache).length} cached`);

// ── rows: model total error after the live wind + kickoff terms, with each lead's forecast rain ──
const x = (p, mm) => (p / 100) * Math.log1p(Math.min(Math.max(mm, MIN_MM), MAX_MM));
const rows = [];
for (const m of played) {
  const f = cache[m.matchId], w = om[m.matchId], s = score.get(m.matchId);
  if (!f || !w || w.duringMatchWindKmh == null) continue;
  const tz = tzByVenue[m.venue] || STATE_TZ[m.venueState] || 'Australia/Melbourne';
  const wind = C.windPerKmh * C.forecastWindShrink * (w.duringMatchWindKmh - C.windMean);
  const hour = C.perHour * (localHour(new Date(m.date).getTime(), tz) - C.hourMean);
  const res = m.homeScore + m.awayScore - (s.predHomeScore + s.predAwayScore + ridgeTot.get(m.matchId)) / 2 - wind - hour;
  // the previous-runs archive keeps no day-old chance of rain, so day-old rows use the same-day chance
  for (const [mm, p, lead] of [[f.d0, f.p0, 0], [f.d1, f.p1 != null ? f.p1 : f.p0, 1]]) {
    if (mm == null || p == null) continue;
    rows.push({ y: year(m), lead, res, p, mm, x: x(p, mm), live: C.rainLog * (p / 100 * Math.log1p(Math.max(mm, C.rainMinMm)) - C.rainLogMean) });
  }
}
function fit(R) {
  const mx = mean(R.map(r => r.x)), my = mean(R.map(r => r.res));
  let n = 0, d = 0; for (const r of R) { n += (r.x - mx) * (r.res - my); d += (r.x - mx) ** 2; }
  return { coef: n / d, mean: mx };
}
const F = fit(rows);
// leave-one-season-out, so the comparison isn't graded on its own fit
const loso = rows.map(r => { const G = fit(rows.filter(q => q.y !== r.y)); return G.coef * (r.x - G.mean); });
const stat = (adj, lead) => {
  const R = rows.map((r, i) => [r, r.res - adj(r, i)]).filter(([r]) => r.lead === lead), W = R.filter(([r]) => r.p >= 50);
  return `MAE ${mean(R.map(([, e]) => Math.abs(e))).toFixed(2)}, wet forecasts (n=${W.length}) MAE ${mean(W.map(([, e]) => Math.abs(e))).toFixed(2)} bias ${mean(W.map(([, e]) => e)) >= 0 ? '+' : ''}${mean(W.map(([, e]) => e)).toFixed(1)}`;
};
for (const lead of [0, 1]) {
  console.log(`\n${lead ? 'Day-old' : 'Same-day'} forecasts, ${rows.filter(r => r.lead === lead).length} matches ${FROM}+:`);
  console.log(`  no rain term                    ${stat(() => 0, lead)}`);
  if (C.rainLog != null) console.log(`  archive slope on forecast mm    ${stat(r => r.live, lead)}`);
  console.log(`  forecast-fitted, capped ${MAX_MM}mm    ${stat((r, i) => loso[i], lead)}  (leave-one-season-out)`);
}
const at = (p, mm) => F.coef * (x(p, mm) - F.mean);
console.log(`\nLive rain term: ${F.coef.toFixed(2)} x (chance x log(1 + mm, ${MIN_MM}-${MAX_MM}mm) - ${F.mean.toFixed(4)}) on ${rows.length} forecast rows`);
console.log(`  100% chance, 1mm+ ${at(100, 1).toFixed(1)} | 100%, light ${at(100, 0).toFixed(1)} | 50%, light ${at(50, 0).toFixed(1)} | 10% ${at(10, 0).toFixed(1)}`);

if (process.argv.includes('--write')) {
  params.conditions.forecastRain = {
    coef: +F.coef.toFixed(3), mean: +F.mean.toFixed(4), minMm: MIN_MM, maxMm: MAX_MM,
    fittedOn: rows.length, fromSeason: FROM, fittedAt: new Date().toISOString(),
  };
  fs.writeFileSync('data/model_params.json', JSON.stringify(params, null, 1));
  console.log('\nWritten: conditions.forecastRain to data/model_params.json');
}
