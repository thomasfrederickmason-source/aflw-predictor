// Refines bom-weather-signal-check.js's daily-total analysis down to the
// match window specifically: pre-match (kickoff-2h to kickoff) and
// during-match (kickoff to kickoff+2h) rain, using Open-Meteo's hourly
// shape rescaled to BOM's real daily total (data/openmeteo_historical.json
// — see fetch-openmeteo-historical.js for the method and why: Open-Meteo's
// archive under-estimates intense localised rain vs real station
// readings). Wind uses Open-Meteo's hourly value directly (unscaled — BOM
// only gives a daily average anyway, no shape to rescale against).
//
// Caveat surfaced explicitly: the rescale factor is unreliable when
// Open-Meteo's modelled shape for the day barely resembles reality (e.g.
// model says near-zero rain that day but BOM recorded real rain) — capped
// at 5x here to avoid absurd spikes, and reported separately by rescale
// reliability band so the finding isn't quietly resting on bad data.

const fs = require('fs');

const matches = JSON.parse(fs.readFileSync('data/matches.json', 'utf8'));
const om = JSON.parse(fs.readFileSync('data/openmeteo_historical.json', 'utf8'));

const RESCALE_CAP = 5;

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
  const w = om[m.matchId];
  if (!w) continue;
  const reliable = w.rescaleFactor <= RESCALE_CAP && w.rescaleFactor >= (1 / RESCALE_CAP);
  rows.push({
    matchId: m.matchId, season: m.season, date: m.date,
    homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    preMatchRainMm: w.preMatchRainMm, // already rescaled by fetch script
    duringMatchRainMm: w.duringMatchRainMm,
    duringMatchWindKmh: w.duringMatchWindKmh,
    rescaleFactor: w.rescaleFactor, reliable,
    totalScore: m.totalScore, absMargin: Math.abs(m.margin),
    totalScoreResidual: m.totalScore - seasonAvg.get(m.season),
  });
}
console.log(`Matches with Open-Meteo match-window data: ${rows.length} of ${matches.length}`);
const reliableRows = rows.filter(r => r.reliable);
console.log(`Of those, ${reliableRows.length} have a "reliable" rescale (model's daily shape roughly matched BOM's total, factor within ${1/RESCALE_CAP}x-${RESCALE_CAP}x)\n`);

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
  return num/Math.sqrt(dx2*dy2);
}

function report(label, rs) {
  console.log(`\n=== ${label} (n=${rs.length}) ===`);
  const during = rs.map(r=>r.duringMatchRainMm), pre = rs.map(r=>r.preMatchRainMm);
  const wind = rs.map(r=>r.duringMatchWindKmh), resid = rs.map(r=>r.totalScoreResidual), margin = rs.map(r=>r.absMargin);
  console.log('  duringMatchRain vs scoreResidual:', pearson(during, resid).toFixed(4));
  console.log('  preMatchRain    vs scoreResidual:', pearson(pre, resid).toFixed(4));
  console.log('  duringMatchWind vs scoreResidual:', pearson(wind, resid).toFixed(4));
  console.log('  duringMatchRain vs |margin|:', pearson(during, margin).toFixed(4));

  function bucket(pred, lbl) {
    const b = rs.filter(pred);
    if (!b.length) { console.log(`    ${lbl}: n=0`); return; }
    const avgResid = b.reduce((s,r)=>s+r.totalScoreResidual,0)/b.length;
    const avgRaw = b.reduce((s,r)=>s+r.totalScore,0)/b.length;
    console.log(`    ${lbl.padEnd(32)} n=${b.length.toString().padStart(4)}  avgResid=${avgResid>=0?'+':''}${avgResid.toFixed(1).padStart(6)}  avgRawTotal=${avgRaw.toFixed(1)}`);
  }
  console.log('  By during-match rain:');
  bucket(r=>r.duringMatchRainMm===0, 'none');
  bucket(r=>r.duringMatchRainMm>0 && r.duringMatchRainMm<=2, 'light (0-2mm)');
  bucket(r=>r.duringMatchRainMm>2 && r.duringMatchRainMm<=8, 'moderate (2-8mm)');
  bucket(r=>r.duringMatchRainMm>8, 'heavy (8mm+)');

  console.log('  By pre-match-only rain (dry during the match itself):');
  bucket(r=>r.preMatchRainMm===0 && r.duringMatchRainMm===0, 'dry before AND during');
  bucket(r=>r.preMatchRainMm>2 && r.duringMatchRainMm===0, 'rained before, dry during (ground wet, air dry)');
  bucket(r=>r.preMatchRainMm===0 && r.duringMatchRainMm>2, 'dry before, rained during (surprise/late change)');
}

report('ALL matches with data', rows);
report('RELIABLE rescale only (model shape trustworthy)', reliableRows);

console.log('\n=== The 10 highest during-match-rain matches (rescaled to BOM daily total) ===');
const wettest = [...reliableRows].sort((a,b)=>b.duringMatchRainMm-a.duringMatchRainMm).slice(0,10);
for (const r of wettest) {
  console.log(`  ${r.date.slice(0,10)}  ${r.homeTeam} v ${r.awayTeam}  pre=${r.preMatchRainMm}mm during=${r.duringMatchRainMm}mm wind=${r.duringMatchWindKmh}km/h  total=${r.totalScore} (resid ${r.totalScoreResidual>=0?'+':''}${r.totalScoreResidual.toFixed(1)})  scale=${r.rescaleFactor}x`);
}

console.log('\n=== "Rained before, dry during" — does pre-match-only rain (wet ground, clear skies) matter on its own? ===');
const preOnly = [...reliableRows].filter(r=>r.preMatchRainMm>2 && r.duringMatchRainMm===0).sort((a,b)=>b.preMatchRainMm-a.preMatchRainMm).slice(0,10);
for (const r of preOnly) {
  console.log(`  ${r.date.slice(0,10)}  ${r.homeTeam} v ${r.awayTeam}  pre=${r.preMatchRainMm}mm  total=${r.totalScore} (resid ${r.totalScoreResidual>=0?'+':''}${r.totalScoreResidual.toFixed(1)})`);
}

fs.writeFileSync('data/openmeteo_signal.json', JSON.stringify(rows, null, 1));
console.log('\nWrote data/openmeteo_signal.json');
