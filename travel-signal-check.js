// Builds a travel-distance feature from venue location data (matches.json's
// venueName/venueLocation/venueState, now 100% resolved — see README) and
// validates it against Elo history before it goes near the model, same
// approach as roster-signal-check.js.
//
// Team "home city" is derived data-driven (the most common venueLocation
// among each team's home matches), not hardcoded — handles quirks like a
// team's fixture load being split across cities without guessing.

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const eloHistory = JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8'));

// lat/long for every venueLocation string appearing in matches.json —
// shared with travel-adjustment.js / fetch-openmeteo-*.js
const COORDS = require('./venue-coords');

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// derive each team's home city: mode of venueLocation among their home matches
const homeLocationCounts = new Map(); // team -> Map<location, count>
for (const m of matches) {
  if (!m.venueLocation) continue;
  if (!homeLocationCounts.has(m.homeTeam)) homeLocationCounts.set(m.homeTeam, new Map());
  const counts = homeLocationCounts.get(m.homeTeam);
  counts.set(m.venueLocation, (counts.get(m.venueLocation) || 0) + 1);
}
const teamHomeCity = new Map();
for (const [team, counts] of homeLocationCounts) {
  let best = null, bestN = 0;
  for (const [loc, n] of counts) if (n > bestN) { best = loc; bestN = n; }
  teamHomeCity.set(team, best);
}
console.log('=== Derived team home cities ===');
for (const [team, city] of [...teamHomeCity].sort()) console.log(`  ${team.padEnd(20)} ${city}`);

// chronological, matching elo-model.js's ordering
const sorted = [...matches].sort((a, b) => new Date(a.date) - new Date(b.date));
const eloByMatchId = new Map(eloHistory.map(h => [h.matchId, h]));

const rows = [];
for (const m of sorted) {
  if (!m.venueLocation) continue;
  const elo = eloByMatchId.get(m.matchId);
  if (!elo) continue;
  const homeCity = teamHomeCity.get(m.homeTeam);
  const awayCity = teamHomeCity.get(m.awayTeam);
  if (!homeCity || !awayCity) continue;
  const venueCoord = COORDS[m.venueLocation];
  if (!venueCoord) { console.log(`  no coords for venueLocation "${m.venueLocation}"`); continue; }

  const homeTravelKm = haversineKm(COORDS[homeCity], venueCoord);
  const awayTravelKm = haversineKm(COORDS[awayCity], venueCoord);

  rows.push({
    matchId: m.matchId, date: m.date, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    venueLocation: m.venueLocation, homeCity, awayCity,
    homeTravelKm, awayTravelKm,
    netTravelDisadvantage: awayTravelKm - homeTravelKm, // positive = away travelled further (home advantaged)
    eloHomeWinProb: elo.homeWinProbModel, homeWin: elo.homeWin, margin: elo.margin,
  });
}

console.log(`\nMatches with travel data: ${rows.length} of ${matches.length}`);

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
  return num/Math.sqrt(dx2*dy2);
}

const netTravel = rows.map(r => r.netTravelDisadvantage);
const surprise = rows.map(r => (r.homeWin?1:0) - r.eloHomeWinProb);
const marginArr = rows.map(r => r.margin);

console.log(`\nCorrelation (net travel disadvantage, home perspective) vs (win-prob surprise): ${pearson(netTravel, surprise).toFixed(4)}`);
console.log(`Correlation (net travel disadvantage, home perspective) vs (actual margin): ${pearson(netTravel, marginArr).toFixed(4)}`);

// also check ABSOLUTE home travel alone (does the home team travelling at
// all — not just relative to the away team — hurt, e.g. a "home" game
// interstate isn't really a home-ground advantage)
const homeTravelArr = rows.map(r => r.homeTravelKm);
console.log(`Correlation (home team's own travel distance) vs (win-prob surprise): ${pearson(homeTravelArr, surprise).toFixed(4)}`);

console.log('\n=== Bucketed by net travel disadvantage (home perspective, km) ===');
const buckets = [[-Infinity, -1000], [-1000, -200], [-200, 200], [200, 1000], [1000, Infinity]];
for (const [lo, hi] of buckets) {
  const bucket = rows.filter(r => r.netTravelDisadvantage > lo && r.netTravelDisadvantage <= hi);
  if (!bucket.length) continue;
  const avgSurprise = bucket.reduce((s,r)=>s+((r.homeWin?1:0)-r.eloHomeWinProb),0)/bucket.length;
  const avgMargin = bucket.reduce((s,r)=>s+r.margin,0)/bucket.length;
  console.log(`  (${lo}, ${hi}]  n=${bucket.length.toString().padStart(4)}  avg win-prob surprise=${avgSurprise>=0?'+':''}${avgSurprise.toFixed(3)}  avg margin=${avgMargin>=0?'+':''}${avgMargin.toFixed(1)}`);
}
const overallAvgMargin = marginArr.reduce((a,b)=>a+b,0)/marginArr.length;
console.log(`\n(baseline avg margin across all ${rows.length} matches: ${overallAvgMargin.toFixed(1)})`);

// how often is there ANY meaningful travel at all (both teams "at home"
// most weeks, so this may simply not fire often)
const meaningfulTravel = rows.filter(r => Math.abs(r.netTravelDisadvantage) > 200);
console.log(`\nMatches with a >200km net travel difference: ${meaningfulTravel.length} of ${rows.length} (${(100*meaningfulTravel.length/rows.length).toFixed(1)}%)`);

fs.writeFileSync('data/travel_signal.json', JSON.stringify(rows, null, 1));
console.log('\nWrote data/travel_signal.json');
