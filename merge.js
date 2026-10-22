// Joins data/matches.json (AFL.com.au — full history, quarter scores) with
// data/odds.json (oddsportal — partial history, moneyline odds) on team names
// + date, and writes data/matches_with_odds.json.

const fs = require('fs');

const results = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const odds = JSON.parse(fs.readFileSync('data/odds.json', 'utf8'));

// AFL.com.au uses short nicknames; oddsportal uses "<Name> W". Normalize both
// to a common key so they can be joined.
const NICKNAME_MAP = {
  'crows': 'adelaide crows', 'lions': 'brisbane lions', 'blues': 'carlton blues',
  'magpies': 'collingwood magpies', 'bombers': 'essendon bombers', 'dockers': 'fremantle dockers',
  'freo': 'fremantle dockers', 'giants': 'gws giants', 'cats': 'geelong cats',
  'suns': 'gold coast suns', 'hawks': 'hawthorn hawks', 'demons': 'melbourne demons',
  'kangaroos': 'north melbourne', 'power': 'port adelaide', 'richmond': 'richmond',
  'st kilda': 'st kilda', 'swans': 'sydney swans', 'west coast eagles': 'west coast eagles',
  'eagles': 'west coast eagles', 'bulldogs': 'western bulldogs',
};
function normalize(name) {
  const n = name.toLowerCase().replace(/\bw\b/g, '').trim();
  return NICKNAME_MAP[n] || n;
}

// Index by UNORDERED team pair (see note below on why order can't be trusted
// across sources), tolerant to date rounding differences between providers.
const oddsByUnorderedPair = new Map();
for (const o of odds) {
  const key = [normalize(o.homeTeam), normalize(o.awayTeam)].sort().join('|');
  if (!oddsByUnorderedPair.has(key)) oddsByUnorderedPair.set(key, []);
  oddsByUnorderedPair.get(key).push(o);
}

// IMPORTANT: don't trust "home"/"away" naming order agreeing between the two
// sources. AFLW fixtures are often played at a ground that isn't the
// rostered "home" team's usual venue, and AFL.com.au vs oddsportal disagreed
// on which side counts as home for a meaningful chunk of matches (found by
// checking short-priced-favourite win rates — they were implausibly low
// until this was accounted for). Since odds.json also carries oddsportal's
// own homeScore/awayScore, align by matching SCORES to the correct team,
// not by assuming name order — and swap the odds fields when they disagree.
let matched = 0, unmatched = 0, swapped = 0;
const merged = results.map(m => {
  // unordered pair key so we find the fixture regardless of which side either
  // source calls "home"
  const pairKey = [normalize(m.homeTeam), normalize(m.awayTeam)].sort().join('|');
  const candidates = oddsByUnorderedPair.get(pairKey) || [];
  const matchTs = new Date(m.date).getTime() / 1000;
  let best = null, bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(c.timestamp - matchTs);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  const withinTolerance = best && bestDiff < 3 * 24 * 3600; // 3 days
  if (!withinTolerance) { unmatched++; return { ...m, homeAvgOdds: null, homeMaxOdds: null, awayAvgOdds: null, awayMaxOdds: null, oddsBookmakerCount: null }; }

  matched++;
  // Does oddsportal's home team actually match OUR home team (by score, the
  // reliable signal) or is it flipped?
  const oddsHomeMatchesOurHome = best.homeScore === m.homeScore && best.awayScore === m.awayScore;
  const oddsHomeMatchesOurAway = best.homeScore === m.awayScore && best.awayScore === m.homeScore;
  let homeAvgOdds, homeMaxOdds, awayAvgOdds, awayMaxOdds;
  if (oddsHomeMatchesOurHome) {
    homeAvgOdds = best.homeAvgOdds; homeMaxOdds = best.homeMaxOdds;
    awayAvgOdds = best.awayAvgOdds; awayMaxOdds = best.awayMaxOdds;
  } else if (oddsHomeMatchesOurAway) {
    swapped++;
    homeAvgOdds = best.awayAvgOdds; homeMaxOdds = best.awayMaxOdds;
    awayAvgOdds = best.homeAvgOdds; awayMaxOdds = best.homeMaxOdds;
  } else {
    // scores don't match either way (shouldn't happen given the pair+date
    // match) — treat as unreliable, drop the odds rather than guess.
    matched--; unmatched++;
    return { ...m, homeAvgOdds: null, homeMaxOdds: null, awayAvgOdds: null, awayMaxOdds: null, oddsBookmakerCount: null };
  }
  return { ...m, homeAvgOdds, homeMaxOdds, awayAvgOdds, awayMaxOdds, oddsBookmakerCount: best.bookmakerCount };
});

fs.writeFileSync('data/matches_with_odds.json', JSON.stringify(merged, null, 2));
console.log(`Matched ${matched} of ${results.length} results matches to odds (${(100*matched/results.length).toFixed(1)}%)`);
console.log(`Of those, ${swapped} needed home/away swapped to align with AFL.com.au's home/away designation`);
console.log(`Unmatched: ${unmatched}`);
