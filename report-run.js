// Tells Fairline how a scheduled run went (POST /api/board/run): success or
// failure, a link to the run and the end of its log. The workflow runs this
// even when an earlier step failed, so a broken run shows up at
// GET /api/board?runs=1 without needing access to GitHub.
//
// Usage: node report-run.js <status> [logFile]
const fs = require('fs');
const path = require('path');

const [status = 'unknown', logFile] = process.argv.slice(2);
const FAIRLINE_URL = process.env.FAIRLINE_URL || 'https://fairline.thomasfrederickmason.workers.dev';
const tokenFile = path.join(__dirname, '.board-token');
const token = process.env.FAIRLINE_BOARD_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null);

async function main() {
  if (!token) { console.log('no board token -- not reporting'); return; }
  const log = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-80).join('\n') : '';
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const res = await fetch(`${FAIRLINE_URL}/api/board/run`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': token },
    body: JSON.stringify({ status, runUrl, event: process.env.GITHUB_EVENT_NAME || null, log }),
  });
  console.log(`reported "${status}" to Fairline (HTTP ${res.status})`);
}

// reporting must never be the thing that fails a run
main().catch(e => console.log('report failed:', e.message));
