// Two things: (1) league-wide, which quarter/half scores the most points on
// average, and (2) per-team quarter-scoring "shape" (what fraction of a
// team's score typically comes from each quarter, both for and against),
// saved so predict-round.js can distribute a predicted total across
// quarters per fixture rather than just reporting one number.

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'))
  .filter(m => m.homeQtr && m.awayQtr && m.homeQtr.every(v => v != null) && m.awayQtr.every(v => v != null));

function quarterTotals(rows) {
  const q = [0, 0, 0, 0];
  for (const m of rows) {
    for (let i = 0; i < 4; i++) q[i] += m.homeQtr[i] + m.awayQtr[i];
  }
  const n = rows.length;
  return q.map(v => v / n); // avg combined (both teams) points per quarter, per match
}

console.log('=== League-wide avg combined points per quarter (both teams) ===');
const allQ = quarterTotals(matches);
allQ.forEach((v, i) => console.log(`  Q${i+1}: ${v.toFixed(2)}`));
const allH1 = allQ[0] + allQ[1], allH2 = allQ[2] + allQ[3];
console.log(`  H1 (Q1+Q2): ${allH1.toFixed(2)}   H2 (Q3+Q4): ${allH2.toFixed(2)}`);
console.log(`  Highest-scoring quarter: Q${allQ.indexOf(Math.max(...allQ)) + 1}   Highest-scoring half: ${allH1 >= allH2 ? 'H1' : 'H2'}`);
console.log(`  (n=${matches.length} matches, all eras — scoring has risen over time, see README, so also checking current era below)`);

const recent = matches.filter(m => m.season.includes('2024') || m.season.includes('2025') || m.season.includes('2026'));
console.log(`\n=== Current era only (2024+, n=${recent.length}) ===`);
const recentQ = quarterTotals(recent);
recentQ.forEach((v, i) => console.log(`  Q${i+1}: ${v.toFixed(2)}`));
const recentH1 = recentQ[0] + recentQ[1], recentH2 = recentQ[2] + recentQ[3];
console.log(`  H1 (Q1+Q2): ${recentH1.toFixed(2)}   H2 (Q3+Q4): ${recentH2.toFixed(2)}`);
console.log(`  Highest-scoring quarter: Q${recentQ.indexOf(Math.max(...recentQ)) + 1}   Highest-scoring half: ${recentH1 >= recentH2 ? 'H1' : 'H2'}`);

// --- per-team quarter shape (current era), for distributing a predicted
// total across quarters ---
const teams = [...new Set(recent.flatMap(m => [m.homeTeam, m.awayTeam]))];
const qFor = new Map(), qAgainst = new Map(), qCount = new Map();
for (const m of recent) {
  for (const [team, own, opp] of [[m.homeTeam, m.homeQtr, m.awayQtr], [m.awayTeam, m.awayQtr, m.homeQtr]]) {
    if (!qFor.has(team)) { qFor.set(team, [0,0,0,0]); qAgainst.set(team, [0,0,0,0]); qCount.set(team, 0); }
    const f = qFor.get(team), a = qAgainst.get(team);
    for (let i = 0; i < 4; i++) { f[i] += own[i]; a[i] += opp[i]; }
    qCount.set(team, qCount.get(team) + 1);
  }
}
const profiles = {};
for (const team of teams) {
  const n = qCount.get(team) || 0;
  if (n < 5) continue;
  const f = qFor.get(team).map(v => v / n);
  const a = qAgainst.get(team).map(v => v / n);
  const fSum = f.reduce((s,v)=>s+v,0), aSum = a.reduce((s,v)=>s+v,0);
  profiles[team] = {
    n,
    forShare: f.map(v => v / fSum),       // fraction of THIS team's own scoring by quarter
    againstShare: a.map(v => v / aSum),   // fraction of points THIS team concedes by quarter
    forAvg: f, againstAvg: a,
  };
}
fs.writeFileSync('data/quarter_profiles.json', JSON.stringify(profiles, null, 1));
console.log(`\nWrote data/quarter_profiles.json (${Object.keys(profiles).length} teams with enough current-era data)`);

console.log('\n=== Per-team quarter share (FOR), current era — where each team does its scoring ===');
for (const team of Object.keys(profiles).sort()) {
  const p = profiles[team];
  const pct = p.forShare.map(v => (v*100).toFixed(0)+'%');
  console.log(`  ${team.padEnd(14)} Q1 ${pct[0].padStart(4)} Q2 ${pct[1].padStart(4)} Q3 ${pct[2].padStart(4)} Q4 ${pct[3].padStart(4)}  (n=${p.n})`);
}
