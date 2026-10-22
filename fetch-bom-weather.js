// Pulls REAL observed daily weather (not forecast) from the Bureau of
// Meteorology's anonymous FTP service for the nearest station to each
// match venue — daily rainfall (mm, 9am-9am) and average 10m wind speed
// (m/s), per data/matches.json's venueLocation.
//
// BOM's website explicitly blocks scraping ("you should stop") and points
// to two authorised alternatives: anonymous FTP (free) or a paid
// Registered User service. This uses the anonymous FTP
// (ftp://ftp.bom.gov.au/anon/gen/clim_data/IDCKWCDEA0/tables/), subject to
// the Bureau's standard copyright terms (bom.gov.au/other/copyright.shtml)
// — personal research use, not redistribution.
//
// One monthly CSV per station covers many matches at once (multiple AFLW
// games at the same venue in the same month), so this fetches far fewer
// files than one-per-match. Resumable: writes data/bom_weather.json after
// each station+month, skips ones already recorded.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_PATH = path.join(__dirname, 'data', 'bom_weather.json');

// venueLocation (matches.json) -> { state, station } (BOM FTP folder name),
// optionally a `fallback` list of {state,station} to try (in order) for
// months the primary station doesn't have — stations get decommissioned/
// replaced mid-history (e.g. Adelaide (Kent Town) stopped reporting in
// 2020, replaced by Adelaide Airport; old Frankston station stopped in
// 2018, replaced by Frankston (Ballam Park) from 2020, leaving an
// Aug2018-Jun2020 gap covered here by nearby Melbourne).
const STATION_MAP = {
  'Melbourne': { state: 'vic', station: 'melbourne_(olympic_park)' },
  'Sandringham': { state: 'vic', station: 'melbourne_(olympic_park)' },
  'Box Hill': { state: 'vic', station: 'melbourne_(olympic_park)' },
  'Werribee': { state: 'vic', station: 'melbourne_(olympic_park)' },
  'Swan St': { state: 'vic', station: 'melbourne_(olympic_park)' },
  'Perth': { state: 'wa', station: 'perth_metro' },
  'Mandurah': { state: 'wa', station: 'mandurah' },
  'Adelaide': { state: 'sa', station: 'adelaide_airport' },
  'Unley': { state: 'sa', station: 'adelaide_airport' },
  'Glenelg': { state: 'sa', station: 'adelaide_airport' },
  'Noarlunga Downs': { state: 'sa', station: 'noarlunga' },
  'Sydney': { state: 'nsw', station: 'sydney_airport_amo' },
  'Geelong': { state: 'vic', station: 'breakwater_(geelong_racecourse)' },
  'Gold Coast': { state: 'qld', station: 'gold_coast_seaway' },
  'Ipswich': { state: 'qld', station: 'amberley_amo' },
  'Frankston': { state: 'vic', station: 'frankston_(ballam_park)', fallback: [{ state: 'vic', station: 'frankston' }, { state: 'vic', station: 'melbourne_(olympic_park)' }] },
  'Cranbourne East': { state: 'vic', station: 'frankston_(ballam_park)', fallback: [{ state: 'vic', station: 'frankston' }, { state: 'vic', station: 'melbourne_(olympic_park)' }] },
  'Canberra': { state: 'nsw', station: 'canberra_airport' },
  'Hobart': { state: 'tas', station: 'hobart_(ellerslie_road)' },
  'Launceston': { state: 'tas', station: 'launceston_(ti_tree_bend)' },
  'Stafford': { state: 'qld', station: 'brisbane_aero' },
  'Brendale': { state: 'qld', station: 'brisbane_aero' },
  'Burpengary': { state: 'qld', station: 'brisbane_aero' },
  'Mackay': { state: 'qld', station: 'mackay_aero' },
  'Ballarat': { state: 'vic', station: 'ballarat_aerodrome' },
  'Darwin': { state: 'nt', station: 'darwin_airport' },
  'Brisbane': { state: 'qld', station: 'brisbane_aero' },
  'Cairns': { state: 'qld', station: 'cairns_aero' },
  'Queensland': { state: 'qld', station: 'brisbane_aero' }, // generic fallback in source data
  'Coffs Harbour': { state: 'nsw', station: 'coffs_harbour_airport' },
  'Warrnambool': { state: 'vic', station: 'warrnambool_airport_ndb' },
  'Maroochydore': { state: 'qld', station: 'sunshine_coast_airport' },
  'Morwell': { state: 'vic', station: 'morwell_(latrobe_valley_airport)' },
  'Alice Springs': { state: 'nt', station: 'alice_springs_airport' },
  'Mildura': { state: 'vic', station: 'mildura_airport' },
  'Bendigo': { state: 'vic', station: 'bendigo_airport' },
  'Wagga Wagga': { state: 'nsw', station: 'wagga_wagga_amo' },
  'Moe': { state: 'vic', station: 'morwell_(latrobe_valley_airport)' },
};

