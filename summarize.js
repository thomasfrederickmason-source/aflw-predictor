const fs = require('fs');
const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));

console.log('Total matches:', matches.length);
const bySeason = {};
matches.forEach(m => { bySeason[m.season] = (bySeason[m.season] || 0) + 1; });
console.log('\nBy season:');
Object.entries(bySeason).forEach(([s, c]) => console.log(' ', s, c));

const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const totals = matches.map(m => m.totalScore).filter(x => x != null);
const margins = matches.map(m => Math.abs(m.margin)).filter(x => x != null);
console.log('\nAvg combined match score:', avg(totals).toFixed(1));
console.log('Avg absolute margin:', avg(margins).toFixed(1));

// per-quarter scoring, both teams combined, across all matches
const qTotals = [0, 0, 0, 0], qCounts = [0, 0, 0, 0];
matches.forEach(m => {
  [m.homeQtr, m.awayQtr].forEach(qtr => {
    qtr.forEach((v, i) => { if (v != null) { qTotals[i] += v; qCounts[i]++; } });
  });
});
console.log('\nAvg points scored per quarter (both teams combined avg per team-quarter):');
qTotals.forEach((t, i) => console.log(`  Q${i+1}: ${(t / qCounts[i]).toFixed(1)}`));

// recent (2025+2026) vs early (2017-2019) scoring trend
const recent = matches.filter(m => m.season.includes('2025') || m.season.includes('2026'));
const early = matches.filter(m => m.season.includes('2017') || m.season.includes('2018') || m.season.includes('2019'));
console.log('\nAvg combined score — early era (2017-19):', avg(early.map(m=>m.totalScore)).toFixed(1), `(${early.length} matches)`);
console.log('Avg combined score — recent era (2025-26):', avg(recent.map(m=>m.totalScore)).toFixed(1), `(${recent.length} matches)`);

console.log('\nSample match:', JSON.stringify(matches[matches.length-1], null, 2));
