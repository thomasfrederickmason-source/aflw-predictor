> **Start here:** [MODEL.md](MODEL.md) explains how the model works, its assumptions and the evidence behind them. The weekly update is one command: `node run-round.js <round> --deploy`.

# AFLW Prediction Model

Data pipeline + (eventually) a model for predicting AFLW match outcomes —
total score, margin, and quarter-by-quarter — for betting markets.

## Data source

AFL.com.au's own match-centre backend (`api.afl.com.au` / `aflapi.afl.com.au`).
This is **not** a documented public API — it's the same undocumented backend
that powers the live scoreboard on afl.com.au, and it's what the `fitzRoy` R
package scrapes under `source = "AFL"`. No API key needed, just an open token
exchange. It could change or break without notice since it's unsupported.

Squiggle, AFL Tables, and Footywire were all checked and confirmed to have
**no AFLW coverage** — don't bother with them for this project.

### Endpoints

```
POST https://api.afl.com.au/cfs/afl/WMCTok
  headers: User-Agent: <any>, Content-Length: 0
  -> { "token": "..." }   // use as x-media-mis-token header below

GET https://aflapi.afl.com.au/afl/v2/competitions?pageSize=50
  -> AFLW competition id = 3 ("NAB AFLW"). (18/19 are preseason/exhibition — skip)

GET https://aflapi.afl.com.au/afl/v2/competitions/3/compseasons?pageSize=100
  -> one row per season, 2017–present, each with an `id` and `providerId`

GET https://aflapi.afl.com.au/afl/v2/compseasons/{compSeasonId}/rounds?pageSize=40
  -> one row per round, each with an `id` and `providerId`

GET https://api.afl.com.au/cfs/afl/matchItems/round/{round.providerId}
  headers: x-media-mis-token: <token>
  -> match list for that round, each item has `match` + `score`.
     score.homeTeamScore/awayTeamScore each have matchScore.totalScore and
     periodScore[] (4 entries, POINTS SCORED IN THAT QUARTER, not cumulative —
     verified they sum to matchScore.totalScore).
```

Two more endpoints exist in the same family (used by fitzRoy, not yet used
here): `GET /cfs/afl/matchRoster/full/{matchId}` (team lists) and
`GET /cfs/afl/playerStats/match/{matchId}` (player box score).

## Files

- `fetch-data.js` — pulls every completed AFLW match 2017–present (all
  seasons, home & away + finals) and writes `data/matches.json` /
  `data/matches.csv`. Re-run any time to refresh with the latest results —
  it's not incremental, it just re-pulls everything (726 matches as of
  2026 Round 2, takes ~1-2 min, be polite to the backend).
- `summarize.js` — quick sanity-check stats (avg score, avg margin, avg
  quarter split, era comparison).
- `market-vs-elo.js` — compares de-vig'd market-implied win probability
  against the Elo model's, overall and by season (Brier score). Re-run
  after `merge.js` changes to re-check the open question below.
- `fetch-flashscore-lines.js` — headless-browser (Playwright) scrape of
  totals/handicap odds from flashscore.com for every match 2017-2026.
  Resumable; re-run any time to pick up new completed matches (skips
  hrefs already in `data/flashscore_lines.json`).
- `merge-flashscore-lines.js` — joins `flashscore_lines.json` onto
  `matches.json` (same approach as `merge.js`), writes
  `data/matches_with_lines.json`.
- `fetch-rosters.js` — pulls AFL.com.au's `matchRoster/full` endpoint for
  every match, writes `data/rosters.json` (playing lists + ins/outs).
  Resumable; re-run to pick up newly-completed matches.
- `roster-signal-check.js` — validates the player-availability signal
  against Elo history (correlations, bucketed effect sizes), writes
  `data/roster_signal.json`. Re-run after `fetch-rosters.js` picks up new
  matches to re-check the fitted coefficient still holds.
- `roster-adjustment.js` — reusable module implementing the validated
  roster adjustment; used by `predict-round.js`.
- `travel-signal-check.js` — validates travel-distance and home/away-city
  signals against Elo history, writes `data/travel_signal.json`.
- `travel-adjustment.js` — reusable module implementing the validated
  "local derby" home-ground correction; used by `predict-round.js`.
- `venue-coords.js` — shared lat/long lookup for every venueLocation,
  used by `travel-adjustment.js`, `travel-signal-check.js`, and both
  `fetch-openmeteo-*.js` scripts.
- `fetch-weather.js` — pulls AFL.com.au's pre-match forecast text
  (`weatherType`/description) per match, writes `data/weather.json`.
  Superseded in practice by the Open-Meteo/BOM pipeline below (real
  observations beat a forecast snapshot), kept for the `description` text
  (rain vs storm vs windy framing) the others don't have.
