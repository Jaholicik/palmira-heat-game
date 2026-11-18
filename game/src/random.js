// Seeded random streams (mulberry32): the same seed gives the same game, which is what makes
// the screenshot scenes repeatable. The simulation draws only from the stream it is handed at
// creation; decoration (window lights, cloud shadows) uses its own fixed-seed stream and a
// pure hash, so rendering can never perturb the simulation.

export function createRandom(seed) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A private stream for pure decoration, seeded once and for all. */
export function createDecoRandom() {
  return createRandom(0x5eed1234);
}

/** Deterministic 0..1 hash of two integers — for per-window lights and other stable detail. */
export function hash2(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
