// Hourly weather FORECAST (Open-Meteo forecast API — free, no key) for
// upcoming fixtures in data/upcoming_round_odds.json, broken into the same
// pre-match (kickoff-2h to kickoff) / during-match (kickoff to kickoff+2h)
// windows as fetch-openmeteo-historical.js, so live predictions can use
// "will it be raining/windy during this specific match" rather than a
// whole-day forecast.
//
// Venue coordinates come from venue-coords.js, keyed by AFL.com.au's
// venueLocation strings; upcoming_round_odds.json's venue town names
// (oddsportal's naming) are matched to those via a small local alias map
// where they differ.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const COORDS = require('./venue-coords');

const TOWN_ALIAS = {
  // oddsportal venueTown -> venue-coords.js key, where they don't match
  // directly (either identical strings work as-is, or need mapping)
};

function httpGetJson(url) {
  const text = execFileSync('curl', ['-s', '--max-time', '20', url], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(text);
}

// Open-Meteo now and then answers with an error body ({"error":true,"reason":...},
// e.g. a rate limit or a brief outage) instead of a forecast. That used to
// crash the whole reprice (run #120, 2026-11-13). Try a few times, and only
// accept an answer that really carries the hourly figures.
async function fetchForecast(url) {
  let lastErr = 'no answer';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = httpGetJson(url);
      const h = data && data.hourly;
      if (h && Array.isArray(h.time) && Array.isArray(h.precipitation) && Array.isArray(h.wind_speed_10m)) return data;
      lastErr = (data && data.reason) || 'answer had no hourly forecast';
    } catch (e) {
      lastErr = e.message;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
  }
  throw new Error(lastErr);
}

const STATE_TZ_BY_COORD_HINT = 'Australia/Sydney'; // fallback only

// crude state guess from known venue towns already in venue-coords.js —
// good enough since Open-Meteo just needs *a* valid Australian IANA zone
// for the given lat/long to bucket hours sensibly; using the nearest
// major-city zone is fine (all of mainland Australia's zones differ only
// by whole hours / are the same for our coastal city set).
const TOWN_TZ = {
  'Launceston': 'Australia/Hobart', 'Unley': 'Australia/Adelaide',
  'Coffs Harbour': 'Australia/Sydney', 'Canberra': 'Australia/Sydney',
  'Cranbourne East': 'Australia/Melbourne', 'Melbourne': 'Australia/Melbourne',
  'Gold Coast': 'Australia/Brisbane', 'Perth': 'Australia/Perth',
  'Darwin': 'Australia/Darwin',
};

function windowSums(hourly, kickoffLocal) {
  const times = hourly.time.map(t => new Date(t + ':00'));
  let preRain = 0, duringRain = 0, duringWindSum = 0, duringWindN = 0, duringProbMax = 0;
  const preStart = new Date(kickoffLocal.getTime() - 2 * 3600 * 1000);
  const duringEnd = new Date(kickoffLocal.getTime() + 2 * 3600 * 1000);
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t >= preStart && t < kickoffLocal) preRain += hourly.precipitation[i] || 0;
    if (t >= kickoffLocal && t < duringEnd) {
      duringRain += hourly.precipitation[i] || 0;
      duringWindSum += hourly.wind_speed_10m[i] || 0;
      duringWindN++;
      duringProbMax = Math.max(duringProbMax, hourly.precipitation_probability ? (hourly.precipitation_probability[i] || 0) : 0);
    }
  }
  return {
    preMatchRainMm: +preRain.toFixed(2),
    duringMatchRainMm: +duringRain.toFixed(2),
    duringMatchWindKmh: duringWindN ? +(duringWindSum / duringWindN).toFixed(1) : null,
    duringMatchMaxRainProbPct: duringProbMax,
  };
}

async function main() {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'upcoming_round_odds.json'), 'utf8'));
  const out = [];
  const outFile = path.join(__dirname, 'data', 'openmeteo_forecast.json');
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* first run */ }
  if (!Array.isArray(previous)) previous = [];

  for (const f of fixtures) {
    const venueKey = TOWN_ALIAS[f.venueTown] || f.venueTown;
    const coord = COORDS[venueKey];
    if (!coord) { console.log(`No coords for venueTown "${f.venueTown}" (${f.homeTeam} v ${f.awayTeam}) — skipping`); continue; }
    const [lat, lon] = coord;
    const tz = TOWN_TZ[venueKey] || STATE_TZ_BY_COORD_HINT;

    const utcDate = new Date(f.date * 1000);
    const daysOut = Math.ceil((utcDate - new Date()) / (24 * 3600 * 1000));
    if (daysOut > 15) { console.log(`${f.homeTeam} v ${f.awayTeam}: ${daysOut} days out — beyond forecast range, skipping`); continue; }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation,wind_speed_10m,precipitation_probability&timezone=${encodeURIComponent(tz)}&forecast_days=16`;
    const kickoffLocalStr = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(utcDate).replace(' ', 'T');
    const kickoffLocal = new Date(kickoffLocalStr + ':00');

    let data;
    try {
      data = await fetchForecast(url);
    } catch (e) {
      // keep the last forecast we had for this same game rather than pricing it with no weather
      const prev = previous.find(p => p.homeTeam === f.homeTeam && p.awayTeam === f.awayTeam && p.kickoffLocal === kickoffLocalStr);
      if (prev) { out.push(prev); console.log(`FAILED forecast fetch for ${venueKey}: ${e.message} — keeping the previous forecast for ${f.homeTeam} v ${f.awayTeam}`); }
      else console.log(`FAILED forecast fetch for ${venueKey}: ${e.message} — no forecast for ${f.homeTeam} v ${f.awayTeam}`);
      continue;
    }

    const w = windowSums(data.hourly, kickoffLocal);
    out.push({
      homeTeam: f.homeTeam, awayTeam: f.awayTeam, venue: f.venue, venueTown: f.venueTown,
      kickoffLocal: kickoffLocalStr, ...w,
    });
    console.log(`${f.homeTeam} v ${f.awayTeam} (${f.venue}, ${venueKey}) — kickoff ${kickoffLocalStr} local`);
    console.log(`  pre-match rain: ${w.preMatchRainMm}mm | during-match rain: ${w.duringMatchRainMm}mm (max hourly prob ${w.duringMatchMaxRainProbPct}%) | during-match wind: ${w.duringMatchWindKmh}km/h`);
    await new Promise(r => setTimeout(r, 200));
  }

  fs.writeFileSync(path.join(__dirname, 'data', 'openmeteo_forecast.json'), JSON.stringify(out, null, 1));
  console.log(`\nWrote data/openmeteo_forecast.json (${out.length} fixtures)`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
