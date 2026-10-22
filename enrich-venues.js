// Adds venue name/location/state to data/matches.json (venue was previously
// just a provider code like "CD_V81").
const fs = require('fs');

const venuesRaw = JSON.parse(fs.readFileSync('data/venues_raw.json', 'utf8'));
const venueMap = new Map(venuesRaw.venues.map(v => [v.providerId, v]));

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
let matched = 0, missing = new Set();
const enriched = matches.map(m => {
  const v = venueMap.get(m.venue);
  if (v) matched++; else if (m.venue) missing.add(m.venue);
  return {
    ...m,
    venueName: v ? v.name : null,
    venueLocation: v ? v.location : null,
    venueState: v ? v.state : null,
  };
});

fs.writeFileSync('data/matches.json', JSON.stringify(enriched, null, 2));
console.log(`Matched ${matched}/${matches.length} matches to a venue name.`);
if (missing.size) console.log('Unmatched venue codes:', [...missing].join(', '));
