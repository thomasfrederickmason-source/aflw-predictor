// Shared normal-distribution helpers (same approximations betting-odds-model.js uses).
function erf(x) {
  // Abramowitz-Stegun approximation, good to ~1e-7
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(x, mean = 0, sd = 1) { return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2))); }
// Inverse standard normal CDF (Acklam's rational approximation).
function invNormalCDF(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  if (p < pLow) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= pHigh) { const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
// The margin-distribution mean that makes P(home margin > 0) = pHome under
// Normal(mean, sd) -- the ONE margin every market is priced from.
// pHome is an EXPECTED SCORE (win 1, draw 1/2, loss 0): that is what Elo
// predicts and what every Brier score here is graded against, and it is
// exactly the fair head-to-head under Australian dead-heat rules (a draw pays
// half). For a continuous margin P(M > 0) = P(win) + P(draw)/2 (continuity
// correction). Until 2026-10-17 this solved P(M > 0.5) = pHome instead, which
// read the expected score as an outright-win chance: every margin sat 0.5 pts
// toward the home side and the away price ignored its half of the draw.
function marginForProb(pHome, sd) { return sd * invNormalCDF(pHome); }
module.exports = { erf, normalCDF, invNormalCDF, marginForProb };
