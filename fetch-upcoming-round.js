// Builds data/upcoming_round_odds.json (the fixture list predict-round.js
// iterates over) for a given round, straight from AFL.com.au's own backend
// instead of oddsportal.
//
// Why not oddsportal: that landing-page scrape was always the fragile part of
// the pipeline (undocumented `initialOddsMap` keyed by event hash, placeholder
// resultIds pre-match, and against their ToS), and it is no longer needed for
// market prices -- Fairline compares the model to LIVE Sportsbet/Betfair
// prices at request time via /api/market-beaters. All predict-round.js
// actually needs from this file is the fixture: date, teams, venue, town.
// Market odds fields are written as null, which predict-round.js already
// handles ("Market: no odds captured").
//
// Team names are written in the same oddsportal long form the old file used
// ('North Melbourne W' etc) so predict-round.js's TEAM_MAP and the weather
// forecast's team-pair keys keep working unchanged.
//
// Usage: node fetch-upcoming-round.js [roundNumber] [seasonYear]
//        defaults to the next round with a game still to be played.

const fs = require('fs');

const AFLW_COMP_ID = 3;
const SEASON_YEAR = process.argv[3] || '2026';

// Elo short key -> oddsportal long name (reverse of predict-round.js's TEAM_MAP).
const ELOKEY_TO_ODDSPORTAL = {
  Kangaroos: 'North Melbourne W', Bulldogs: 'Western Bulldogs W', Crows: 'Adelaide Crows W',
  Eagles: 'West Coast Eagles W', Swans: 'Sydney Swans W', 'St Kilda': 'St Kilda W',
  GIANTS: 'GWS Giants W', Power: 'Port Adelaide W', Demons: 'Melbourne Demons W',
  Lions: 'Brisbane Lions W', Magpies: 'Collingwood Magpies W', Hawks: 'Hawthorn Hawks W',
  SUNS: 'Gold Coast Suns W', Cats: 'Geelong Cats W', Dockers: 'Fremantle Dockers W',
  Blues: 'Carlton Blues W', Bombers: 'Essendon Bombers W', Richmond: 'Richmond W',
};
// AFL.com.au has renamed two clubs' nicknames mid-history; same fixes as
// fetch-data.js's TEAM_NAME_FIXES (Freo -> Dockers bites here too, since
// matchItems still returns "Freo" for 2026 fixtures).
const NICKNAME_FIXES = { 'West Coast Eagles': 'Eagles', Freo: 'Dockers' };
const canonical = n => NICKNAME_FIXES[n] || n;

async function getToken() {
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', {
    method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' },
  });
  return (await res.json()).token;
}

async function main() {
  const venues = JSON.parse(fs.readFileSync('data/venues_raw.json', 'utf8'));
  const venueList = Array.isArray(venues) ? venues : venues.venues;
  const venueByProviderId = {};
  for (const v of venueList) venueByProviderId[v.providerId] = v;

  const token = await getToken();
  const seasons = await (await fetch(`https://aflapi.afl.com.au/afl/v2/competitions/${AFLW_COMP_ID}/compseasons?pageSize=100`)).json();
  const season = seasons.compSeasons.find(s => s.name.includes(SEASON_YEAR));
  if (!season) throw new Error(`no compseason matching ${SEASON_YEAR}`);
  const rounds = (await (await fetch(`https://aflapi.afl.com.au/afl/v2/compseasons/${season.id}/rounds?pageSize=40`)).json()).rounds;

  let roundNumber = process.argv[2] ? Number(process.argv[2]) : null;
  if (!roundNumber) {
    // Next round = lowest-numbered round with a game still to be played.
    // (It used to be "no CONCLUDED match yet", which skipped a part-played
    // round: on Fri 2 Oct 2026 it jumped to round 9 with 8 of round 8's games
    // still to come, because Thursday night's opener was done.)
    for (const r of rounds.filter(x => x.roundNumber).sort((a, b) => a.roundNumber - b.roundNumber)) {
      const items = (await (await fetch(`https://api.afl.com.au/cfs/afl/matchItems/round/${r.providerId}`, { headers: { 'x-media-mis-token': token } })).json()).items || [];
      const toPlay = items.some(i => i.match.status !== 'CONCLUDED' && i.match.status !== 'LIVE' && new Date(i.match.date).getTime() > Date.now());
      if (toPlay) { roundNumber = r.roundNumber; break; }
      await new Promise(res => setTimeout(res, 150));
    }
  }
  const round = rounds.find(r => r.roundNumber === roundNumber);
  if (!round) throw new Error(`round ${roundNumber} not found in ${season.name}`);

  const items = (await (await fetch(`https://api.afl.com.au/cfs/afl/matchItems/round/${round.providerId}`, { headers: { 'x-media-mis-token': token } })).json()).items || [];
  const out = [];
  const skipped = [];
  for (const item of items) {
    const m = item.match;
    // A round often opens Thursday/Friday while this runs (round 7, 2026:
    // four games done or live by Friday 5pm). Only price what's still to
    // be played -- a CONCLUDED match is already in the ratings, so its
    // "prediction" would be leakage, and a LIVE one isn't bettable pre-match.
    if (m.status === 'CONCLUDED' || m.status === 'LIVE' || new Date(m.date).getTime() <= Date.now()) {
      skipped.push(`${m.homeTeam?.nickname} v ${m.awayTeam?.nickname} (${m.status})`);
      continue;
    }
    const home = ELOKEY_TO_ODDSPORTAL[canonical(m.homeTeam?.nickname)];
    const away = ELOKEY_TO_ODDSPORTAL[canonical(m.awayTeam?.nickname)];
    if (!home || !away) { console.log(`  SKIP unmapped: ${m.homeTeam?.nickname} v ${m.awayTeam?.nickname}`); continue; }
    const venue = venueByProviderId[m.venue];
    out.push({
      date: Math.floor(new Date(m.date).getTime() / 1000),
      homeTeam: home,
      awayTeam: away,
      venue: venue ? venue.name : (m.venue || ''),
      venueTown: venue ? venue.location : '',
      venueTimezone: venue ? venue.timezone : null, // local kickoff hour -> the conditions term
      roundNumber, roundName: round.name, // e.g. "Semi Finals" -- the board labels finals by name
      homeAvgOdds: null, homeMaxOdds: null, awayAvgOdds: null, awayMaxOdds: null,
      bookmakerCount: 0,
      status: m.status,
    });
  }
  fs.writeFileSync('data/upcoming_round_odds.json', JSON.stringify(out, null, 2));
  console.log(`${season.name} Round ${roundNumber}: wrote ${out.length} fixtures to data/upcoming_round_odds.json`);
  for (const o of out) {
    console.log(`  ${new Date(o.date * 1000).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}  ${o.homeTeam} v ${o.awayTeam}  (${o.venue}, ${o.venueTown})  ${o.status}`);
  }
  if (skipped.length) console.log(`\nSkipped ${skipped.length} already started: ${skipped.join(', ')}`);
  if (!out.length) console.log('\nNOTE: nothing left to play in this round -- pass the next round number.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
