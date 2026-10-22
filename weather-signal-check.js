// Checks whether rain/wind/heavy weather at a match actually moves total
// scoring — plausible on football priors (wet ball = harder to mark/kick
// cleanly, more turnovers, lower-scoring), same validate-before-building
// approach as the roster and travel features.
//
// Weather data (data/weather.json, fetch-weather.js) is a pre-match
// forecast description from AFL.com.au's matchRoster endpoint, not a
// live in-game observation — treat findings as "conditions forecast for
// matchday", not confirmed conditions during play. Categorised from the
// free-text `description` field, which is more granular than the coarse
// `weatherType` enum (e.g. "Windy" and "storm/heavy" show up in
// descriptions under multiple different weatherTypes).

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const weather = JSON.parse(fs.readFileSync('data/weather.json', 'utf8'));

function classify(w) {
  if (!w) return { hasData: false };
  const d = (w.description || '').toLowerCase();
  const isWindy = /wind/.test(d);
  const isStorm = /storm/.test(d);
  const isHeavyRain = /heavy/.test(d) || isStorm; // treat storm mentions as the "heavy" end of rain
  const isAnyRain = w.weatherType === 'RAIN' || w.weatherType === 'THUNDERSTORMS' || /shower|rain|drizzle/.test(d);
  return { hasData: true, isWindy, isHeavyRain, isStorm, isAnyRain, weatherType: w.weatherType, description: w.description, temp: w.tempInCelsius };
}

const rows = [];
for (const m of matches) {
  if (m.totalScore == null) continue;
  const w = weather[m.matchId];
  const c = classify(w);
  if (!c.hasData) continue;
  rows.push({ matchId: m.matchId, season: m.season, date: m.date, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    totalScore: m.totalScore, margin: Math.abs(m.margin), ...c });
}
console.log(`Matches with weather + score data: ${rows.length} of ${matches.length}\n`);

function stats(bucket) {
  const n = bucket.length;
  if (!n) return null;
  const avgTotal = bucket.reduce((s,r)=>s+r.totalScore,0)/n;
  const avgAbsMargin = bucket.reduce((s,r)=>s+r.margin,0)/n;
  return { n, avgTotal, avgAbsMargin };
}
function printBucket(label, bucket) {
  const s = stats(bucket);
  if (!s) { console.log(label.padEnd(30), 'n=0'); return; }
  console.log(label.padEnd(30), `n=${s.n.toString().padStart(4)}  avgTotalScore=${s.avgTotal.toFixed(1).padStart(6)}  avgAbsMargin=${s.avgAbsMargin.toFixed(1).padStart(6)}`);
}

console.log('=== Overall baseline ===');
printBucket('all matches', rows);

console.log('\n=== By rain severity ===');
printBucket('clear/no rain mentioned', rows.filter(r => !r.isAnyRain));
printBucket('any rain (light-moderate)', rows.filter(r => r.isAnyRain && !r.isHeavyRain));
printBucket('heavy rain / storm', rows.filter(r => r.isHeavyRain));

console.log('\n=== By wind ===');
printBucket('no wind mentioned', rows.filter(r => !r.isWindy));
printBucket('windy', rows.filter(r => r.isWindy));

console.log('\n=== Combined: heavy rain AND windy vs clear ===');
printBucket('clear, no wind, no rain', rows.filter(r => !r.isAnyRain && !r.isWindy));
printBucket('heavy rain + windy', rows.filter(r => r.isHeavyRain && r.isWindy));

console.log('\n=== By weatherType enum (coarser) ===');
for (const t of ['SUNNY','MOSTLY_SUNNY','OVERCAST','RAIN','THUNDERSTORMS','WINDY','CLEAR_NIGHT']) {
  printBucket(t, rows.filter(r => r.weatherType === t));
}

console.log('\n=== By era (weather effects may have shifted with game style — see README era notes) ===');
printBucket('2024+ , clear', rows.filter(r => (r.season.includes('2024')||r.season.includes('2025')||r.season.includes('2026')) && !r.isAnyRain));
printBucket('2024+ , heavy rain/storm', rows.filter(r => (r.season.includes('2024')||r.season.includes('2025')||r.season.includes('2026')) && r.isHeavyRain));

// Simple correlation between temperature and scoring, out of curiosity —
// AFLW is often played in hot early-season conditions (Jan/Feb historically)
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
  return num/Math.sqrt(dx2*dy2);
}
const withTemp = rows.filter(r => r.temp != null);
console.log(`\n=== Temperature (n=${withTemp.length}) ===`);
console.log('correlation temp vs totalScore:', pearson(withTemp.map(r=>r.temp), withTemp.map(r=>r.totalScore)).toFixed(4));

// List the specific heavy-rain/storm matches with their descriptions and
// actual totals, as requested — a concrete look, not just averages
console.log('\n=== Individual heavy-rain/storm matches (description, temp, total score, |margin|) ===');
const heavy = rows.filter(r => r.isHeavyRain).sort((a,b) => new Date(a.date) - new Date(b.date));
for (const r of heavy) {
  console.log(`  ${r.date.slice(0,10)}  ${r.homeTeam} v ${r.awayTeam}  "${r.description}" ${r.temp}°C  total=${r.totalScore}  |margin|=${r.margin}`);
}

fs.writeFileSync('data/weather_signal.json', JSON.stringify(rows, null, 1));
console.log('\nWrote data/weather_signal.json');