- `weather-signal-check.js` — validates the forecast-text weather signal
  against era-detrended totals; superseded by `bom-weather-signal-check.js`
  once real BOM data was available (see README note on the era confound
  this version has).
- `fetch-bom-weather.js` — real daily rainfall/wind observations from the
  Bureau of Meteorology's anonymous FTP (their authorised alternative to
  scraping the website), writes `data/bom_weather.json`.
- `bom-weather-signal-check.js` — validates real daily BOM rain/wind
  against era-detrended score residuals, writes `data/bom_weather_signal.json`.
- `fetch-openmeteo-historical.js` — hourly historical rain/wind
  (Open-Meteo archive API, rescaled to BOM's daily total), writes
  `data/openmeteo_historical.json`.
- `fetch-openmeteo-forecast.js` — hourly weather forecast for upcoming
  fixtures, writes `data/openmeteo_forecast.json`.
- `openmeteo-signal-check.js` — validates the match-window (not daily)
  rain/wind signal, writes `data/openmeteo_signal.json`.
- `weather-adjustment.js` — reusable module implementing the validated
  match-window weather adjustment to predicted total score; used by
  `predict-round.js`.

## Data notes / caveats

- **Structural breaks — don't pool blindly across eras:**
  - 2022 had two seasons (`Season 6` in Jan–Apr, `Season 7` in Aug–Nov) as
    the comp shifted from a Feb–Apr window to fit the men's-style Aug–Nov
    slot. Both are in the data, correctly labelled.
  - 2020 season was COVID-shortened: 7 rounds + semis only, no grand final.
  - Team count grew 10 → 18 across 2017–2022 (expansion teams: GWS, WCE,
    Adelaide already in from 2017; Geelong, North Melbourne, Richmond,
    St Kilda in 2020; Essendon, Hawthorn, Port Adelaide, Sydney in 2022).
  - Format changed from split-conference to full round-robin as the
    competition grew — round/opponent counts differ season to season.
- **Scoring has trended up over time**: avg combined match score was ~70 in
  2017–19 vs ~84 in 2025–26 — quarter lengths and game style have shifted as
  the comp has matured. A model should probably weight recent seasons more
  heavily, or include season/era as a feature rather than pooling flat.
- Avg quarter split across all seasons is close to flat (Q1 9.0 / Q2 9.4 /
  Q3 9.0 / Q4 9.4 points per team-quarter) — no huge quarter-to-quarter bias
  league-wide, but worth checking per-team.
- `venue` is currently a provider code (e.g. `CD_V81`), not a name — needs
  a lookup table (`GET /afl/v2/venues`) if venue is going to be a feature.
- Team names are current nicknames (e.g. "Euro-Yroke" for the St Kilda-
  affiliated licence, "Lions", "Crows") — some have changed over the years,
  worth checking for renames when joining across seasons.

## Historical odds

`fetch-odds.js` pulls AFLW moneyline (H2H) odds from **oddsportal.com** —
avg and max closing price across ~4-5 bookmakers per team, for every match
oddsportal has listed. Confirmed AFLW is fully covered there back to 2017,
with H2H/Handicap/Totals market tabs, but this script only gets the
**moneyline** market so far (handicap/totals live on individual match pages,
not the season list, and weren't pulled).

**Coverage limitation (fetch-odds.js only):** oddsportal paginates at 50
matches/season-page, and their real pagination (an AJAX endpoint, and a
Next.js `?page=` param) both turned out to require an actual browser — a
plain HTTP fetch gets silently redirected back to page 1 either way. So
`fetch-odds.js` alone only ever gets **each season's most recent 50
matches**. This is now backfilled — see below.

**Pagination gap closed (2026-08-25) via Claude in Chrome:** with real
browser automation available, paged through every partial season
(2021, 2022 S6, 2022 S7, 2023, 2024, 2025 — the ones with >50 matches) by
clicking oddsportal's page-2/3 pagination and reading the rendered table
(`get_page_text`, not the AJAX endpoint — that still needs a signed
per-session token the browser generates client-side). Merged via the
one-off `merge-browser-supplement.js` (scratch pipe-delimited files → dedup
against `odds.json` by season+teams+day → append). Coverage per season now
matches AFL.com.au's match count almost exactly (off by at most +1, where
oddsportal has an extra fixture AFL.com.au doesn't list). `odds.json` grew
from 464 to 731 rows.

`merge.js` joins `matches.json` (full results, AFL.com.au) with `odds.json`
on normalized team name + date (±3 days tolerance) and writes
`data/matches_with_odds.json`. Join rate is now **723/726 matches (99.6%)**,
up from 429/726 (59%) — see per-season breakdown by re-running `merge.js`.
The 3 remaining unmatched are all early-2020 (COVID-shortened season)
matches oddsportal simply doesn't have odds for (closest candidate is
~370 days off — wrong season entirely, not a near-miss).

**If more seasons are added later:** the AJAX/`?page=` approaches are
still dead ends for plain HTTP; repeat the same browser-pagination approach
(navigate → click page N → `get_page_text` → parse the `Finished`/date-header
lines) rather than re-deriving the request-signing scheme. Scraping
oddsportal at all is against their ToS, worth keeping in mind before scaling
this up or relying on it for anything beyond personal research.

**Cross-checked against a second independent source (2026-08-25):**
spot-checked 3 matches from the newly-scraped seasons against
flashscore.com's odds tab (a different site, different bookmaker panel —
BetExplorer was tried first but doesn't cover Aussie Rules at all; The
Odds API's historical endpoint looked free on its pricing page but the
actual API docs say historical odds require a paid plan, so it wasn't
usable for this):
- 2021 Rd 1, St Kilda 51–42 Western Bulldogs: ours 1.72/2.10, flashscore
  1.75/2.10 (1 bookmaker) — away odds identical, home within 2%
