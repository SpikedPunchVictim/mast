// Deterministic PRNG for reproducible sampling (Q3). mulberry32 — a small,
// well-known, dependency-free 32-bit generator (public domain, Tommy Ettinger).
// Not cryptographic; fine for reproducible test-data sampling.

/** @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded sample of `k` distinct items from `items` (Fisher-Yates partial
 * shuffle), without replacement. Deterministic for a given seed + input order.
 * @template T
 * @param {readonly T[]} items
 * @param {number} k
 * @param {number} seed
 * @returns {T[]}
 */
export function seededSample(items, k, seed) {
  const rand = mulberry32(seed);
  const pool = items.slice();
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