function ftpFetch(url) {
  // curl handles ftp:// natively; matches the exploration already done.
  return execFileSync('curl', ['-s', '--max-time', '20', url], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function parseMonthCsv(text) {
  // Header rows vary in exact wording/column count year to year (BOM has
  // reformatted this product over a 10+ year span) — parse by locating the
  // data rows via the "STATION NAME,DD/MM/YYYY,..." pattern instead of
  // assuming a fixed header, and take Rain (col 4) / Wind Speed (2nd-last
  // numeric column) by position relative to the header row actually found.
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex(l => l.startsWith('Station Name,Date,'));
  if (headerIdx === -1) return [];
  // the variable-name row is the one ABOVE the "Station Name,Date,..."
  // (time-period) row — e.g. ",,Transpiration,Rain,Evaporation,...,10m Wind,Solar"
  const nameRow = (lines[headerIdx - 1] || '').split(',').map(h => h.trim());
  const rainCol = nameRow.findIndex(h => h === 'Rain');
  const windCol = nameRow.findIndex(h => h.includes('Wind'));
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) { // +2 skips the units row
    const cols = lines[i].split(',');
    if (cols.length < 3) continue;
    const dateStr = cols[1]; // DD/MM/YYYY
    const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) continue;
    const [, dd, mm, yyyy] = m;
    const rain = rainCol >= 0 ? parseFloat(cols[rainCol]) : null;
    const wind = windCol >= 0 ? parseFloat(cols[windCol]) : null;
    rows.push({ date: `${yyyy}-${mm}-${dd}`, rainMm: isNaN(rain) ? null : rain, windMs: isNaN(wind) ? null : wind });
  }
  return rows;
}

function loadOut() {
  if (fs.existsSync(OUT_PATH)) return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  return {};
}

function dateKeyOf(m) {
  const d = new Date(m.date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function yyyymmOf(m) {
  const d = new Date(m.date);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Fetches one station-month CSV and returns a Map<dateKey, row>, or null on
// a genuine fetch failure (caller should NOT cache a negative result then,
// so it retries next run rather than permanently giving up).
const monthCache = new Map(); // "state/station/yyyymm" -> Map<dateKey,row> | null
function getStationMonth(state, station, yyyymm) {
  const cacheKey = `${state}/${station}/${yyyymm}`;
  if (monthCache.has(cacheKey)) return monthCache.get(cacheKey);
  const url = `ftp://ftp.bom.gov.au/anon/gen/clim_data/IDCKWCDEA0/tables/${state}/${station}/${station}-${yyyymm}.csv`;
  let text;
  try {
    text = ftpFetch(url);
  } catch (e) {
    monthCache.set(cacheKey, undefined); // undefined = genuine fetch error, don't cache to disk as a miss
    return undefined;
  }
  const rows = parseMonthCsv(text);
  const byDate = new Map(rows.map(r => [r.date, r]));
  monthCache.set(cacheKey, byDate);
  return byDate;
}

async function main() {
  const matches = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'matches.json'), 'utf8'));
  const out = loadOut(); // matchId -> { rainMm, windMs, station } | null

  const todo = matches.filter(m => out[m.matchId] === undefined && m.venueLocation && STATION_MAP[m.venueLocation]);
  const unmapped = new Set(matches.filter(m => m.venueLocation && !STATION_MAP[m.venueLocation]).map(m => m.venueLocation));
  if (unmapped.size) console.log('Unmapped venueLocations (skipped):', [...unmapped].join(', '));
  console.log(`${todo.length} matches to resolve`);

  let matched = 0, done = 0;
  for (const m of todo) {
    const st = STATION_MAP[m.venueLocation];
    const candidates = [st, ...(st.fallback || [])];
    const dk = dateKeyOf(m), ym = yyyymmOf(m);
    let resolved = null, anyFetchOk = false;
    for (const c of candidates) {
      const byDate = getStationMonth(c.state, c.station, ym);
      if (byDate === undefined) continue; // fetch failed, try next candidate
      anyFetchOk = true;
      const row = byDate.get(dk);
      if (row) { resolved = { rainMm: row.rainMm, windMs: row.windMs, station: `${c.state}/${c.station}` }; break; }
    }
    if (resolved) { out[m.matchId] = resolved; matched++; }
    else if (anyFetchOk) { out[m.matchId] = null; } // fetched fine, date genuinely not in any candidate's data
    // else: leave unresolved (undefined) so a re-run retries the fetch
    done++;
    if (done % 40 === 0) {
      fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
      console.log(`${done}/${todo.length} (${matched} matched)`);
      await new Promise(r => setTimeout(r, 150)); // polite pacing, not per-request since months are cached
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));

  console.log(`\nDone: ${done}/${todo.length} processed, ${matched} matched to a BOM observation`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
