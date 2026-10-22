# How the AFLW model works

Fair (no-margin) odds for every AFLW match, published on Fairline:
https://fairline.thomasfrederickmason.workers.dev

## Weekly run: one command

```
node run-round.js <round> --deploy
```

It pulls the results, refits everything, prices the games still to be played, checks that every market agrees, then publishes and deploys. It stops at the first failure, and nothing is published unless every step passes. Leave out `--deploy` to preview without publishing, or leave out `<round>` to price the next round with games left.

## A prediction, step by step

For each match the model produces **one** set of numbers: a win chance, a margin, a total, and the two teams' scores. Every market is priced from that same set, so the predicted score, head-to-head, line, totals and team totals can't contradict each other. A gate at the end of `betting-odds-model.js` fails the run if they ever do.

| Step | What | Source |
|---|---|---|
| 1 | **Elo**: team strength from every result since 2017, updated one game at a time. Margin-of-victory weighted, K=40, home ground worth 15 Elo points, a third of the gap to the mean regressed each new season. Gives a win probability. | `elo-model.js` → `data/elo_params.json` |
| 2 | **Scoring model**: each team's attack and defence (points scored and conceded relative to the league average, weighting recent games most). Gives each side's expected points. The **total** is the average of this model's total and a ridge total (step 3), then match conditions. | `score-model.js` |
| 3 | **Ridge rating** (added 2026-10-02): before each round, every team's rating is refitted to *all* its recent margins at once. Predicted margin = rating(home) − rating(away) + home advantage. Recent rounds count most (decay over ~40 rounds), last season counts 20%, and a light ridge pulls thin-data teams to average. Unlike Elo, one upset doesn't swing it. It is fitted to a **75/25 mix of the scoring-shots margin (goals + behinds, × 3.37 points per shot) and the points margin**, because kicking accuracy is mostly luck. The settings (including that 75%) are re-tuned on earlier seasons whenever a new season starts. | `ridge-model.js` → `data/ridge_ratings.json` |
| 4 | **Lineup strength** (added 2026-10-02): each player's value = her recent fantasy points per game (half-life 20 games, shrunk toward a newcomer's ~34). A named lineup's strength minus the team's usual strength (weighted over its previous lineups) is the news; the ratings already know the usual team. Only used once the final 21 is named. | `player-value.js` (data: `fetch-player-stats.js` → `data/player_stats.json`) |
| 5 | **Win chance** = the average of (a) Elo's probability and (b) a margin blend, currently `1.53 + 0.18 × scoring-model margin + 0.85 × ridge margin + 0.13 × lineup difference` (refitted weekly). The lineup term shifts the Elo half by the same number of points. | `backtest-model.js` → `data/model_params.json` |
| 6 | **Margin** = the centre of a normal distribution (spread ~25 points, refitted weekly) with P(margin > 0) exactly that win chance. The win chance is an expected score (a draw counts half), so this is also the fair head-to-head under dead-heat rules. **Scores** = (total ± margin) / 2. | same |

Adjustments, all validated on history:

- **Team news:** each career game of a player who's *unavailable* (injured, ill, suspended, personal reason) is worth 0.064 points to the other side. Players dropped for form ("Omitted") and planned rests ("Managed") don't count; they're selection choices, not lost strength. (`roster-adjustment.js`, `roster-backtest.js`)
- **Travel:** a local derby, with both teams within reach of the venue, gets no home-ground advantage. (`travel-adjustment.js`)
- **Match conditions** (since 2026-10-17): wind, the forecast *chance* of rain and kickoff time move the total. The coefficients are fitted on the model's own total error since 2019 and refitted weekly; each term is centred on its mean. Currently wind −0.54 pts per km/h, rain −11.9, and −3.3 pts per 3 hours later kickoff (night games score less). (`conditions-model.js`, `weather-adjustment.js`)

## Evidence: walk-forward backtest

Every test below predicts each season using only earlier seasons, the same way the model is used live.

**Second round of improvements (2026-10-02 afternoon; `shots-candidates.js`, `improvement-candidates.js`).** Six ideas, each tested this way and dropped unless it won:

| Win chance, 2024–26 (289 matches), live structure incl. derby rule + team news | Brier ↓ | Log loss ↓ |
|---|---|---|
| Elo alone | 0.1812 | 0.5428 |
| Model as of this morning | 0.1735 | 0.5209 |
| **+ scoring shots in the ridge rating + lineup strength (now live)** | **0.1666** | **0.5097** |

By season (lineup step): 2024 0.1569 vs 0.1655, 2025 0.1795 vs 0.1816, 2026 0.1593 vs 0.1719.

