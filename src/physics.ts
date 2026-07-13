// CPU-side physics helpers (units G = c = M = 1).
// Derivations: docs/derivations.md §6.

/** Outer horizon radius r_+ = 1 + sqrt(1 - a^2). */
export function horizonRadius(a: number): number {
  return 1 + Math.sqrt(Math.max(1 - a * a, 0));
}

/**
 * ISCO radius (Bardeen–Press–Teukolsky 1972); sense = +1 prograde,
 * -1 retrograde. Limits: a=0 -> 6, a->1 -> 1 (prograde) / 9 (retrograde).
 */
export function riscoOf(a: number, sense: 1 | -1 = 1): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - sense * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** Equatorial photon-orbit radius; sense = +1 prograde, -1 retrograde. */
export function photonOrbitRadius(a: number, sense: 1 | -1): number {
  return 2 * (1 + Math.cos((2 / 3) * Math.acos(-sense * a)));
}

/** Ergosphere radius on the equator: r_E = 2M (θ = π/2). */
export function ergosphereRadius(a: number, cosTheta: number): number {
  return 1 + Math.sqrt(Math.max(1 - a * a * cosTheta * cosTheta, 0));
}
