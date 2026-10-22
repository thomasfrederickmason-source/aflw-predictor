// Pulls full AFLW match history (2017–present) from the AFL.com.au match-centre
// backend, including quarter-by-quarter scores, and writes it to data/matches.json
// and data/matches.csv.
//
// This is the same undocumented API fitzRoy's source="AFL" functions use — it's
// not a public/supported API, just AFL.com.au's own site backend, so it could
// change or break without notice. No auth needed beyond the open token exchange.
//
// IMPORTANT: this fully overwrites matches.json from raw match data only —
// it does NOT carry forward venueName/venueLocation/venueState. Always
// re-run `node enrich-venues.js` right after this (once found the hard way:
// forgetting it silently drops venue coverage, e.g. 726/726 -> 675/735 when
// this ran with a stale venues_raw.json missing a few newer venue codes —
// fix new codes via matchRoster/full/{matchId}'s venue object and append to
// data/venues_raw.json, don't just patch matches.json in memory).

const fs = require('fs');
const path = require('path');

const AFLW_COMP_ID = 3; // 'NAB AFLW' — id 18/19 are preseason/exhibition, skip those

async function getToken() {
  const res = await fetch('https://api.afl.com.au/cfs/afl/WMCTok', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Length': '0' },
  });
  const { token } = await res.json();
  return token;
}

async function getSeasons() {
  const res = await fetch(`https://aflapi.afl.com.au/afl/v2/competitions/${AFLW_COMP_ID}/compseasons?pageSize=100`);
  const d = await res.json();
  return d.compSeasons;
}

async function getRounds(compSeasonId) {
  const res = await fetch(`https://aflapi.afl.com.au/afl/v2/compseasons/${compSeasonId}/rounds?pageSize=40`);
  const d = await res.json();
  return d.rounds;
}

async function getRoundMatches(roundProviderId, token) {
  const res = await fetch(`https://api.afl.com.au/cfs/afl/matchItems/round/${roundProviderId}`, {
    headers: { 'x-media-mis-token': token, 'Accept-Encoding': 'gzip' },
  });
  if (!res.ok) throw new Error(`round ${roundProviderId} -> HTTP ${res.status}`);
  const d = await res.json();
  return d.items || [];
}

function periodArray(teamScore) {
  // Always return exactly 4 quarter totals (nulls if a period is missing, e.g. abandoned match).
  const out = [null, null, null, null];
  for (const p of (teamScore.periodScore || [])) {
    if (p.periodNumber >= 1 && p.periodNumber <= 4) out[p.periodNumber - 1] = p.score.totalScore;
  }
  return out;
}

// AFL.com.au's own team nickname field has changed over the years for a
// couple of clubs (found by the Elo model quietly treating them as two
// different teams) — canonicalize so history joins up correctly.
const TEAM_NAME_FIXES = {
  'West Coast Eagles': 'Eagles', // "West Coast Eagles" in 2020-21 data, "Eagles" from 2022 on
  'Freo': 'Dockers', // "Freo" 2017-2025, "Dockers" from 2026 on
};
function canonicalTeamName(name) {
  return TEAM_NAME_FIXES[name] || name;
}

function extractMatch(item, seasonYear, roundName) {
  const m = item.match;
  const s = item.score;
  if (!s || !s.homeTeamScore || !s.awayTeamScore) return null; // not played / no score yet
  // A match still being played reports a real (partial) score, so the check
  // above lets it through -- pulling mid-round would otherwise feed a
  // half-finished scoreline into Elo/score ratings as if it were a result.
  if (m.status !== "CONCLUDED") return null;
  const home = s.homeTeamScore, away = s.awayTeamScore;
  return {
    matchId: m.matchId,
    season: seasonYear,
    round: roundName,
    date: m.date,
    status: m.status,
    venue: m.venue,
    homeTeam: canonicalTeamName(m.homeTeam?.nickname || m.homeTeam?.name),
    awayTeam: canonicalTeamName(m.awayTeam?.nickname || m.awayTeam?.name),
    homeScore: home.matchScore?.totalScore ?? null,
    awayScore: away.matchScore?.totalScore ?? null,
    homeGoals: home.matchScore?.goals ?? null,
    homeBehinds: home.matchScore?.behinds ?? null,
    awayGoals: away.matchScore?.goals ?? null,
    awayBehinds: away.matchScore?.behinds ?? null,
    homeQtr: periodArray(home), // points scored IN that quarter (not cumulative) — verified sums to matchScore.totalScore
    awayQtr: periodArray(away),
    margin: (home.matchScore?.totalScore ?? null) - (away.matchScore?.totalScore ?? null),
    totalScore: (home.matchScore?.totalScore ?? 0) + (away.matchScore?.totalScore ?? 0),
  };
}

async function main() {
  const token = await getToken();
  console.log('got token');

  const seasons = await getSeasons();
  console.log(`found ${seasons.length} AFLW seasons`);

  const allMatches = [];
  for (const season of seasons) {
    const rounds = await getRounds(season.id);
    console.log(`${season.name}: ${rounds.length} rounds`);
    for (const round of rounds) {
      let items;
      try {
        items = await getRoundMatches(round.providerId, token);
      } catch (e) {
        console.log(`  ${round.name}: skip (${e.message})`);
        continue;
      }
      let count = 0;
      for (const item of items) {
        const match = extractMatch(item, season.name, round.name);
        if (match) { allMatches.push(match); count++; }
      }
      console.log(`  ${round.name}: ${count} completed matches`);
      // Be polite to an undocumented backend — small delay between calls.
      await new Promise(r => setTimeout(r, 150));
    }
  }

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'matches.json'), JSON.stringify(allMatches, null, 2));

  const csvHeader = ['matchId','season','round','date','venue','homeTeam','awayTeam',
    'homeScore','awayScore','margin','totalScore',
    'homeQ1','homeQ2','homeQ3','homeQ4','awayQ1','awayQ2','awayQ3','awayQ4'].join(',');
  const csvRows = allMatches.map(m => [
    m.matchId, m.season, m.round, m.date, m.venue, m.homeTeam, m.awayTeam,
    m.homeScore, m.awayScore, m.margin, m.totalScore,
    ...m.homeQtr, ...m.awayQtr,
  ].map(v => v == null ? '' : String(v).includes(',') ? `"${v}"` : v).join(','));
  fs.writeFileSync(path.join(outDir, 'matches.csv'), [csvHeader, ...csvRows].join('\n'));

  console.log(`\nTotal matches saved: ${allMatches.length}`);
  console.log(`Written to ${outDir}/matches.json and matches.csv`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