- 2024 Play Offs Final, North Melbourne 39–9 Brisbane Lions: ours
  1.27/3.55 avg (1.30/3.66 max, 6 bookmakers), flashscore showed 2
  bookmakers at 1.30/3.60 and 1.24/3.90 — home max matches exactly, both
  within the range
- 2025 Rd 2, Essendon 31–26 West Coast: ours 1.25/3.68, flashscore
  1.30/3.60 (1 bookmaker) — within ~4% both sides

All three agree on the favourite/underdog direction and are within a few
percent — reasonable given different sites poll different bookmaker panels.
Note flashscore's own odds coverage is thin for AFLW: most regular-season
matches only had totals/handicap markets tracked, not moneyline, so a
larger systematic cross-check wasn't practical there.

**Extended to 10 more spot-checks (same day), all finals/playoffs matches**
(better flashscore coverage than regular season): 5 from 2021 (Grand Final,
both semis, both quarters), 1 from 2023 (Grand Final), 1 from 2023
(semi-final), 2 from 2024 (both semis), 1 from 2025 (Grand Final). All
matched closely — several within 1-2%, a couple with an exact odds match on
one side. **2022 (both halves, "S6" and "S7") has zero odds of any kind on
flashscore** — not just thin coverage, genuinely nothing for any of the 5
finals matches tried, moneyline or totals/handicap. Can't cross-check that
season there; the oddsportal-scraped data for 2022 stands unverified by a
second source.

**Finding: Grand Finals sometimes have home/away flipped between sites.**
Two of the ten (2021 GF Adelaide/Brisbane, 2023 GF North Melbourne/Brisbane)
looked like a mismatch at first — flashscore's "1"/"2" columns implied the
opposite favourite from ours — until re-matching by team name instead of
position, which lined both sides up closely. Plausibly because a Grand
Final's designated "home" team (higher ladder position) doesn't always
match the venue, and oddsportal vs flashscore resolve that designation
differently. Not a data error, just don't trust position/column when
cross-checking a final — match by team.

## Additional data found on flashscore.com worth considering

While cross-checking, flashscore turned out to have data that could close
two more gaps flagged elsewhere in this README:

- **Totals (over/under) and Asian handicap odds — for historical matches
  AND upcoming ones.** This is the "not reachable without a live browser"
  gap noted under Historical odds and under Live round predictions. Tested
  and confirmed: a 2025 Grand Final had 5 different bookmaker lines for
  totals (84.5–89.5) and 15 for handicap; a 2024 *regular-season* match
  with zero moneyline coverage still had a totals line (63.5, 1.88/1.88);
  and the **upcoming** Round 3 2026 fixtures already have live odds,
  including a handicap line (e.g. North Melbourne −39.5 vs Western
  Bulldogs, 1.91/1.91) — something oddsportal's landing page flatly
  doesn't expose pre-match. Coverage caveat: same 2022 blackout as above —
  don't expect this to fill the 2022 gap specifically.
- **Full 2026 fixture list through Round 12** (`/aussie-rules/australia/afl-women/fixtures/`)
  — further out than the single round `predict-round.js` currently pulls.
- **H2H tab** (recent form + head-to-head history) — skippable, it's fully
  derivable from `matches.json` already.
