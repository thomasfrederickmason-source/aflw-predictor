// Tells Fairline how a scheduled run went (POST /api/board/run): success or
// failure, a link to the run and the end of its log. The workflow runs this
// even when an earlier step failed, so a broken run shows up at
// GET /api/board?runs=1 without needing access to GitHub. A run with no
// usable token still reports that much ("no-token" / "bad-token"), so a
// missing or mistyped Actions secret isn't silent.
//
// Usage: node report-run.js <status> [logFile]
const fs = require('fs');
const path = require('path');

const [status = 'unknown', logFile] = process.argv.slice(2);
const FAIRLINE_URL = process.env.FAIRLINE_URL || 'https://fairline.thomasfrederickmason.workers.dev';
const tokenFile = path.join(__dirname, '.board-token');
const token = process.env.FAIRLINE_BOARD_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null);
const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;

const post = (body, withToken) => fetch(`${FAIRLINE_URL}/api/board/run`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(withToken ? { 'x-board-token': token } : {}) },
  body: JSON.stringify(body),
});

async function main() {
  if (!token) {
    const res = await post({ status: 'no-token', runUrl }, false);
    console.log(`no board token (is the FAIRLINE_BOARD_TOKEN secret set?) -- reported "no-token" (HTTP ${res.status})`);
    return;
  }
  const log = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-80).join('\n') : '';
  const res = await post({ status, runUrl, event: process.env.GITHUB_EVENT_NAME || null, log }, true);
  if (res.status === 401) {
    const r2 = await post({ status: 'bad-token', runUrl }, false);
    console.log(`Fairline refused the board token (does the secret match .board-token?) -- reported "bad-token" (HTTP ${r2.status})`);
    return;
  }
  console.log(`reported "${status}" to Fairline (HTTP ${res.status})`);
}

// reporting must never be the thing that fails a run
main().catch(e => console.log('report failed:', e.message));
