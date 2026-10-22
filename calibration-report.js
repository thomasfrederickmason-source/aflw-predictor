// Deeper look at model calibration than a single aggregate Brier score:
// (1) does the model actually get better in more recent seasons (the era
// that matters for betting now), and (2) reliability by confidence bucket —
// when the model says "80% win probability", does that team actually win
// about 80% of the time, or is the model over/under-confident at the
// extremes?

const fs = require('fs');
const history = JSON.parse(fs.readFileSync('data/elo_history.json', 'utf8'));

function brier(rows) {
  return rows.reduce((s, r) => s + (r.homeWinProbModel - (r.homeWin ? 1 : 0))**2, 0) / rows.length;
}
function accuracy(rows) {
  return rows.filter(r => (r.homeWinProbModel > 0.5) === r.homeWin).length / rows.length;
}

console.log('=== Brier score by season (lower = better, 0.25 = coin flip) ===');
const seasons = [...new Set(history.map(h => h.season))];
// keep AFL.com.au's natural chronological-ish season label order
for (const s of seasons) {
  const rows = history.filter(h => h.season === s);
  console.log(`${s.padEnd(28)} n=${rows.length.toString().padStart(3)}  Brier=${brier(rows).toFixed(4)}  favourite-hit-rate=${(100*accuracy(rows)).toFixed(1)}%`);
}

console.log('\n=== Reliability by confidence bucket (home win prob) ===');
console.log('bucket        n     actual home-win rate   model says');
const buckets = [[0,0.1],[0.1,0.2],[0.2,0.3],[0.3,0.4],[0.4,0.5],[0.5,0.6],[0.6,0.7],[0.7,0.8],[0.8,0.9],[0.9,1.01]];
for (const [lo, hi] of buckets) {
  const rows = history.filter(h => h.homeWinProbModel >= lo && h.homeWinProbModel < hi);
  if (!rows.length) continue;
  const actualRate = rows.filter(r => r.homeWin).length / rows.length;
  const avgModelProb = rows.reduce((s,r) => s + r.homeWinProbModel, 0) / rows.length;
  const flag = Math.abs(actualRate - avgModelProb) > 0.1 ? '  <-- off by >10pp' : '';
  console.log(`${lo.toFixed(1)}-${hi.toFixed(1).padEnd(4)}   n=${rows.length.toString().padStart(3)}   actual=${(100*actualRate).toFixed(1).padStart(5)}%           model avg=${(100*avgModelProb).toFixed(1)}%${flag}`);
}

// recent-era-only calibration (2024+), the part that actually matters for betting now
console.log('\n=== Recent era only (2024+) ===');
const recent = history.filter(h => h.season.includes('2024') || h.season.includes('2025') || h.season.includes('2026'));
console.log(`n=${recent.length}  Brier=${brier(recent).toFixed(4)}  favourite-hit-rate=${(100*accuracy(recent)).toFixed(1)}%`);