- **Lineups tab** (starting 16 + subs, by name and number, confirmed on a
  finished match) — real, but redundant: AFL.com.au's own
  `matchRoster/full/{matchId}` endpoint (documented above, never called)
  is the better source for this — same publisher as the main data, no
  scraping, likely has player IDs rather than just names. Use that instead
  if/when player-availability features get built.

**Bottom line:** if handicap/totals markets end up mattering (line/total
betting, not just moneyline), flashscore is the practical route — both
backfilling finals-era history and for live upcoming-round lines — via the
same browser-pagination approach used above, per-match rather than
per-season-page.

## Totals/handicap backfill (2026-08-25) — `fetch-flashscore-lines.js`

Pulled the finding above through to completion: scraped over/under and
Asian handicap odds for every match, 2017–2026.

**Why a script instead of more manual browser calls:** doing this
one-match-at-a-time through Claude in Chrome would have meant thousands of
tool round-trips. Checked whether flashscore's data could be hit directly —
found their internal feed (`global.flashscore.ninja/2/x/feed/...`, and a
`pq_graphql` endpoint) requires a signed `x-fsign` header computed by
obfuscated JS; a direct fetch with a guessed header got a 401. Didn't
pursue cracking that (deliberately bypassing signed anti-scraping auth is a
different thing from reading rendered pages, and not something to do on
someone else's site). Instead wrote `fetch-flashscore-lines.js`, a
**headless-browser script** (Playwright, driving the user's own installed
Chrome via `executablePath` — no separate Chromium download) that does
exactly what the manual browser session did: load each season's results
page, click "Show more matches" until everything's expanded, collect every
match link via flashscore's stable `.event__match` / `.eventRowLink` DOM
classes, then visit each match's `/odds/over-under/full-time/` and
`/odds/asian-handicap/full-time/` pages and parse the bookmaker rows.
Resumable by design (flushes `data/flashscore_lines.json` after every
match, skips hrefs already recorded) — needed that twice: once when a
`| head -5` in an unrelated smoke-test command accidentally SIGPIPE'd the
first run, and once when the background task got killed mid-2021 for
unclear reasons. Both times it picked up exactly where it left off.

**Result: 724 of 726 matches attempted (2 not found on flashscore), 57
matches (7.9%) actually had totals and/or handicap odds:**

| Season | Matches | With lines data |
|---|---|---|
| 2017 | 29 | 3 |
| 2018 | 29 | 8 |
| 2019 | 38 | 3 |
| 2020 | 46 | 5 |
| 2021 | 68 | 13 |
| 2022 S6 | 75 | 0 |
| 2022 S7 | 99 | 0 |
| 2023 | 99 | 3 |
| 2024 | 106 | 10 |
| 2025 | 117 | 12 |
| 2026 (so far) | 18 | 0 |

**This low hit rate is a real coverage characteristic, not a scraper bug —
verified before trusting it.** Spot-checked a 2024 match with an empty
result (North Melbourne's Grand Final, moneyline-only) against one with
data (North Melbourne 78–21 Port Adelaide, a blowout) — the latter came
back with a rich 37-line handicap ladder (-11.5 to -48.5), proving the
parser works correctly whenever a bookmaker actually posted these markets.
Apparently only a subset of matches get totals/handicap coverage at all —
plausibly lopsided/notable games are more likely to get a line posted.
2022 (both halves) confirms the earlier moneyline finding: literally zero
odds of any kind on flashscore for that year.

`merge-flashscore-lines.js` joins this onto `matches.json` the same way
`merge.js` joins the oddsportal data — unordered team pair + closest date,
with the Grand-Final home/away swap issue (see above) handled by aligning
on scores rather than trusting either site's home/away label. Writes
`data/matches_with_lines.json`. Final join: **57/726 matches (7.9%) have
`overUnder` and/or `handicap` arrays populated** (30 with totals, 32 with
handicap, some matches have both) — everyone else gets empty arrays, which
is the honest answer given the source data, not a join failure.

**Take-away for later use:** this dataset is real but sparse — useful for
a handful of case studies (e.g. cross-checking the model's predicted
margin against a bookmaker's actual handicap line on a specific big
mismatch), not for a systematic backtest of a totals/line strategy the way
the moneyline data now supports. If deeper handicap/totals history is
ever needed, The Odds API's paid historical tier (back to June 2020,
depth for AFLW specifically unconfirmed — see above) is the more complete
alternative.

## Model (v1: Elo)

`elo-model.js` runs a standard Elo rating system chronologically over
`data/matches.json`, with a margin-of-victory multiplier (bigger blowouts
move ratings more), a fitted home-ground advantage, and per-season
regression toward the league mean (new teams enter at the current league
average, not the global baseline, since they're joining an established
comp). Outputs `data/elo_ratings.json` (current team strength) and
`data/elo_history.json` (every match's pre-match rating + model win prob,
for backtesting).

Also fits a simple linear margin model (`margin ≈ slope * eloDiff +
intercept`) and reports the current combined-score baseline by era.

**Two real data bugs found and fixed while building this** — both were
AFL.com.au silently changing a club's nickname field mid-history, which
split one team into two identities in the raw data:
- West Coast: "West Coast Eagles" (2020-21) vs "Eagles" (2022+)
- Fremantle: "Freo" (2017-2025) vs "Dockers" (2026)

Fixed via a canonical-name map in `fetch-data.js` (`TEAM_NAME_FIXES`) and a
matching fix in `merge.js`'s odds-join normalizer. This also fixed a chunk
of odds mismatches — West Coast's post-2022 matches were silently failing
to join with oddsportal data because of the name split. Odds join rate went
from 429/726 to **456/726 (62.8%)** after the fix. **If you add more seasons
or notice a team's win/loss record looks wrong, check for this pattern
first** — grep `data/matches.json` for a club's short vs long name.

**Open question — re-checked 2026-08-25 with full coverage, still
unresolved but the earlier read holds up:** market-implied win probabilities
(from oddsportal's avgOdds, de-vig'd) calibrate *worse* than the Elo model,
now checked on **714 overlapping matches** (up from 447): Brier 0.229 vs
0.192 (`market-vs-elo.js`, run any time `matches_with_odds.json` changes).
The gap isn't a small-sample artifact — Elo beats the market in 9 of 11
seasons individually. One data point did shift with more coverage:
short-priced favourites ($1.15 or shorter, de-vig'd implied prob ≥87%) won
**76.7%** of the time (n=116) — well below 87% still, but nowhere near as
alarming as the original 61% read on a much smaller sample, which was
plausibly just small-sample noise. Two live hypotheses, still unresolved:
(1) AFLW moneyline markets are genuinely a thin, less-sharp market that
real bookmakers don't price as tightly as AFL men's or bigger sports — which,
if true, is actually a promising sign for finding an edge; or (2) oddsportal's
`avgOdds`/`maxOdds` fields aren't pure closing-line prices (could be
time-averaged across the whole market including a stale opening line) —
which would make them less sharp than true closing odds without there
being any real market inefficiency. **Don't build a staking strategy off
"beating the market Brier score" until this is nailed down** — the
cleanest way to test it is to compare against a LIVE match's odds captured
close to bounce-down for a round or two, rather than the historical archive.

## Model tuning (`tune-elo.js`)

Grid-searched K-factor, home-ground advantage, and season-regression
strength against Brier score. Result: **K=40** (v1 guessed 24 — AFLW results
are volatile enough that ratings need to move faster per match than a
typical Elo setup), **HGA=15** (v1 guessed 30, and it turns out barely
matters — see finding below), **regression=1/3** (v1's guess was already
right). Improved aggregate Brier from 0.195 to 0.192, favourite-hit-rate
70.0%. Caveat: this was tuned in-sample (same 726 matches used to score it)
— fine for a first pass, but worth re-validating once there's live
prediction history to check out-of-sample.

**Finding: AFLW home-ground advantage is real but weak.** Checked directly:
52.9% home win rate, +2.1 point average home margin (recent era 2024+:
51.9%, +2.6). That's much weaker than AFL men's typical ~57-60% home win
rate — explains why the HGA parameter barely moved the model's calibration
in tuning. Don't assume men's-AFL home-advantage intuitions carry over.

## Score model (`score-model.js`) — attack/defense ratings for totals/line markets

Win probability alone doesn't answer total-score or line markets, so this
is a separate attack/defense rating per team (1.0 = league average scoring
output/against), updated with an EMA after each match, multiplicative
(`predicted score = league-avg × scorer's attack × conceder's defense`).
Beats a naive "always predict the league average" baseline on total-score
MAE (16.6 vs 18.0 points). Kangaroos are dominant on **both** sides of the
ball (attack 1.70, defense 0.52) — explains why they're Elo's clear #1.

Also profiles each team's **quarter-by-quarter** scoring (current era,
2024+) — league-wide the quarter split is close to flat, but individual
teams vary a lot: Kangaroos are dominant start-to-finish (Q1 16.6 → Q4
15.7), Demons fade late (Q1 13.9 → Q4 10.4), Lions get *stronger* as the
match goes (Q1 11.3 → Q4 14.0), Magpies have an odd Q3 dip (4.3, half their
other quarters) worth another look once more data comes in (n=25, could be
partly noise). Full table in the script's output — worth checking before
betting a specific-quarter market on any one team.

