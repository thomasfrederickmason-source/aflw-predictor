// The parts of Fairline's published-prediction ledger (the Record tab's input)
// that both publishers build: update-fairline.js (the copy bundled with a
// deploy, the fallback) and push-board.js (the live board, since 2026-10-22).
// One copy, so the two can't drift apart.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');

// One snapshot prediction as a ledger entry. The entry only ever replaces an
// older one made before that game's kickoff (the publisher checks that).
function ledgerEntry(p, round, capturedAt) {
  return {
    round, date: p.date, homeTeam: p.homeTeam, awayTeam: p.awayTeam, venue: p.venue,
    pHome: +p.modelHomeProb.toFixed(4), margin: +p.predictedMargin.toFixed(2), total: +p.predTotal.toFixed(2),
    publishedAt: capturedAt,
    // rounds 3 and 5 also saved the market's pre-match price (oddsportal average)
    earlyMarket: p.marketHomeOdds && p.marketAwayOdds ? { home: p.marketHomeOdds, away: p.marketAwayOdds, source: 'oddsportal' } : null,
  };
}

// Completed matches, for filling in results.
function completedMatches() {
  return JSON.parse(fs.readFileSync(path.join(DATA, 'matches.json'), 'utf8')).filter(m => m.homeScore != null);
}

// Closing head-to-head odds from oddsportal (fetch-oddsportal-season.js): the
// market's final price for games before Fairline saved its own (round 8 on),
// and a five-bookmaker cross-check after. Checked against Fairline's own
// captured closes in rounds 8-9: 1.4 points apart on average (max 3.3).
const opKey = n => { n = String(n).replace(/ W$/, ''); for (const [re, k] of [[/north melbourne/i, 'Kangaroos'], [/port adelaide/i, 'Power'], [/gws|giants/i, 'GIANTS'], [/west coast/i, 'Eagles'], [/bulldogs/i, 'Bulldogs'], [/adelaide/i, 'Crows'], [/brisbane/i, 'Lions'], [/carlton/i, 'Blues'], [/collingwood/i, 'Magpies'], [/essendon/i, 'Bombers'], [/fremantle/i, 'Dockers'], [/geelong/i, 'Cats'], [/gold coast/i, 'SUNS'], [/hawthorn/i, 'Hawks'], [/melbourne/i, 'Demons'], [/richmond/i, 'Richmond'], [/st\.? ?kilda/i, 'St Kilda'], [/sydney/i, 'Swans']]) if (re.test(n)) return k; return n; };
function closingOdds() {
  const rows = fs.readdirSync(DATA).filter(f => /^oddsportal_\d{4}\.json$/.test(f)).flatMap(f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).rows);
  return rows.map(o => ({ date: o.date, homeTeam: opKey(o.homeTeam), awayTeam: opKey(o.awayTeam), home: o.homeAvgOdds, away: o.awayAvgOdds, homeMax: o.homeMaxOdds, awayMax: o.awayMaxOdds, books: o.bookmakerCount }));
}

// every result this season too, for games the board priced but the ledger missed
function seasonResults(results = completedMatches()) {
  return results.filter(m => Date.parse(m.date) > Date.now() - 200 * 86400e3)
    .map(m => ({ date: Math.round(Date.parse(m.date) / 1000), homeTeam: m.homeTeam, awayTeam: m.awayTeam, home: m.homeScore, away: m.awayScore }));
}

module.exports = { ledgerEntry, completedMatches, closingOdds, seasonResults };
