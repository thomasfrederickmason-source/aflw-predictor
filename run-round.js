// ONE command for the Fairline update:
//
//   node run-round.js <round>              refresh data + model, price the round
//   node run-round.js <round> --publish    ...and put it on the LIVE board (no deploy)
//   node run-round.js <round> --deploy     ...publish, and redeploy the Worker with
//                                          this board bundled as its fallback copy
//   node run-round.js --publish --auto     the scheduled reprice (GitHub Actions):
//                                          refit only if new results are in, then
//                                          reprice with the latest forecast and teams
//
// Runs every step in order and stops at the first failure -- including the
// consistency gate at the end of betting-odds-model.js, so a board whose
// markets contradict each other can't be published. Omit <round> to price the
// next round that still has games to play.
//
// Since 2026-10-22 publishing is a POST to Fairline's /api/board (push-board.js):
// the Worker keeps the board in KV, so a reprice needs no deploy and can run
// from anywhere with the board token.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const roundArg = args.find(a => /^\d+$/.test(a)) || null;
const publish = flags.has('--publish') || flags.has('--deploy');
const deploy = flags.has('--deploy');
const auto = flags.has('--auto');
const FAIRLINE = 'C:/Users/Tom/Projects/Fairline';

function step(label, script, scriptArgs = []) {
  const t0 = Date.now();
  process.stdout.write(`\n==> ${label}\n`);
  try {
    const out = execFileSync(process.execPath, [script, ...scriptArgs], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { out, secs: ((Date.now() - t0) / 1000).toFixed(0) };
  } catch (e) {
    console.log((e.stdout || '').split('\n').slice(-25).join('\n'));
    console.log((e.stderr || '').split('\n').slice(-15).join('\n'));
    console.log(`\nSTOPPED at "${label}" -- nothing was published.`);
    process.exit(1);
  }
}
const tail = (s, n) => s.trim().split('\n').slice(-n).join('\n');

// --auto: the refit (steps 1-6) only changes when results do, so skip it when
// AFL.com.au has no finished game that matches.json is missing. If the check
// itself fails, refit anyway.
let refit = true;
if (auto) {
  try {
    const check = JSON.parse(execFileSync(process.execPath, ['new-results.js'], { cwd: __dirname, encoding: 'utf8' }).trim());
    const fitted = ['elo_ratings.json', 'score_ratings.json', 'ridge_ratings.json', 'model_params.json'].every(f => fs.existsSync(path.join(__dirname, 'data', f)));
    refit = check.newResults > 0 || !fitted;
    console.log(check.newResults > 0 ? `\n${check.newResults} new result(s) (${check.games.join(', ')}) -- refitting the model first.`
      : `\nNo new results since the last refit -- reusing the fitted model, repricing with the latest forecast and teams.`);
  } catch (e) { console.log(`\nCouldn't check for new results (${(e.stderr || e.message || '').trim().split('\n').pop()}) -- refitting to be safe.`); }
}

let r;
if (refit) {
  r = step('1/10 Pull results from AFL.com.au (concluded matches only)', 'fetch-data.js');
  console.log(tail(r.out, 1));
  r = step('2/10 Match venues', 'enrich-venues.js'); console.log(tail(r.out, 1));
  // last round's closing odds for the Record tab (oddsportal; not essential, so a failure doesn't stop the run)
  try { console.log('\n==>     Closing odds (oddsportal)\n' + tail(execFileSync(process.execPath, ['fetch-oddsportal-season.js'], { cwd: __dirname, encoding: 'utf8' }), 1)); }
  catch (e) { console.log('  skipped: ' + ((e.stderr || e.message || '').trim().split('\n').pop())); }
  r = step('3/10 Team sheets history (career games, for the team-news adjustment)', 'fetch-rosters.js'); console.log(tail(r.out, 1));
  r = step('    Player stats (fantasy points, for lineup strength)', 'fetch-player-stats.js'); console.log(tail(r.out, 1));
  r = step('4/10 Elo ratings', 'elo-model.js'); console.log(tail(r.out.split('\n\nModel Brier')[0], 19));
  r = step('5/10 Scoring model', 'score-model.js'); console.log('  done');
  r = step('    Ridge ratings (every recent result refit at once)', 'ridge-model.js'); console.log(tail(r.out.split('Ridge ratings')[0], 1));
  r = step('6/10 Refit model parameters (walk-forward backtest)', 'backtest-model.js', ['--write']);
  console.log(tail(r.out.split('=== Live model params')[1] ? '=== Live model params' + r.out.split('=== Live model params')[1] : r.out, 6));
  r = step('    Refit team-news adjustment (walk-forward)', 'roster-backtest.js', ['--write']);
  console.log(tail(r.out, 1));
  // archived match-window weather for games just played (Open-Meteo archive, ~5-day lag; soft step)
  try { console.log('\n==>     Archived match weather (for the conditions refit)\n' + tail(execFileSync(process.execPath, ['fetch-openmeteo-historical.js'], { cwd: __dirname, encoding: 'utf8', timeout: 240000 }), 1)); }
  catch (e) { console.log('  skipped: ' + ((e.stderr || e.message || '').trim().split('\n').pop())); }
  r = step('    Refit match conditions: wind, rain, kickoff time (conditions-model.js)', 'conditions-model.js', ['--write']);
  console.log(tail(r.out.split('\nWritten')[0], 6));
}
r = step('7/10 Fixtures still to be played', 'fetch-upcoming-round.js', roundArg ? [roundArg] : []);
console.log(tail(r.out, 14));
const roundMatch = r.out.match(/Round (\d+): wrote (\d+) fixtures/);
if (!roundMatch || Number(roundMatch[2]) === 0) {
  console.log('\nNo fixtures left to price -- pass the next round number.');
  // between rounds (or after the season) a scheduled run has nothing to do; that isn't a failure
  process.exit(auto ? 0 : 1);
}
const round = roundMatch[1];
step('8/10 Weather forecast', 'fetch-openmeteo-forecast.js');
step('9/10 Quarter profiles', 'quarter-analysis.js');
r = step(`10/10 Predict round ${round} + build markets`, 'predict-round.js', [round]);
console.log(r.out.trim().split('\n').filter(l => !l.startsWith('===') && !l.startsWith('Saved')).join('\n'));
r = step('     Markets + consistency gate', 'betting-odds-model.js', [round]);
console.log((r.out.split(/Wrote data\/betting_odds_model\.json[^\n]*\n/)[1] || tail(r.out, 12)).trim());

if (!publish) { console.log(`\nDone. Round ${round} priced but NOT published (add --publish or --deploy).`); process.exit(0); }

// The live board: the Worker stores it only if a price moved enough to matter.
// --deploy also saves the live ledger back as the bundled fallback copy.
const pushArgs = [round, ...(flags.has('--force') || deploy ? ['--force'] : []), ...(deploy ? [`--save-ledger=${FAIRLINE}/data/published.json.live`] : [])];
r = step('Publish to the live Fairline board', 'push-board.js', pushArgs);
console.log(r.out.trim());
if (!deploy) { console.log(`\nDone: round ${round} is on the live board.`); process.exit(0); }

// Bundled fallback copy (PC only): what the Worker serves if KV has no board.
// Which round is on the board now? (update-fairline.js swaps the labels)
const html = fs.readFileSync(path.join(FAIRLINE, 'public/index.html'), 'utf8');
const metaBlock = html.match(/<script id="board-meta" type="application\/json">([\s\S]*?)<\/script>/);
let onBoard = null;
try { onBoard = metaBlock ? String(JSON.parse(metaBlock[1]).round) : null; } catch (e) { /* fall back below */ }
if (!onBoard) onBoard = (html.match(/AFLW Round (\d+)/) || [])[1];
if (!onBoard) { console.log('Could not tell which round the board shows -- publish by hand with update-fairline.js'); process.exit(1); }
r = step(`Bundle into Fairline (board round ${onBoard} -> ${round})`, 'update-fairline.js', [onBoard, round]);
console.log(tail(r.out, 3));
// the live ledger is the record of truth (scheduled reprices add to it); bundle that
const liveLedger = `${FAIRLINE}/data/published.json.live`;
if (fs.existsSync(liveLedger)) { fs.renameSync(liveLedger, `${FAIRLINE}/data/published.json`); console.log('  bundled the live ledger as data/published.json'); }

process.stdout.write('\n==> Deploy Fairline\n');
const wrangler = fs.existsSync('C:/Users/Tom/Projects/NFLSweepBanteros/node_modules/.bin/wrangler.cmd')
  ? 'C:/Users/Tom/Projects/NFLSweepBanteros/node_modules/.bin/wrangler.cmd' : 'npx.cmd';
const wargs = wrangler.endsWith('npx.cmd') ? ['wrangler', 'deploy'] : ['deploy'];
try {
  const out = execFileSync(wrangler, wargs, { cwd: FAIRLINE, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(tail(out, 3));
} catch (e) { console.log(e.stdout || '', e.stderr || ''); console.log('Deploy failed -- the live board is already updated; the bundled fallback is not.'); process.exit(1); }
console.log(`\nDone: round ${round} is live on Fairline (and bundled as the fallback).`);