## Calibration report (`calibration-report.js`)

Two things a single Brier number hides:

**By season** — Brier improves sharply as the model accumulates data
(2017: 0.226 → 2022 Season 6: 0.146), dips again in 2023 (0.213, plausibly
the competition re-leveling after the 2022 expansion to 18 teams), then
settles around 0.17-0.19 for 2024-2026 (current era: n=243, Brier=0.186,
73.3% favourite-hit-rate) — a reasonable, believable range, not
suspiciously good.

**By confidence bucket (reliability)** — this is the most reassuring
result so far: when the model says "80-90% win probability," the favoured
team actually won 84.4% of the time (model said 85.1% — a 0.7pp gap). Every
bucket from 0-100% tracks the model's stated probability within ~7
percentage points, with no bucket off by more than that. That's a
genuinely well-calibrated model, not just a model that happens to pick a
lot of winners. Full bucket table in the script output.

## Live round predictions (`predict-round.js`)

Pulls the upcoming round's fixture + live moneyline odds from oddsportal's
league landing page (odds for scheduled matches live in a separate
`initialOddsMap` structure keyed by an event hash, not embedded per-row like
the results archive — and unlike the archive, `resultId` is a placeholder
`0` for both outcomes pre-match, so home/away has to be read by array order
instead: `odds[0]` = home, `odds[1]` = away, verified against known team
strength). Combines the Elo win-probability model with the attack/defense
score model to output a full prediction per match — win%, predicted score,
margin, total — set directly against the live market price with an edge
calculation, and saves a timestamped snapshot (`data/round3_2026_prediction_snapshot.json`)
with empty `actualHomeScore`/`actualAwayScore` fields to fill in once the
round's played — **that comparison is the real out-of-sample test the
historical backtest can't give us**, since backtesting a model against the
same data it learned from always looks better than reality.

