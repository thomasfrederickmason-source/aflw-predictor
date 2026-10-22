// Travel/home-ground adjustment, validated in travel-signal-check.js
// against 726 matches: continuous travel-distance-in-km didn't hold up as
// a predictive signal (weak, non-monotonic correlations, r~0.01-0.04) —
// Australia's geography means most AFLW away trips are already "large"
// interstate distances, so km doesn't discriminate well.
//
// What DID hold up, after controlling for team strength (comparing to
// Elo's own win-prob expectation, which already bakes in the flat
// HGA=15 the model applies to every "home" fixture): home advantage
// looks like it's ~entirely an away-team-travel effect, not a home-crowd
// effect. Split by whether each side is playing near their own derived
// home city:
//   - true home game (home local, away travelled): n=439, actual beats
//     Elo's expectation by +3.1pp win-prob on average — the model may be
//     slightly UNDER-crediting these.
//   - "local derby" (both teams local to the venue, e.g. two Melbourne
//     teams at a Melbourne ground): n=219, actual UNDERSHOOTS Elo's
//     expectation by -5.1pp — the model is over-crediting a home-ground
//     boost that isn't really there when the away team hasn't had to
//     travel either.
//
// Conservative adjustment implemented here: zero out the home-ground-
// advantage term for "local derby" fixtures only (well-supported by the
// data); leave true-home and neutral-venue games at the model's existing
// flat HGA (smaller sample, less confident adjusting those further).

const NEAR_HOME_KM = 100; // within this = "playing at home", matches travel-signal-check.js
// Read from what elo-model.js actually fitted (it used to be a copy that
// "must match" by hand).
let HGA = 15;
try { HGA = JSON.parse(require('fs').readFileSync('data/elo_params.json', 'utf8')).hga; } catch (e) { /* run elo-model.js first */ }

// shared with fetch-openmeteo-historical.js / fetch-openmeteo-forecast.js
const COORDS = require('./venue-coords');

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Derives each team's home city from historical matches.json the same way
// travel-signal-check.js does: mode of venueLocation among their home games.
function buildTeamHomeCities(matches) {
  const counts = new Map();
  for (const m of matches) {
    if (!m.venueLocation) continue;
    if (!counts.has(m.homeTeam)) counts.set(m.homeTeam, new Map());
    const c = counts.get(m.homeTeam);
    c.set(m.venueLocation, (c.get(m.venueLocation) || 0) + 1);
  }
  const teamHomeCity = new Map();
  for (const [team, c] of counts) {
    let best = null, bestN = 0;
    for (const [loc, n] of c) if (n > bestN) { best = loc; bestN = n; }
    teamHomeCity.set(team, best);
  }
  return teamHomeCity;
}

// Returns { eloDiffAdjustment, isLocalDerby, homeTravelKm, awayTravelKm } or
// null if venue/team-city data is missing.
function getTravelAdjustment(homeTeam, awayTeam, venueLocation, teamHomeCity) {
  const homeCity = teamHomeCity.get(homeTeam);
  const awayCity = teamHomeCity.get(awayTeam);
  const venueCoord = COORDS[venueLocation];
  if (!homeCity || !awayCity || !venueCoord || !COORDS[homeCity] || !COORDS[awayCity]) return null;

  const homeTravelKm = haversineKm(COORDS[homeCity], venueCoord);
  const awayTravelKm = haversineKm(COORDS[awayCity], venueCoord);
  const isLocalDerby = homeTravelKm < NEAR_HOME_KM && awayTravelKm < NEAR_HOME_KM;

  return {
    // negative shift removes the modelled HGA=15 benefit entirely for a
    // local-derby fixture (see validation note above)
    eloDiffAdjustment: isLocalDerby ? -HGA : 0,
    isLocalDerby, homeTravelKm, awayTravelKm,
  };
}

module.exports = { buildTeamHomeCities, getTravelAdjustment };
