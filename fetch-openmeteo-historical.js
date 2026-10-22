// Hourly historical weather (Open-Meteo archive API — free, no key,
// explicitly built for reuse) to break BOM's daily rain/wind totals down
// by time of day, so "rain during the match" can be distinguished from
// "rain hours before/after" (which the match itself never experienced).
//
// Open-Meteo's archive is a reanalysis/model product, not a station
// observation — cross-checked against BOM's real station total for a known
// storm match and it under-estimated the daily total (28mm modelled vs
// 53.4mm observed for GIANTS v SUNS, 2020-02-08). So: keep BOM's daily
// total as the authoritative rainfall AMOUNT (data/bom_weather.json), and
// use Open-Meteo's hourly SHAPE — rescaled so the day sums to BOM's real
// total — to decide WHEN within the day it fell. Wind doesn't have the
// same BOM-vs-model gap (BOM's daily figure is an average anyway), so
// Open-Meteo's hourly wind is used directly, unscaled.
//
// Match window: kickoff to kickoff+2h (AFLW games run under 2h including
// breaks); pre-match window: kickoff-2h to kickoff (ground conditions/
// warm-up). Post-match isn't computed — per the brief, rain after the
// final siren doesn't affect anything that already happened.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const COORDS = require('./venue-coords');

const OUT_PATH = path.join(__dirname, 'data', 'openmeteo_historical.json');

function httpGetJson(url) {
  const text = execFileSync('curl', ['-s', '--max-time', '20', url], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(text);
}

function loadOut() {
  if (fs.existsSync(OUT_PATH)) return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  return {};
}

// cache by "lat,lon,date" since a couple of matches can share a venue+day
const dayCache = new Map();
function getDayHourly(lat, lon, dateStr, timezone) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${dateStr}`;
  if (dayCache.has(key)) return dayCache.get(key);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateStr}&end_date=${dateStr}&hourly=precipitation,wind_speed_10m&timezone=${encodeURIComponent(timezone)}`;
  let data;
  try {
    data = httpGetJson(url);
  } catch (e) {
    dayCache.set(key, null);
    return null;
  }
  dayCache.set(key, data.hourly || null);
  return data.hourly || null;
}

// AEST/AEDT etc. — Open-Meteo wants an IANA zone; matches.json's venueState
// tells us which, close enough for match-day weather purposes
const STATE_TZ = {
  VIC: 'Australia/Melbourne', NSW: 'Australia/Sydney', QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide', WA: 'Australia/Perth', TAS: 'Australia/Hobart',
  NT: 'Australia/Darwin', ACT: 'Australia/Sydney',
};

function windowSums(hourly, kickoffLocal) {
  // hourly.time entries are local ISO strings (no offset) since we passed
  // a timezone param; kickoffLocal is a Date constructed the same way.
  const times = hourly.time.map(t => new Date(t + ':00'));
  let preRain = 0, duringRain = 0, duringWindSum = 0, duringWindN = 0;
  const preStart = new Date(kickoffLocal.getTime() - 2 * 3600 * 1000);
  const duringEnd = new Date(kickoffLocal.getTime() + 2 * 3600 * 1000);
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t >= preStart && t < kickoffLocal) preRain += hourly.precipitation[i] || 0;
    if (t >= kickoffLocal && t < duringEnd) {
      duringRain += hourly.precipitation[i] || 0;
      duringWindSum += hourly.wind_speed_10m[i] || 0;
      duringWindN++;
    }
  }
  return {
    preMatchRainMm: preRain,
    duringMatchRainMm: duringRain,
    duringMatchWindKmh: duringWindN ? duringWindSum / duringWindN : null,
    dayTotalRainMm: hourly.precipitation.reduce((a, b) => a + (b || 0), 0),
  };
}

async function main() {
  const matches = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'matches.json'), 'utf8'));
  const bom = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'bom_weather.json'), 'utf8'));
  const out = loadOut();

  const todo = matches.filter(m => out[m.matchId] === undefined && m.venueLocation && COORDS[m.venueLocation] && m.venueState);
  console.log(`${todo.length} matches to resolve`);

  let done = 0, matched = 0;
  for (const m of todo) {
    const [lat, lon] = COORDS[m.venueLocation];
    const tz = STATE_TZ[m.venueState] || 'Australia/Sydney';
    // date string for the archive call: use the LOCAL calendar date at the
    // venue, derived by asking Open-Meteo's own timezone-aware response —
    // simplest robust way is to try the UTC date and, since AFLW kicks off
    // local afternoon/evening, that's correct for all our timezones (never
    // crosses local midnight relative to UTC date for these longitudes).
    const utcDate = new Date(m.date);
    const dateStr = utcDate.toISOString().slice(0, 10);
    const hourly = getDayHourly(lat, lon, dateStr, tz);
    if (!hourly) { out[m.matchId] = null; done++; continue; }

    // kickoff in LOCAL time: Open-Meteo returned local-time hourly buckets
    // for this timezone; reconstruct local kickoff by formatting m.date in
    // that timezone.
    const kickoffLocalStr = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(utcDate).replace(' ', 'T');
    const kickoffLocal = new Date(kickoffLocalStr + ':00');

    const w = windowSums(hourly, kickoffLocal);
    const bomDay = bom[m.matchId];
    const scale = (bomDay && bomDay.rainMm != null && w.dayTotalRainMm > 0.1) ? (bomDay.rainMm / w.dayTotalRainMm) : 1;

    out[m.matchId] = {
      preMatchRainMm: +(w.preMatchRainMm * scale).toFixed(2),
      duringMatchRainMm: +(w.duringMatchRainMm * scale).toFixed(2),
      duringMatchWindKmh: w.duringMatchWindKmh,
      rescaleFactor: +scale.toFixed(3),
      bomDayTotalMm: bomDay ? bomDay.rainMm : null,
      modelDayTotalMm: +w.dayTotalRainMm.toFixed(2),
    };
    matched++;
    done++;
    if (done % 40 === 0) {
      fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
      console.log(`${done}/${todo.length} (${matched} matched)`);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
  console.log(`\nDone: ${done}/${todo.length}, ${matched} matched`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