Round 3 (29-30 Aug 2026) predictions are already captured. Two of the nine
had a double-digit-percentage gap against market pricing — Gold Coast Suns
vs Geelong Cats (market has Cats at 80%, model says 70%, +14.2pp gap) and
GWS Giants vs Port Adelaide (market has Power at 81%, model says 72%,
+9-14pp range across the two calcs) — worth a manual sanity check against
team news before reading too much into either, since a two-match sample of
"biggest gaps" isn't evidence of anything on its own.

**Handicap/totals odds for upcoming matches** — not embedded on oddsportal's
landing/h2h pages without a live browser (checked, no `bettingTypeId` 4/5
there). flashscore does carry this for upcoming fixtures (confirmed
2026-08-25 — see the totals/handicap backfill section below, e.g. found a
live -39.5 handicap line for an upcoming Round 3 match), but
`fetch-flashscore-lines.js` as built only covers *completed* matches
(joined against `matches.json`, which by definition doesn't have unplayed
games). Pulling upcoming-round lines would need a small variant of that
script pointed at the `/fixtures/` page instead of `/results/` — not done
yet, since `predict-round.js`'s once-off landing-page scrape already covers
moneyline for the round that matters right now.

## Next steps

- **Validate Round 3 predictions against the actual result** once played
  (29-30 Aug 2026) — fill in `actualHomeScore`/`actualAwayScore` in
  `data/round3_2026_prediction_snapshot.json` and check the model's stated
  probabilities against what happened. Repeat for a few more rounds before
  trusting the model's edge numbers with real money.
- Get handicap/totals odds (not just moneyline) for a real line/total-market
  comparison, not just win probability — needs a live browser per the
  finding above.
- ~~Pull team rosters / player availability~~ — **done 2026-08-25**, see
  below.
