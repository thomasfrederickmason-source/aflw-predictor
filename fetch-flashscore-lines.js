// Pulls totals (over/under) and Asian handicap odds from flashscore.com for
// every AFLW match across all seasons — the market data oddsportal doesn't
// expose without a live browser (see README). Runs headless via Playwright,
// driving the same UI a person would (no attempt to bypass flashscore's
// signed internal feed API, which returns 401 without a valid x-fsign token
// computed by their obfuscated JS).
//
// Resumable: writes data/flashscore_lines.json after every match, and skips
// hrefs already recorded for a season on re-run.
//
// Coverage note: 2022 (both "S6" and "S7" halves) has zero odds of any kind
// on flashscore (moneyline, totals, handicap) — confirmed by manual spot
// check before running this at scale. Matches from those seasons will come
// back with empty overUnder/handicap arrays; that's expected, not a bug.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const OUT_PATH = path.join(__dirname, 'data', 'flashscore_lines.json');

const SEASON_URLS = [
  ['2017', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2017/results/'],
  ['2018', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2018/results/'],
  ['2019', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2019/results/'],
  ['2020', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2020/results/'],
  ['2021', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2021/results/'],
  ['2022-s6', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2022/results/'],
  ['2022-s7', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2022-2023/results/'],
  ['2023', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2023/results/'],
  ['2024', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2024/results/'],
  ['2025', 'https://www.flashscore.com/aussie-rules/australia/afl-women-2025/results/'],
  ['2026', 'https://www.flashscore.com/aussie-rules/australia/afl-women/results/'],
];

async function expandAllMatches(page) {
  for (let i = 0; i < 25; i++) {
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter(
        b => b.textContent.trim() === 'Show more matches' && b.offsetParent !== null
      );
      if (btns.length === 0) return false;
      btns[0].click();
      return true;
    });
    if (!clicked) break;
    await page.waitForTimeout(600);
  }
}

async function extractSeasonMatches(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  await expandAllMatches(page);
  return page.evaluate(() => {
    const rows = document.querySelectorAll('div.event__match');
    return [...rows].map(row => {
      const link = row.querySelector('a.eventRowLink');
      const dateEl = row.querySelector('.event__stageTime--date, .event__time');
      const home = row.querySelector('.event__homeParticipant');
      const away = row.querySelector('.event__awayParticipant');
      const homeScore = row.querySelector('.event__score--home');
      const awayScore = row.querySelector('.event__score--away');
      const clean = t => t ? t.replace(/(Winner|Advancing to next round):.*/s, '').trim() : null;
      return {
        href: link ? link.getAttribute('href') : null,
        date: dateEl ? dateEl.textContent.trim() : null,
        homeTeam: clean(home ? home.textContent : null),
        awayTeam: clean(away ? away.textContent : null),
        homeScore: homeScore ? Number(homeScore.textContent.trim()) : null,
        awayScore: awayScore ? Number(awayScore.textContent.trim()) : null,
      };
    }).filter(r => r.href);
  });
}

function parseOverUnder(text) {
  const re = /BOOKMAKER\s*TOTAL\s*OVER\s*UNDER\s*([\d.]+)\s*([\d.]+)\s*([\d.]+)/g;
  const lines = [];
  let m;
  while ((m = re.exec(text))) lines.push({ total: Number(m[1]), over: Number(m[2]), under: Number(m[3]) });
  return lines;
}

function parseHandicap(text) {
  const re = /BOOKMAKER\s*HANDICAP\s*1\s*2\s*(-?[\d.]+)\s*([\d.]+)\s*([\d.]+)/g;
  const lines = [];
  let m;
  while ((m = re.exec(text))) lines.push({ handicap: Number(m[1]), odds1: Number(m[2]), odds2: Number(m[3]) });
  return lines;
}

async function fetchTextSafe(page, url) {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(450);
    return await page.innerText('main');
  } catch (e) {
    return '';
  }
}

async function getOddsForMatch(page, baseHref) {
  const ouUrl = baseHref.replace('/?mid=', '/odds/over-under/full-time/?mid=');
  const ahUrl = baseHref.replace('/?mid=', '/odds/asian-handicap/full-time/?mid=');
  const ouText = await fetchTextSafe(page, ouUrl);
  const overUnder = parseOverUnder(ouText);
  const ahText = await fetchTextSafe(page, ahUrl);
  const handicap = parseHandicap(ahText);
  return { overUnder, handicap };
}

function loadOut() {
  if (fs.existsSync(OUT_PATH)) return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  return {};
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  const page = await browser.newPage();
  let out = loadOut();

  for (const [season, url] of SEASON_URLS) {
    if (!out[season]) out[season] = [];
    const already = new Set(out[season].map(m => m.href));
    let matches;
    try {
      matches = await extractSeasonMatches(page, url);
    } catch (e) {
      console.log(`${season}: FAILED to load season page (${e.message}), skipping`);
      continue;
    }
    console.log(`${season}: ${matches.length} matches found, ${already.size} already done`);

    let done = 0, withData = 0;
    for (const m of matches) {
      if (already.has(m.href)) { done++; continue; }
      const odds = await getOddsForMatch(page, m.href);
      out[season].push({ ...m, ...odds });
      if (odds.overUnder.length || odds.handicap.length) withData++;
      done++;
      fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
      if (done % 10 === 0) console.log(`  ${season}: ${done}/${matches.length} (${withData} with odds so far)`);
      await page.waitForTimeout(250);
    }
    console.log(`${season}: complete — ${withData} of ${matches.length} matches had totals/handicap data`);
  }

  await browser.close();
  console.log('ALL DONE');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
