// Pulls the matchRoster/full endpoint for every match in data/matches.json —
// same AFL.com.au backend as fetch-data.js, same token exchange. Gives the
// full 22(+interchange/emergency) playing list per team per match, plus
// AFL.com.au's own computed `ins`/`outs` (with a reason, e.g. "Omitted",
// "Injury") versus that team's previous match. This is the real
// player-availability signal the README's "Next steps" flagged as missing —
// no need to diff rosters ourselves, the league already does it.
//
// Resumable: writes data/rosters.json after every match, skips matchIds
// already recorded on re-run.

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'data', 'rosters.json');

async function getToken() {
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' },
  });
  const { token } = await res.json();
  return token;
}

function extractTeamRoster(team) {
  if (!team) return null;
  return {
    teamId: team.teamId,
    ins: (team.ins || []).map(i => ({
      playerId: i.player.playerId,
      name: `${i.player.playerName.givenName} ${i.player.playerName.surname}`,
      reason: i.reason,
    })),
    outs: (team.outs || []).map(o => ({
      playerId: o.player.playerId,
      name: `${o.player.playerName.givenName} ${o.player.playerName.surname}`,
      reason: o.reason,
    })),
    milestones: (team.milestones || []).map(m => ({
      playerId: m.player?.playerId,
      name: m.player ? `${m.player.playerName.givenName} ${m.player.playerName.surname}` : null,
      milestone: m.milestone || m.type || null,
    })),
    clubDebuts: (team.clubDebuts || []).map(d => ({
      playerId: d.player?.playerId,
      name: d.player ? `${d.player.playerName.givenName} ${d.player.playerName.surname}` : null,
    })),
    positions: (team.positions || []).map(p => ({
      position: p.position,
      playerId: p.player.playerId,
      name: `${p.player.playerName.givenName} ${p.player.playerName.surname}`,
      jumperNumber: p.player.playerJumperNumber,
      captain: !!p.player.captain,
    })),
  };
}

async function getMatchRoster(matchId, token) {
  const res = await fetch(`https://api.afl.com.au/cfs/afl/matchRoster/full/${matchId}`, {
    headers: { 'x-media-mis-token': token },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  const mr = d.matchRoster;
  if (!mr) return null;
  return {
    matchId,
    roundNumber: mr.roundNumber,
    homeTeam: extractTeamRoster(mr.homeTeam),
    awayTeam: extractTeamRoster(mr.awayTeam),
  };
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
    let roster;
    try {
      roster = await getMatchRoster(m.matchId, token);
    } catch (e) {
      if (String(e.message).includes('401')) {
        token = await getToken(); // token can expire on a long run
        try { roster = await getMatchRoster(m.matchId, token); }
        catch (e2) { failed++; console.log(`  ${m.matchId} (${m.season} ${m.round}): FAILED (${e2.message})`); continue; }
      } else {
        failed++;
        console.log(`  ${m.matchId} (${m.season} ${m.round}): FAILED (${e.message})`);
        continue;
      }
    }
    if (roster) { out[m.matchId] = roster; withData++; }
    done++;
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
    if (done % 50 === 0) console.log(`${done}/${matches.length} (${withData} with roster data, ${failed} failed)`);
    await new Promise(r => setTimeout(r, 150)); // be polite, same delay as fetch-data.js
  }

  console.log(`\nDone: ${done}/${matches.length} processed, ${withData} with roster data, ${failed} failed`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