- ~~Travel/interstate distance as a feature~~ — **done 2026-08-25**, see
  below (turned into a home-ground-advantage refinement, not a distance
  feature — the distance version didn't validate).
- Re-tune Elo hyperparameters out-of-sample once there's enough live
  prediction history — the current K=40/HGA=15/regression=1/3 was fit on
  the same historical data it's scored against.
- Re-run `predict-round.js` closer to game day once team sheets are
  published, to pick up the roster adjustment below for the actual
  upcoming round (it was a no-op for Round 3 as captured, since AFL.com.au
  hadn't named teams yet 4-5 days out).

## Player availability / roster adjustment (2026-08-25)

**`fetch-rosters.js`** pulls the same AFL.com.au backend as `fetch-data.js`,
hitting the previously-unused `matchRoster/full/{matchId}` endpoint for
every match. Full success: **726/726 matches, 0 failures.** Gives, per
team per match: the full playing list (position, player, jumper number,
captain), and — the useful part — AFL.com.au's own pre-computed `ins`/`outs`
versus that team's previous match, each with a `reason`: `Injured`,
`Illness`, `Suspension`, `Personal Reason`, `Managed` (planned rest), or
`Omitted` (dropped, not injured). No need to diff rosters ourselves.

**Validated before building anything on top of it** (`roster-signal-check.js`)
— tracked each player's career games-played as of each match (a proxy for
being an established/important player), summed it across a team's `outs`
for a match ("outs-importance"), and checked whether the net advantage
this creates actually predicts anything, against 726 matches of Elo
history:

- Raw signal (all outs including `Managed`): weak, correlation ~0.06-0.07
  with margin/win-prob surprise.
- **`Managed` (planned rest) turned out to be a confound** — a team doesn't
  need its rested-not-injured star to still win, so resting one is more
  common when already a heavy favourite, which dilutes/reverses the real
  effect. Excluding it (leaving only genuinely unplanned outs — injury,
  illness, suspension, personal reason) cleaned the signal up: correlation
  with margin rose to ~0.10, and it became **monotonic across buckets** —
  home teams with a large unplanned-outs disadvantage averaged **-1.3**
  margin (below the +2.1 league-wide baseline), teams with a large
  advantage averaged **+10.2**.
- Fitted: `margin ≈ 0.087 × netOutsAdvantageUnplanned + 2.24`, where
  `netOutsAdvantageUnplanned` is (away team's departed players' summed
  career games) minus (home team's). E.g. an unplanned 50-game veteran
  missing on one side, nothing missing on the other, is worth roughly
  4-5 points of margin — real, but a nudge, not a headline feature. r≈0.10
  means this explains only a small slice of match variance on its own,
  consistent with one missing player out of 22 mattering but not
  dominating.

**`roster-adjustment.js`** is the reusable module (`getRosterAdjustment`,
`buildCareerGamesPlayed`) implementing the validated (unplanned-outs-only)
version, wired into **`predict-round.js`**: it looks up each upcoming
fixture's `matchId`, checks whether AFL.com.au has published a team sheet
yet, and if so shifts the effective Elo diff (and therefore both the win
probability and predicted margin, consistently, via the same
`MARGIN_SLOPE` relationship the model already uses) by the fitted amount.

**Practical limit, confirmed by testing against Round 3 2026 (4-5 days
out at the time):** team sheets aren't published until ~1-2 days before a
match — `matchRoster` returns `status: "SCHEDULED"` with empty
`ins`/`outs`/`positions` before then. So this can't inform predictions
made far ahead; it only activates on a re-run once teams are actually
named, which `predict-round.js` handles by silently skipping the
adjustment (same prediction as before) rather than erroring.

## Match-window weather (2026-08-25)

Followed up the daily-total weather finding above with real hour-by-hour
data, prompted by a fair question: does rain hours before or after a match
actually matter, or only rain during it?

**Historical**: `fetch-openmeteo-historical.js` pulls hourly precipitation
and wind from Open-Meteo's free archive API (no key, explicitly built for
reuse) for every match, 2017-2026. Open-Meteo is a reanalysis/model
product, not a station observation, and cross-checking against BOM's real
daily total showed it under-estimates intense localised rain (28mm
modelled vs 53.4mm BOM-observed for one known storm match) — so the
approach keeps **BOM's daily total as the authoritative rain amount** and
uses Open-Meteo's hourly *shape*, rescaled to match that total, to decide
*when* within the day it fell. Match window = kickoff to kickoff+2h
(covers an AFLW game including breaks); pre-match = kickoff-2h to kickoff.
About a third of matches had an unreliable rescale (Open-Meteo's modelled
shape for the day barely resembled BOM's reality) — those are excluded
from the validated numbers below (`openmeteo-signal-check.js`, n=477
"reliable" matches).

**Isolating the match window roughly doubled the signal** found from daily
totals: rain-during-match vs score residual **r=-0.154** (was -0.068
daily), wind-during-match **r=-0.177** (was -0.075 daily). Bucketed: no
rain during the match (n=444) averages **+0.8** residual; any rain during
the match, even light (n=33) averages **-9.5** — a real, if modest, effect.
Tried to isolate "rained beforehand but dry by kickoff" as its own case
(ground wet, air clear) but came up with zero qualifying matches in the
reliable set — rain heavy enough to register pre-match essentially always
continued into the match window too; couldn't cleanly separate the two.

One match makes the case for the refinement concretely: **GIANTS v SUNS
(2020-02-08)** was the single most weather-suppressed score on record (17
points, -48 residual) under BOM's daily figure of 53.4mm — but its
*during-match* rain was only 1.82mm; most of that day's rain fell outside
the 2-hour window. What *was* extreme during the match: 29.8 km/h wind.
The daily total would have blamed the wrong thing.

**Coefficient fitting — deliberately not a naive linear one.** A first
multivariate fit gave -10.4 points per mm of rain, which only makes sense
within the data it was fit on: during-match rain tops out at 2.85mm in the
reliable set (rain heavy enough to still be falling in a specific 2-hour
window, on a day whose total BOM and the model agree on, is rare), so a
per-mm slope extrapolated to a hypothetical 5mm+ match predicts an absurd
near-zero score. Rain is instead modelled as a **fixed step** (any
measurable rain during the match: -9.5 total-score points, split evenly
between both teams — no home/away directional effect was found, weather
hits both sides evenly), using the robust none-vs-any comparison rather
than extrapolating a slope past what was actually observed. Wind, which
*does* have a well-populated, roughly linear range (1.4-42 km/h, n=477),
is applied as a continuous slope (-0.517 pts per km/h) centred on the
dataset's own mean wind (15.7 km/h) — zero adjustment at a typical match's
conditions, moving away from there in either direction.

**Forecast, for live predictions**: `fetch-openmeteo-forecast.js` pulls the
same pre/during-match breakdown from Open-Meteo's forecast API (hourly,
16-day range, no rescaling needed since there's no "real" total yet to
correct against) for whatever's in `data/upcoming_round_odds.json`. Wired
into `predict-round.js` via `weather-adjustment.js`, adjusting predicted
total score (split evenly across both teams) — confirmed working against
Round 3 2026: no rain forecast anywhere in the round, but wind varied
enough to matter (Bombers v Richmond in calm Darwin, 3km/h: +6.5pts;
SUNS v Cats in breezier Gold Coast, 18km/h: -0.9pts), a clean
demonstration the pipeline responds to real variation even without rain.

## Travel / home-ground advantage (2026-08-25)

Started as "does travel distance predict anything" (`travel-signal-check.js`,
same validate-before-building approach as the roster feature). First fixed
a data gap: 57 of 726 matches had no resolved venue name (9 venue codes
missing from the AFL.com.au venues list previously fetched) — pulled those
directly from the `matchRoster` response's `venue` object (which carries
name/city/state per match, keyed by the exact venue code matches.json
already uses) rather than guessing through venue-list pagination. Venue
resolution is now **726/726 (100%)**.