- **Kept: scoring shots.** Ridge on 75% shots / 25% points: Brier 0.1773 vs 0.1785 (ridge-blend comparison), better in all three seasons, and any shots share from 25% to 100% beat points only. For the **total** it made no difference (MAE 17.33 vs 17.31), so totals stay on points.
- **Kept: lineup strength from fantasy points** (#5 and #6 in one). Better in every season 2024–26 and in 7 of 8 since 2019. In rounds 1–3 only (2019–26, 229 games), where it captures off-season list changes, Brier 0.1676 vs 0.1724. Not tuned: all 18 combinations of half-life (10/20/40 games), team decay (0.7/0.85/0.95) and newcomer prior (2/8 games) scored 0.169–0.171 vs 0.1747 without it. Career-games team news still adds a little on top (0.1666 vs 0.1679 without it), so both stay.
- **Rejected: margin spread varying by game.** A spread growing with the predicted total gained 0.003 log-likelihood per match (noise); varying with the mismatch made it worse. Total spread growing with the total: worse. One spread stays.
- **Rejected: travel distance, interstate flags, days' rest, short breaks, and the derby as a fitted term.** None beat the live model (best: short-break flag 0.1745 vs 0.1747, worse in 2026). The **heavy away favourite** shortfall shrinks to 1.8–2.5 points (SE 3.0) once lineups are in, so it's no longer distinguishable from noise.
- **Started: closing prices.** Fairline now saves Sportsbet and Betfair prices (first seen, and the last within 90 minutes of the bounce) with the model's price at the time: `GET /api/closing-prices`, scored against results by `node market-record.js`. That's the real test of an edge; the backtest isn't.

**The ridge rating (2026-10-02, `rating-candidates.js`).** This is the strictest test the model has had. For each test season, the ridge settings were tuned only on earlier seasons, and the blend refitted only on earlier seasons, then scored on that season.

| Win probability (2024–26, 289 matches) | Brier ↓ | Log loss ↓ |
|---|---|---|
| Elo alone | 0.1812 | 0.5428 |
| Average of Elo and an Elo + scoring blend (live until 2026-10-02) | 0.1805 | 0.5398 |
| Average of Elo and an Elo + scoring + ridge blend | 0.1790 | 0.5350 |
| **Average of Elo and a scoring + ridge blend (now live)** | **0.1785** | **0.5330** |

By season it was better in 2024 (0.1730 vs 0.1735) and 2025 (0.1855 vs 0.1902), and level in 2026 so far (0.1749 vs 0.1744, 64 matches). It is calibrated: predicted vs actual home-win rate by decile, χ² 6.98 (pass < 18.3).

Checked and rejected the same day:
- **A calibration layer** (re-scaling probabilities, fitted on earlier seasons) made it worse: Brier 0.1802 vs 0.1784.
- **Re-weighting Elo vs the blend** (picked on earlier seasons) chose 20% Elo and did worse than 50/50 (0.1796 vs 0.1784). 50/50 is also best in hindsight.

**Before that (2026-09-25):** the average of Elo and an Elo + scoring blend beat Elo alone in 4 of 5 seasons (2022–25). That's why the win chance averages two views: it stops either one's blind spot from running away with a price.

**Live record, predictions made before each game (rounds 3–7, 2026, 41 games):** 31/41 winners tipped, Brier 0.175, margin error 15.3 points, totals unbiased (90.0 predicted vs 89.4 actual). Where bookmaker odds were captured (rounds 3–4, 18 games), it was level with the market: Brier 0.133 vs 0.134. Snapshots are in `data/round*_2026_prediction_snapshot.json`.

| Margin spread | Calibration test (χ², pass < 16.9) |
|---|---|
| 24.9 points (old; slightly too narrow, too many results out in the tails) | 10.91 |
| **25.75 points (now; best likelihood)** | **4.38** (6.19 re-measured with the ridge blend, 2026-10-02) |

| Team news (2019–26, 707 matches) | Margin error | Brier |
|---|---|---|
| No adjustment | 19.569 | 0.1846 |
| Old version (counted "Omitted" players, slope 0.087) | 19.526 | 0.1848 (worse) |
| **Unavailable players only (slope refitted to 0.064; now live)** | **19.514** | **0.1841** |

Team scores centred on (total ± margin)/2 are slightly *more* accurate than the scoring model's own split (MAE 12.85 vs 12.97), as well as consistent with the line.

## Assumptions, stated plainly

1. The margin follows a normal distribution around the model's margin (spread re-measured weekly on 2024+ matches). Team scores and match totals are skew-normal (fatter right tail: blowouts happen, scores can't go below 0).
2. Only 2024+ matches set the spreads. The competition changed a lot (8 → 18 teams, scoring up from ~70 to ~86 a game), so older seasons would understate how spread out results are now.
3. The total is the average of the scoring model's total and the ridge total; the match-conditions adjustment is added once, after averaging. Elo only says who wins, not how many points get scored. The 1st-half and 1st-quarter markets scale the scoring model's split to that total.
4. A player's worth is her recent fantasy points per game. Fantasy points over-reward ball-winners and under-reward defenders and rucks a little, but they're the only per-player measure the AFL's AFLW data has (Champion Data's rating points are empty). The historical team sheets are the final teams, so late changes after naming are not modelled. Separately, unavailable players' career games still count (team news).
5. First-half and first-quarter prices use each team's quarter-by-quarter scoring profile, shifted by the full-game correction (their own backtest is in `betting-odds-model.js`).
6. The market is not an input. Fairline compares to live bookmaker prices only after the fact, to show where the market pays more than fair. Sportsbet, Betfair and Ladbrokes are fetched directly; 13 more books come from EdgeFinder.
7. Head to head is two-way with dead-heat rules, the way Australian bookmakers settle AFL: fair = 1 / win chance, and a draw pays half. The three-way price, with the draw on its own, is in `result3`.

