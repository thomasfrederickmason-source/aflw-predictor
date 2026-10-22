// Pulls the scoring-event timeline (quarter + seconds-into-quarter for every
// goal/behind, with scorer name) for every AFLW match on record.
//
// Source: the same undocumented api.afl.com.au backend fetch-data.js already
// uses, but the single-match endpoint rather than the round list:
//   GET https://api.afl.com.au/cfs/afl/matchItem/{matchId}
// Its score.scoreWorm.scoringEvents array has structured fields (homeOrAway,
// scoreType: GOAL/BEHIND/RUSHED_BEHIND, full player name, running score) and
// goes all the way back to the first 2017 match — checked explicitly across
// every season (3-match sample per season, all had data). This supersedes an
// earlier version of this script that used /cfs/commentaryFeed/{matchId},
// which only has coverage from 2023 onward and needed regex-parsing of
// free-text comments to recover team/scorer/rushed-behind — matchItem gives
// all of that as real fields, for the full 2017-2026 history.

const fs = require('fs');

async function getToken() {
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' },
  });
  const { token } = await res.json();
  return token;
}

async function fetchMatchItem(matchId, token) {
  const res = await fetch(`https://api.afl.com.au/cfs/afl/matchItem/${matchId}`, {
    headers: { 'x-media-mis-token': token, 'Accept-Encoding': 'gzip', 'User-Agent': 'Mozilla/5.0' },
  });
  if (res.status === 401) return { needsNewToken: true };
  if (!res.ok) throw new Error(`matchId ${matchId} -> HTTP ${res.status}`);
  return { data: await res.json() };
}

function parseEvents(scoringEvents) {
  return scoringEvents.map(e => ({
    quarter: e.periodNumber,
    seconds: e.periodSeconds,
    team: e.homeOrAway === 'HOME' ? 'home' : 'away',
    teamName: e.teamName?.teamNickname ?? null,
    type: e.scoreType === 'GOAL' ? 'goal' : 'behind',
    method: e.scoreType === 'RUSHED_BEHIND' ? 'rushed' : 'checked',
    scorer: e.playerScore?.player?.playerName
      ? `${e.playerScore.player.playerName.givenName} ${e.playerScore.player.playerName.surname}`
      : null,
    scoreValue: e.scoreValue,
    aggregateHomeScore: e.aggregateHomeScore,
    aggregateAwayScore: e.aggregateAwayScore,
  })).sort((a, b) => (a.quarter - b.quarter) || (a.seconds - b.seconds));
}

async function main() {
  const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
  console.log(`${matches.length} matches to fetch`);

  let token = await getToken();
  const out = [];
  let skippedEmpty = 0, errors = 0;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    let result;
    try {
      result = await fetchMatchItem(m.matchId, token);
      if (result.needsNewToken) {
        token = await getToken();
        result = await fetchMatchItem(m.matchId, token);
      }
    } catch (e) {
      console.log(`  ${m.matchId} (${m.season} ${m.round}) -> ERROR ${e.message}`);
      errors++;
      continue;
    }

    const scoringEvents = result.data?.score?.scoreWorm?.scoringEvents;
    if (!scoringEvents || scoringEvents.length === 0) { skippedEmpty++; continue; }

    out.push({
      matchId: m.matchId,
      season: m.season,
      round: m.round,
      date: m.date,
      venue: m.venueName,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      events: parseEvents(scoringEvents),
    });

    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${matches.length}`);
    await new Promise(r => setTimeout(r, 120)); // polite delay, undocumented backend
  }

  fs.writeFileSync('./data/scoring_events.json', JSON.stringify(out, null, 1));
  console.log(`Wrote ${out.length} matches with scoring timelines to data/scoring_events.json`);
  console.log(`Skipped ${skippedEmpty} matches with no scoreWorm data, ${errors} fetch errors`);
}

main().catch(e => { console.error(e); process.exit(1); });
