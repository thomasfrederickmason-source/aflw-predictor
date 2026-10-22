// Publishes the repriced round to Fairline's LIVE board (added 2026-10-22):
// POST /api/board with the markets (data/betting_odds_model.json), the fitted
// spreads (model_params.json), the round's predictions for the Record tab's
// ledger, this season's results and oddsportal's closing prices. No deploy
// needed: the Worker keeps it in KV and serves it from there.
//
// The Worker only stores a push when a price moved enough to matter (or the
// games, team news or lineups changed), so this is safe to run every hour.
//
// Usage: node push-board.js <round> [season] [--force] [--save-ledger=<path>]
//   --force          store it even if nothing moved
//   --save-ledger=   afterwards, save the live ledger to this file (run-round.js
//                    --deploy keeps the bundled fallback copy in step with it)
// Token: FAIRLINE_BOARD_TOKEN, else the file .board-token (not in git).
const fs = require('fs');
const path = require('path');
const { ledgerEntry, closingOdds, seasonResults } = require('./fairline-ledger');

const args = process.argv.slice(2);
const ROUND = Number(args.find(a => /^\d+$/.test(a)));
const SEASON = args.filter(a => /^\d+$/.test(a))[1] || '2026';
const force = args.includes('--force');
const saveLedger = (args.find(a => a.startsWith('--save-ledger=')) || '').slice('--save-ledger='.length) || null;
const FAIRLINE_URL = process.env.FAIRLINE_URL || 'https://fairline.thomasfrederickmason.workers.dev';
const tokenFile = path.join(__dirname, '.board-token');
const token = process.env.FAIRLINE_BOARD_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null);
if (!ROUND) { console.error('usage: node push-board.js <round> [season] [--force]'); process.exit(1); }
if (!token) { console.error('no board token: set FAIRLINE_BOARD_TOKEN or write .board-token'); process.exit(1); }

const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));

async function main() {
  const board = read('betting_odds_model.json');
  const params = read('model_params.json');
  const snap = read(`round${ROUND}_${SEASON}_prediction_snapshot.json`);
  const meta = {
    round: ROUND, roundName: snap.roundName || `Round ${ROUND}`, season: Number(SEASON),
    publishedAt: snap.capturedAt,
    source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'pc',
  };
  const at = Date.parse(snap.capturedAt);
  const ledgerEntries = snap.predictions.filter(p => at < p.date * 1000).map(p => ledgerEntry(p, ROUND, snap.capturedAt));
  const body = JSON.stringify({ board, meta, params, ledgerEntries, results: seasonResults(), closingOdds: closingOdds(), force });

  const res = await fetch(`${FAIRLINE_URL}/api/board`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': token }, body });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || out.error) { console.error(`push failed: ${out.error || res.status}`); process.exit(1); }
  if (out.stored) {
    console.log(`Live board updated: ${meta.roundName}, ${out.games} games (${(body.length / 1024).toFixed(0)} KB)`);
    for (const c of out.changes) console.log(`  ${c}`);
  } else {
    console.log(`Live board unchanged: ${out.reason} (live since ${out.liveSince})`);
  }

  if (saveLedger) {
    const live = await (await fetch(`${FAIRLINE_URL}/api/board?ledger=1`)).json();
    if (!live.ledger || !Array.isArray(live.ledger.games)) { console.error('could not read the live ledger back'); process.exit(1); }
    fs.writeFileSync(saveLedger, JSON.stringify(live.ledger, null, 1));
    console.log(`Saved the live ledger (${live.ledger.games.length} predictions) to ${saveLedger}`);
  }
}

main().catch(e => { console.error('push failed:', e.message); process.exit(1); });