**Continuous travel distance didn't validate** — computed each team's
"home city" data-driven (mode of `venueLocation` among their home matches,
not hardcoded) and the great-circle distance from each side to the match
venue, then checked correlation against Elo history: r≈0.01-0.04,
non-monotonic across distance buckets. Plausible reason: AFLW's 18 teams
are spread across a huge continent, so most away trips are already large
interstate distances — the km scale doesn't discriminate much once travel
is happening at all.

**A binary reframing did validate, and it's a more interesting finding
than "travel hurts":** split matches by whether each side is playing near
its own derived home city (within 100km) and compared to **Elo's own
win-probability expectation** (which already includes the model's flat
HGA=15 applied to every match) rather than raw margin, to control for team
strength:
- **True home game** (home local, away travelled) — n=439 (60%): actual
  results beat Elo's expectation by +3.1pp on average.
- **"Local derby"** (both teams local to the venue — e.g. two Melbourne
  clubs at a Melbourne ground) — n=219 (30%): actual results *undershoot*
  Elo's expectation by -5.1pp, despite the model still applying the full
  home-ground boost.
- Neutral-venue games (both travelled) — n=63, small sample, +3.0pp raw
  margin but noisy.

Read together: **home-ground advantage in this data looks like it's
almost entirely an away-team-travel effect, not a home-crowd effect** —
when neither team has to travel, the "designated home" team gets no real
benefit, even though the model currently credits them one anyway.

**Adjustment implemented** (`travel-adjustment.js`, wired into
`predict-round.js` next to the roster one): conservative and one-directional
— zero out the flat HGA=15 boost specifically for "local derby" fixtures
(the well-supported case), leave true-home and neutral-venue games at the
model's existing flat HGA (smaller samples, less confident tuning those
further). Confirmed working against Round 3 2026: **Magpies vs Hawks at
Victoria Park** (both Melbourne-based) correctly triggered the adjustment
— Magpies' home win probability dropped from 14% to 13% and predicted
margin from -26 to -28 once the unearned home-ground credit was removed.
Every other Round 3 fixture has a genuinely travelling away team, so it
didn't fire elsewhere.