## Known limits

- The model values players only through fantasy points and has no coaching or tactical news. Before the final 21 is named (it's an extended squad early in the week), there's no lineup adjustment, so re-run once teams are final for the sharpest prices.
- Elo reacts hard to upsets (e.g. the Kangaroos −89 after losing to the Hawks in Round 6). K=40 was the Brier-optimal choice, but that means it responds quickly to the latest result. Since 2026-10-02 the ridge rating balances this in the other half of the average.
- **Watch item: heavy away favourites.** In 2024–26, home teams given under 20% won 21–23% of the time (about 42 games). Away teams favoured by 15+ points underperformed by about 4 points, roughly 1.7 standard errors. Both the old and new models do it. A calibration layer fitted on earlier seasons didn't fix it, because earlier seasons don't show it. Travel, rest and the derby rule don't explain it (tested 2026-10-02). With lineup strength in, the shortfall is 1.8–2.5 points (SE 3.0), but the lowest decile still predicts 6.8% home wins vs 12.7% actual. Revisit once 2026 finishes.
- The historical "model beats market" comparison (`elo-model.js`) uses oddsportal's average odds, which may not be closing prices. Don't treat it as proof of an edge.

## Changed 2026-10-17 (peer review: `REVIEW-2026-10-17.md`)

- **The weather adjustment became a conditions model.** The old constants were fitted on raw totals, in-sample, and double-counted what the ratings already knew: with archived weather they made 2024–26 totals worse. `conditions-model.js` refits wind, rain and **kickoff time** on the model's own error. Walk-forward RMSE 22.19 vs 22.30 on 2024–26, level on 2022–26, and the night-game shortfall is cut from −6.6 to −5.0. Rain now uses the forecast chance of rain, and forecast wind is shrunk 20% toward the mean.
- **The expected-score convention.** The margin is solved from P(margin > 0) = win chance, not P(margin > 0.5). That had put every margin 0.5 pts toward home. Full-game head to head is two-way with dead heat, matching the bookmakers. Walk-forward Brier 0.1663 vs 0.1664.
- **Elo moves on a draw**, counted like a one-point game.
- The **H1/Q1 total spreads** are refitted weekly (they were frozen at 12.87 / 9.18; now 13.47 / 9.37).
- **Finals** are named on the board (round names from the AFL API, via a `board-meta` block).
- **Checked and kept:** the team-news + lineup combination (a joint fit was worse out of sample), the 50/50 total blend, and the blend's spread. "Totals run 3 high" was noise from round 8.

## Changed 2026-10-02

- **Added the ridge rating** (step 3 above) and switched the blend from Elo + scoring to scoring + ridge, on the evidence above. `run-round.js` runs `ridge-model.js` after the scoring model.
- **Totals: averaged with a ridge total.** `ridge-model.js` also fits additive ridge ratings to points scored: level + attack(team) − defence(opponent) + home edge, with the same decay idea and its own settings (decay 80 rounds, last season 10%, ridge 16, tuned on earlier seasons). Nested walk-forward (`total-candidates.js`): total MAE on 2024–26 was 17.31 for the average vs 17.89 for the scoring model, better in every season (2024 16.65 vs 17.40; 2025 15.85 vs 16.09; 2026 21.12 vs 22.00). It also predicts 1st-half totals (10.71 vs 10.87) and 1st-quarter totals (7.57 vs 7.65) better, so those markets scale with it. The total spread dropped from 22.88 to 22.41 points, with no bias (−0.06). The ridge total is more conservative on mismatches: the scoring model multiplies attack × defence, which runs extreme for lopsided games.
- **The round auto-pick skipped part-played rounds.** With no round given, `fetch-upcoming-round.js` took the first round with *no completed game*. On Friday of round 8, with Thursday's opener done, it jumped to round 9. It now takes the first round with a game still to play.

## Fixed 2026-09-25

- **Team totals and predicted scores contradicted the line.** They came from the scoring model's raw split while the line used Elo (e.g. "Demons 32.9 – 52.2 Kangaroos" next to Kangaroos −1.5). They now come from the one coherent prediction.
- **The team-news adjustment was silently zero on every live prediction.** The live team sheet nests the player ID (`out.player.playerId`), and the code only read `out.playerId`.
- **Hand-copied constants had gone stale:** the Elo margin intercept (0.21 vs the fitted 0.37), and home-ground advantage copied into two files. All tuned numbers are now written by the script that fits them and read from `data/elo_params.json` / `data/model_params.json`.
- **Roster history had stopped updating in August** (`fetch-rosters.js` wasn't in the weekly routine). It is now step 3 of `run-round.js`.
- **A mid-round run priced games that had already started.** `fetch-upcoming-round.js` now skips concluded and live games.
