// Pulls the `weather` field from AFL.com.au's matchRoster/full endpoint
// (same backend as fetch-rosters.js) for every match — weatherType enum
// (SUNNY, MOSTLY_SUNNY, RAIN, ...), a free-text description (sometimes
// calls out wind separately, e.g. "Possible shower Windy"), and
// tempInCelsius. Available back to 2017.
//
// Resumable: writes data/weather.json after every match, skips matchIds
// already recorded on re-run.

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'data', 'weather.json');

async function getToken() {
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' },
  });
  const { token } = await res.json();
  return token;
}

function loadOut() {
  if (fs.existsSync(OUT_PATH)) return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  return {};
}

async function main() {
  let token = await getToken();
  console.log('got token');

  const matches = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'matches.json'), 'utf8'));
  const out = loadOut();

  let done = 0, withData = 0, failed = 0;
  for (const m of matches) {
    if (out[m.matchId]) { done++; continue; }
    let weather;
    try {
      const res = await fetch(`https://api.afl.com.au/cfs/afl/matchRoster/full/${m.matchId}`, {
        headers: { 'x-media-mis-token': token },
      });
      if (res.status === 401) {
        token = await getToken();
        const res2 = await fetch(`https://api.afl.com.au/cfs/afl/matchRoster/full/${m.matchId}`, {
          headers: { 'x-media-mis-token': token },
        });
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        const d2 = await res2.json();
        weather = d2.matchRoster ? d2.matchRoster.weather : null;
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        const d = await res.json();
        weather = d.matchRoster ? d.matchRoster.weather : null;
      }
    } catch (e) {
      failed++;
      console.log(`  ${m.matchId} (${m.season} ${m.round}): FAILED (${e.message})`);
      continue;
    }
    out[m.matchId] = weather || null;
    if (weather) withData++;
    done++;
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
    if (done % 50 === 0) console.log(`${done}/${matches.length} (${withData} with weather data, ${failed} failed)`);
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`\nDone: ${done}/${matches.length} processed, ${withData} with weather data, ${failed} failed`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
