// Per-player match stats for every match in data/matches.json, from the same
// AFL.com.au backend (playerStats/match/{matchId}). Kept compact: fantasy
// ("dreamTeam") points, time on ground and a few counting stats per player.
// Used to value players for the team-news adjustment (player-value.js).
// Champion Data's own ratingPoints is null for AFLW, so fantasy points it is.
//
// Resumable: writes data/player_stats.json as it goes, skips matches already
// recorded. Usage: node fetch-player-stats.js

const fs = require('fs');
const OUT = 'data/player_stats.json';

async function getToken() {
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' } });
  return (await res.json()).token;
}
const pack = (p, side) => {
  const s = p.playerStats.stats;
  return {
    id: p.playerStats.player.playerId, side,
    name: `${p.playerStats.player.playerName.givenName} ${p.playerStats.player.playerName.surname}`,
    fp: s.dreamTeamPoints, tog: p.playerStats.timeOnGroundPercentage,
    d: s.disposals, g: s.goals, b: s.behinds, t: s.tackles, cp: s.contestedPossessions, mg: s.metresGained,
  };
};

(async () => {
  const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8')).filter(m => m.status === 'CONCLUDED');
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let token = await getToken(), done = 0, failed = 0;
  for (const m of matches) {
    if (out[m.matchId]) continue;
    let res = await fetch(`https://api.afl.com.au/cfs/afl/playerStats/match/${m.matchId}`, { headers: { 'x-media-mis-token': token } });
    if (res.status === 401 || res.status === 403) { token = await getToken(); res = await fetch(`https://api.afl.com.au/cfs/afl/playerStats/match/${m.matchId}`, { headers: { 'x-media-mis-token': token } }); }
    if (!res.ok) { failed++; continue; }
    const d = await res.json();
    out[m.matchId] = [...(d.homeTeamPlayerStats || []).map(p => pack(p, 'home')), ...(d.awayTeamPlayerStats || []).map(p => pack(p, 'away'))];
    if (++done % 25 === 0) { fs.writeFileSync(OUT, JSON.stringify(out)); console.log(`${done} fetched`); }
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Player stats: ${Object.keys(out).length} matches (${done} new, ${failed} failed)`);
})();
