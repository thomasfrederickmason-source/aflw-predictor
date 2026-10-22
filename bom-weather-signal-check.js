// Same question as weather-signal-check.js (does rain/wind move scoring?)
// but with REAL observed BOM data (data/bom_weather.json — daily rainfall
// mm 9am-9am, average 10m wind speed m/s, from the nearest station to each
// venue) instead of AFL.com.au's pre-match forecast text, and this time
// controlling for the known season-over-season scoring inflation trend
// (documented elsewhere in this project) by using each match's residual
// against ITS OWN season's average total score, not the raw pooled value —
// that's what made the forecast-based version misleading.

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const bom = JSON.parse(fs.readFileSync('data/bom_weather.json', 'utf8'));

// season average total score, for era-detrending
const seasonTotals = new Map();
for (const m of matches) {
  if (m.totalScore == null) continue;
  if (!seasonTotals.has(m.season)) seasonTotals.set(m.season, []);
  seasonTotals.get(m.season).push(m.totalScore);
}
const seasonAvg = new Map([...seasonTotals].map(([s, vals]) => [s, vals.reduce((a,b)=>a+b,0)/vals.length]));

const rows = [];
for (const m of matches) {
  if (m.totalScore == null) continue;
  const w = bom[m.matchId];
  if (!w || w.rainMm == null || w.windMs == null) continue;
  rows.push({
    matchId: m.matchId, season: m.season, date: m.date,
    homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    rainMm: w.rainMm, windMs: w.windMs, station: w.station,
    totalScore: m.totalScore, absMargin: Math.abs(m.margin),
    totalScoreResidual: m.totalScore - seasonAvg.get(m.season), // era-detrended
  });
}
console.log(`Matches with BOM weather + score data: ${rows.length} of ${matches.length}\n`);

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
  return num/Math.sqrt(dx2*dy2);
}

const rainArr = rows.map(r=>r.rainMm);
const windArr = rows.map(r=>r.windMs);
const residArr = rows.map(r=>r.totalScoreResidual);
const marginArr = rows.map(r=>r.absMargin);
const rawTotalArr = rows.map(r=>r.totalScore);

console.log('=== Correlations (era-detrended total-score residual) ===');
console.log('rainMm vs totalScoreResidual:', pearson(rainArr, residArr).toFixed(4));
console.log('windMs vs totalScoreResidual:', pearson(windArr, residArr).toFixed(4));
console.log('rainMm vs |margin|:', pearson(rainArr, marginArr).toFixed(4));
console.log('windMs vs |margin|:', pearson(windArr, marginArr).toFixed(4));
console.log('\n(for comparison, RAW un-detrended) rainMm vs totalScore:', pearson(rainArr, rawTotalArr).toFixed(4));
console.log('(for comparison, RAW un-detrended) windMs vs totalScore:', pearson(windArr, rawTotalArr).toFixed(4));

function bucketStats(bucket) {
  const n = bucket.length;
  if (!n) return null;
  const avgResid = bucket.reduce((s,r)=>s+r.totalScoreResidual,0)/n;
  const avgRawTotal = bucket.reduce((s,r)=>s+r.totalScore,0)/n;
  const avgMargin = bucket.reduce((s,r)=>s+r.absMargin,0)/n;
  return { n, avgResid, avgRawTotal, avgMargin };
}
function printBucket(label, bucket) {
  const s = bucketStats(bucket);
  if (!s) { console.log(label.padEnd(28), 'n=0'); return; }
  console.log(label.padEnd(28), `n=${s.n.toString().padStart(4)}  avgResid=${s.avgResid>=0?'+':''}${s.avgResid.toFixed(1).padStart(6)}  avgRawTotal=${s.avgRawTotal.toFixed(1).padStart(6)}  avgAbsMargin=${s.avgMargin.toFixed(1)}`);
}

console.log('\n=== By rain (mm, daily total 9am-9am) — era-detrended ===');
printBucket('none (0mm)', rows.filter(r=>r.rainMm===0));
printBucket('light (0-2mm)', rows.filter(r=>r.rainMm>0 && r.rainMm<=2));
printBucket('moderate (2-10mm)', rows.filter(r=>r.rainMm>2 && r.rainMm<=10));
printBucket('heavy (10-25mm)', rows.filter(r=>r.rainMm>10 && r.rainMm<=25));
printBucket('very heavy (25mm+)', rows.filter(r=>r.rainMm>25));

console.log('\n=== By wind (average 10m wind speed, m/s) — era-detrended ===');
printBucket('calm (0-2 m/s)', rows.filter(r=>r.windMs<=2));
printBucket('moderate (2-4 m/s)', rows.filter(r=>r.windMs>2 && r.windMs<=4));
printBucket('breezy (4-6 m/s)', rows.filter(r=>r.windMs>4 && r.windMs<=6));
printBucket('windy (6-8 m/s)', rows.filter(r=>r.windMs>6 && r.windMs<=8));
printBucket('very windy (8+ m/s)', rows.filter(r=>r.windMs>8));

console.log('\n=== Combined worst-case: heavy rain (10mm+) AND windy (6+ m/s) vs calm/dry ===');
printBucket('calm & dry (wind<=2, rain=0)', rows.filter(r=>r.windMs<=2 && r.rainMm===0));
printBucket('heavy rain + windy', rows.filter(r=>r.rainMm>10 && r.windMs>6));

console.log('\n=== The wettest 15 matches on record (real BOM rainfall that day) ===');
const wettest = [...rows].sort((a,b)=>b.rainMm-a.rainMm).slice(0,15);
for (const r of wettest) {
  console.log(`  ${r.date.slice(0,10)}  ${r.homeTeam} v ${r.awayTeam}  rain=${r.rainMm}mm  wind=${r.windMs}m/s  total=${r.totalScore} (season avg ${seasonAvg.get(r.season).toFixed(1)}, resid ${r.totalScoreResidual>=0?'+':''}${r.totalScoreResidual.toFixed(1)})  |margin|=${r.absMargin}  [${r.station}]`);
}

console.log('\n=== The windiest 15 matches on record ===');
const windiest = [...rows].sort((a,b)=>b.windMs-a.windMs).slice(0,15);
for (const r of windiest) {
  console.log(`  ${r.date.slice(0,10)}  ${r.homeTeam} v ${r.awayTeam}  wind=${r.windMs}m/s  rain=${r.rainMm}mm  total=${r.totalScore} (season avg ${seasonAvg.get(r.season).toFixed(1)}, resid ${r.totalScoreResidual>=0?'+':''}${r.totalScoreResidual.toFixed(1)})  |margin|=${r.absMargin}  [${r.station}]`);
}

fs.writeFileSync('data/bom_weather_signal.json', JSON.stringify(rows, null, 1));
console.log('\nWrote data/bom_weather_signal.json');
