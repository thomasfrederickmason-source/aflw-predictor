// Model vs the market, from the command line (rewritten 2026-10-14).
//
// Same numbers as Fairline's Record tab: it reads GET /api/track-record
// (every published prediction, the bookie prices captured for it, the result)
// and runs the shared maths in Fairline/public/record.js. If the model can't
// beat the closing line, it has no real edge, however good its backtest looks.
//
// Usage: node market-record.js [--edge=0.05] [--open] [--from=8]
//   --edge   only bet when the expected return is at least this (default 0.05)
//   --open   strike bets at the first price seen instead of the closing price
//   --from   only rounds from this one on (8 = the model as upgraded on 2026-10-02)

const R = require('C:/Users/Tom/Projects/Fairline/public/record.js');
const URL = 'https://fairline.thomasfrederickmason.workers.dev/api/track-record';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k)); return a ? (a.includes('=') ? a.split('=')[1] : true) : d; };
const f = (x, n = 3) => (x == null || isNaN(x) ? '-' : x.toFixed(n));
const pv = p => (p == null ? '-' : (p * 100).toFixed(p < 0.1 ? 1 : 0) + '%');

(async () => {
  const data = await (await fetch(URL)).json();
  const r = R.analyse(data, { edge: Number(arg('edge', 0.05)), price: arg('open', false) ? 'open' : 'close', fromRound: Number(arg('from', 0)) });
  const m = r.model, v = r.vsMarket;
  console.log(`Results from ${data.resultsFrom}; ${r.upcoming} published games still to play.\n`);
  console.log(R.verdict(r) + '\n');
  console.log(`The model on its own (${m.n} games from R${m.firstRound}): tips ${m.tips}/${m.tipsOf}, Brier ${f(m.brier, 4)}, log loss ${f(m.logLoss)}, margin miss ${f(m.marginMAE, 1)}, total miss ${f(m.totalMAE, 1)}, totals ${f(Math.abs(m.totalBias), 1)} pts ${m.totalBias < 0 ? 'under' : 'over'} the model`);
  console.log(`vs closing market (${v.n} games, ${v.fromOddsportal} priced from oddsportal's closing average): log loss ${f(v.model.logLoss)} vs ${f(v.market.logLoss)}, Brier ${f(v.model.brier, 4)} vs ${f(v.market.brier, 4)}, z ${f(v.z, 2)}, tips ${v.tipsModel} vs ${v.tipsMarket}`);
  if (r.earlyMarket) console.log(`rounds 3 & 5, market price days out (oddsportal): log loss ${f(r.earlyMarket.model)} vs ${f(r.earlyMarket.market)} on ${r.earlyMarket.n} games`);
  console.log(`\nBets ($1 flat, edge >= ${r.opts.edge * 100}%, at the ${r.opts.price === 'open' ? 'first' : 'closing'} price):`);
  for (const k of ['h2h', 'line', 'total']) {
    const b = r[k];
    console.log(`  ${k.padEnd(5)} ${String(b.n).padStart(3)} bets, ${b.wins} won, profit ${b.profit >= 0 ? '+' : ''}${f(b.profit, 2)} (ROI ${b.roi == null ? '-' : (b.roi * 100).toFixed(1) + '%'}), model expected ${f(b.expectedByModel, 2)}; luck alone does this ${pv(b.luck.p)} of the time`);
  }
  const c = r.clv;
  console.log(`\nClosing-line value: ${c.n} bets at the first price, average ${f(c.avg * 100, 1)}% judged by the close (${c.positive} positive).`);
  console.log(`Prices moved toward the model in ${c.towardCount} of ${c.nMoves} games (avg ${f(c.towardMean * 100, 2)} pts, ${f(c.towardZ, 2)} SE; only games where the model didn't change in between).`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
