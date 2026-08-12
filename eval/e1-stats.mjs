// E1 — the statistics registered in IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION
// (AMENDMENTS 1 and 3). Pure functions only: no I/O, no corpus knowledge.
//
// Split out from the scorer so Gate 7's known-answer tests can drive the estimators
// directly against datasets whose true parameters are known by construction.
//
// Nothing here is novel. Everything is the textbook form of a registered method, because
// the registration's job was to remove the author's discretion and a clever estimator
// would put it back.

/** ---------- special functions (needed for the t and F tails) ---------- */

function logGamma(x) {
  // Lanczos approximation, g=7, n=9. Accurate to ~1e-15 relative for x > 0.
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (Numerical Recipes §6.4). */
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** P(T <= t) for Student's t with `df` degrees of freedom. */
export function studentTCdf(t, df) {
  const p = 0.5 * betai(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? 1 - p : p;
}

/** Two-sided critical value: the t with P(T <= t) = p. Bisection — df is small here. */
export function studentTQuantile(p, df) {
  let lo = -100, hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** P(F <= f) for the F distribution. */
export function fCdf(f, d1, d2) {
  if (f <= 0) return 0;
  return betai(d1 / 2, d2 / 2, (d1 * f) / (d1 * f + d2));
}

/** ---------- OLS on two parameters ---------- */

/**
 * Fit `y = intercept + slope * x` by OLS.
 *
 * @returns {{intercept:number, slope:number, fitted:number[], resid:number[],
 *            leverage:number[], Sxx:number, n:number, xbar:number}}
 */
export function olsFit(xs, ys) {
  const n = xs.length;
  if (n !== ys.length) throw new Error('olsFit: xs and ys differ in length');
  if (n < 3) throw new Error(`olsFit: need at least 3 observations, got ${n}`);
  const distinctX = new Set(xs.map((v) => v.toFixed(12))).size;
  if (distinctX < 2) {
    throw new Error(`olsFit: slope is not identifiable — only ${distinctX} distinct x value(s)`);
  }

  const xbar = xs.reduce((s, v) => s + v, 0) / n;
  const ybar = ys.reduce((s, v) => s + v, 0) / n;
  let Sxx = 0, Sxy = 0;
  for (let i = 0; i < n; i++) { Sxx += (xs[i] - xbar) ** 2; Sxy += (xs[i] - xbar) * (ys[i] - ybar); }
  const slope = Sxy / Sxx;
  const intercept = ybar - slope * xbar;
  const fitted = xs.map((x) => intercept + slope * x);
  const resid = ys.map((y, i) => y - fitted[i]);
  // h_ii for the 2-parameter design [1, x].
  const leverage = xs.map((x) => 1 / n + ((x - xbar) ** 2) / Sxx);
  return { intercept, slope, fitted, resid, leverage, Sxx, n, xbar };
}

/**
 * HC3 heteroscedasticity-robust SE of the slope — the registered PRIMARY.
 *
 * HC3 divides each squared residual by (1 - h_ii)^2. For the 2-parameter design the
 * slope's sandwich reduces to Σ (x_i - x̄)² û_i²/(1-h_i)² / Sxx².
 */
export function hc3SlopeSe(fit, xs) {
  let meat = 0;
  for (let i = 0; i < fit.n; i++) {
    const w = fit.resid[i] / (1 - fit.leverage[i]);
    meat += ((xs[i] - fit.xbar) ** 2) * w * w;
  }
  return Math.sqrt(meat / (fit.Sxx ** 2));
}

/**
 * CR1 cluster-robust SE of the slope — used to studentize the wild cluster bootstrap.
 *
 * Finite-sample factor c = G/(G-1) · (n-1)/(n-k), the standard CR1 correction.
 */
export function cr1SlopeSe(fit, xs, clusters) {
  const byCluster = new Map();
  for (let i = 0; i < fit.n; i++) {
    const g = clusters[i];
    byCluster.set(g, (byCluster.get(g) ?? 0) + (xs[i] - fit.xbar) * fit.resid[i]);
  }
  let meat = 0;
  for (const s of byCluster.values()) meat += s * s;
  const G = byCluster.size;
  const k = 2;
  const c = (G / (G - 1)) * ((fit.n - 1) / (fit.n - k));
  return Math.sqrt((c * meat) / (fit.Sxx ** 2));
}

/** ---------- wild cluster bootstrap ---------- */

/** Webb's 6-point weights — the registered choice (AMENDMENT 3, MAT-1). */
const WEBB = [-Math.sqrt(3 / 2), -1, -Math.sqrt(1 / 2), Math.sqrt(1 / 2), 1, Math.sqrt(3 / 2)];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wild cluster bootstrap-t — the registered SENSITIVITY.
 *
 * Registered parameterisation (AMENDMENT 3, MAT-1):
 *   - Webb 6-point weights (6^9 ≈ 10.1M atoms at G=9; Rademacher would give 512)
 *   - RESTRICTED residuals (imposing H0: slope = h0) for the hypothesis test
 *   - UNRESTRICTED residuals for the percentile-t CI
 *   - studentized with the CR1 cluster-robust SE
 *   - B draws, seeded
 *
 * @returns {{ci:[number,number], p:number, b:number, se:number, atoms:number}}
 */
export function wildClusterBootstrap(xs, ys, clusters, { B = 10000, seed = 811, h0 = 1.35 } = {}) {
  const fit = olsFit(xs, ys);
  const se = cr1SlopeSe(fit, xs, clusters);
  const tObs = (fit.slope - h0) / se;

  const groups = [...new Set(clusters)];
  const rng = mulberry32(seed);

  // Restricted fit: impose slope = h0, so the only free parameter is the intercept.
  const yMinus = ys.map((y, i) => y - h0 * xs[i]);
  const rInt = yMinus.reduce((s, v) => s + v, 0) / fit.n;
  const restrictedFitted = xs.map((x) => rInt + h0 * x);
  const restrictedResid = ys.map((y, i) => y - restrictedFitted[i]);

  const tStarTest = [];   // from restricted residuals -> p-value
  const tStarCi = [];     // from unrestricted residuals -> percentile-t CI

  for (let b = 0; b < B; b++) {
    const w = new Map();
    for (const g of groups) w.set(g, WEBB[Math.floor(rng() * 6)]);

    const yTest = ys.map((_, i) => restrictedFitted[i] + w.get(clusters[i]) * restrictedResid[i]);
    const fTest = olsFit(xs, yTest);
    const sTest = cr1SlopeSe(fTest, xs, clusters);
    if (sTest > 0) tStarTest.push((fTest.slope - h0) / sTest);

    const yCi = ys.map((_, i) => fit.fitted[i] + w.get(clusters[i]) * fit.resid[i]);
    const fCi = olsFit(xs, yCi);
    const sCi = cr1SlopeSe(fCi, xs, clusters);
    if (sCi > 0) tStarCi.push((fCi.slope - fit.slope) / sCi);
  }

  const p = tStarTest.length === 0
    ? 1
    : tStarTest.filter((t) => Math.abs(t) >= Math.abs(tObs)).length / tStarTest.length;

  tStarCi.sort((a, b2) => a - b2);
  const q = (pr) => {
    if (tStarCi.length === 0) return NaN;
    const idx = Math.min(tStarCi.length - 1, Math.max(0, Math.floor(pr * (tStarCi.length - 1))));
    return tStarCi[idx];
  };
  // Percentile-t: the interval is inverted, so the UPPER quantile makes the LOWER bound.
  const ci = [fit.slope - q(0.975) * se, fit.slope - q(0.025) * se];

  return { ci, p, b: fit.slope, se, atoms: Math.pow(6, groups.length) };
}

/** ---------- trigger 1: lack of fit ---------- */

/**
 * Classical lack-of-fit F test plus the registered practical-significance floor.
 *
 * AMENDMENT 3 FATAL-1 replaced the old `ms/chunk` monotonicity trigger with this, because
 * monotone increase in ms/chunk is the EXPECTED signature under the same N log N model
 * used to justify the 1.35 threshold — the old trigger fired on health.
 *
 * Fires only when BOTH hold:
 *   - F(g-2, n-g) significant at `alpha`, and
 *   - the fitted quadratic-in-x term departs from the straight line by more than
 *     `floorPct` in predicted time at the ladder's endpoints.
 *
 * The floor is what keeps the trigger from firing on the N log N term's own curvature,
 * which is ~0.69% for this ladder's geometry.
 */
export function lackOfFit(xs, ys, clusters, { alpha = 0.05, floorPct = 5 } = {}) {
  const fit = olsFit(xs, ys);
  const groups = [...new Set(clusters)];
  const g = groups.length, n = fit.n;
  if (g < 3) throw new Error(`lackOfFit: need at least 3 groups for a lack-of-fit test, got ${g}`);
  if (n <= g) {
    throw new Error(`lackOfFit: no pure error available (n=${n}, groups=${g}) — replication is required`);
  }

  const SSE = fit.resid.reduce((s, r) => s + r * r, 0);
  let SSPE = 0;
  for (const grp of groups) {
    const idx = [];
    for (let i = 0; i < n; i++) if (clusters[i] === grp) idx.push(i);
    const mean = idx.reduce((s, i) => s + ys[i], 0) / idx.length;
    for (const i of idx) SSPE += (ys[i] - mean) ** 2;
  }
  const SSLOF = Math.max(0, SSE - SSPE);
  const dfLof = g - 2, dfPe = n - g;

  if (SSPE === 0) {
    return {
      fires: false, undefinedReason: 'zero pure error — F is not computable',
      F: null, p: null, dfLof, dfPe, departurePct: quadraticDeparturePct(xs, ys),
    };
  }

  const F = (SSLOF / dfLof) / (SSPE / dfPe);
  const p = 1 - fCdf(F, dfLof, dfPe);
  const departurePct = quadraticDeparturePct(xs, ys);

  return {
    F, p, dfLof, dfPe, departurePct,
    significant: p < alpha,
    exceedsFloor: departurePct > floorPct,
    fires: p < alpha && departurePct > floorPct,
  };
}

/**
 * Departure implied by the fitted quadratic term, as a percentage of predicted time.
 *
 * Method (the same one used to compute the registration's 0.69% N log N benchmark): fit
 * `y = a + b·x + c·x²`, take the pure quadratic component `c·x²` at the design points, and
 * measure how far it departs from its OWN best straight-line approximation over those
 * points. That isolates curvature from the linear trend, which is what "the single exponent
 * misdescribes this ladder" means. Log units convert to a time ratio via exp().
 */
export function quadraticDeparturePct(xs, ys) {
  const n = xs.length;
  // Normal equations for [1, x, x²] via Cramer on a 3x3.
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  const M = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (Math.abs(D) < 1e-12) return 0;
  const M2 = [[s0, s1, t0], [s1, s2, t1], [s2, s3, t2]];
  const c = det3(M2) / D;

  // Residual of c·x² from its own linear fit over the design points.
  const v = xs.map((x) => c * x * x);
  const vFit = olsFit(xs, v);
  const maxDev = Math.max(...vFit.resid.map(Math.abs));
  return (Math.exp(maxDev) - 1) * 100;
}
