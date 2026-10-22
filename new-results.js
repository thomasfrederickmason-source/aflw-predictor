// How many AFLW games have finished that data/matches.json doesn't have yet?
// One request to AFL.com.au's public match list (no token), so the scheduled
// reprice (run-round.js --auto) can skip the full results pull and refit when
// nothing new has been played -- the refit only changes when results do.
// Prints a JSON line { newResults, season } and always exits 0 unless the
// check itself failed (then run-round.js refits, to be safe).
const fs = require('fs');
const path = require('path');

async function main() {
  const year = String(new Date().getFullYear());
  const seasons = (await (await fetch('https://aflapi.afl.com.au/afl/v2/competitions/3/compseasons?pageSize=100')).json()).compSeasons;
  const season = seasons.find(s => s.name.includes(year));
  if (!season) throw new Error(`no ${year} AFLW season`);
  const d = await (await fetch(`https://aflapi.afl.com.au/afl/v2/matches?competitionId=3&compSeasonId=${season.id}&pageSize=400`)).json();
  const have = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'matches.json'), 'utf8')).map(m => m.matchId));
  const missing = d.matches.filter(m => m.status === 'CONCLUDED' && !have.has(m.providerId));
  console.log(JSON.stringify({ newResults: missing.length, season: season.name, games: missing.map(m => `${m.home.team.name} v ${m.away.team.name}`) }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
