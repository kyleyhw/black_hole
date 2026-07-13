#version 300 es
// ============================================================================
// Kerr black hole ray tracer — main fragment shader.
//
// Phase 1: flat-space rays + procedural starfield.
// Later phases add (in banner-commented sections): Kerr-Schild metric,
// Hamiltonian RK4 geodesic integrator, accretion disk, debug views.
//
// highp is mandatory: mediump silently destroys the integration (PLAN §6).
// ============================================================================
precision highp float;
precision highp int;

out vec4 fragColor;

uniform vec2 uResolution;    // render target size in pixels
uniform vec3 uCamPos;        // camera position, units of M
uniform vec3 uCamRight;      // orthonormal camera basis
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;   // tan(fovY / 2)

// ============================================================================
// SECTION: procedural starfield (spec §2.6)
//
// The escape direction is projected cube-map style (dominant axis -> face
// + 2D face coordinate) to avoid the polar clustering a lat-long grid would
// produce. Each face is divided into CELLS x CELLS cells (6 * 400^2 = 0.96M
// cells); a per-cell hash decides star presence (~4%), sub-cell jitter
// places the star, a power-law sets brightness, and a small temperature ramp
// sets color. Stars are drawn as tight smoothstep falloffs in *angle* so
// they stay sub-pixel-crisp at any resolution.
// ============================================================================

const float STAR_CELLS = 400.0;   // cells per cube-face edge
const float STAR_DENSITY = 0.04;  // fraction of cells containing a star

// 3D integer-ish hash -> [0,1). Standard fract-sin construction; adequate
// statistical quality for star placement and far cheaper than integer hashes.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Dominant-axis cube projection: returns face index [0,6) and face uv [0,1)^2.
void cubeProject(vec3 d, out float face, out vec2 uv) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    face = d.x > 0.0 ? 0.0 : 1.0;
    uv = vec2(d.y, d.z) / a.x;
  } else if (a.y >= a.z) {
    face = d.y > 0.0 ? 2.0 : 3.0;
    uv = vec2(d.x, d.z) / a.y;
  } else {
    face = d.z > 0.0 ? 4.0 : 5.0;
    uv = vec2(d.x, d.y) / a.z;
  }
  uv = uv * 0.5 + 0.5;
}

// Inverse of cubeProject for the center of a cell: reconstruct the 3D
// direction of a star from (face, uv) so proximity can be measured as a
// true angle (avoids face-edge distortion in uv space).
vec3 cubeUnproject(float face, vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  if (face < 0.5) return normalize(vec3(1.0, c.x, c.y));
  if (face < 1.5) return normalize(vec3(-1.0, c.x, c.y));
  if (face < 2.5) return normalize(vec3(c.x, 1.0, c.y));
  if (face < 3.5) return normalize(vec3(c.x, -1.0, c.y));
  if (face < 4.5) return normalize(vec3(c.x, c.y, 1.0));
  return normalize(vec3(c.x, c.y, -1.0));
}

// Blackbody-ish temperature ramp, t in [0,1]: red -> orange -> white -> blue.
vec3 starColor(float t) {
  vec3 red = vec3(1.0, 0.55, 0.35);
  vec3 white = vec3(1.0, 0.98, 0.95);
  vec3 blue = vec3(0.65, 0.75, 1.0);
  return t < 0.5 ? mix(red, white, t * 2.0) : mix(white, blue, (t - 0.5) * 2.0);
}

vec3 starfield(vec3 dir) {
  float face;
  vec2 uv;
  cubeProject(dir, face, uv);
  vec2 cellUv = uv * STAR_CELLS;
  vec2 baseCell = floor(cellUv);

  // Angular size of one pixel, used to keep stars crisp but never aliased
  // below a pixel: the falloff width tracks the local pixel footprint.
  float pixAngle = 2.0 * uTanHalfFov / uResolution.y;

  vec3 col = vec3(0.0);
  // 3x3 neighborhood so stars near cell borders render whole. Face borders
  // are not stitched; at 400 cells/face the seam misses are visually nil.
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      vec2 cell = baseCell + vec2(float(i), float(j));
      vec3 seed = vec3(cell, face * 101.0);
      if (hash13(seed) > STAR_DENSITY) continue;
      vec3 rnd = hash33(seed + 17.0);
      vec3 starDir = cubeUnproject(face, (cell + rnd.xy) / STAR_CELLS);
      // Power-law brightness: b = (1-u)^(-2/3) spans [1, ~10) with most
      // stars faint, a few bright — mimics a magnitude distribution.
      float b = pow(1.0 - 0.97 * rnd.z, -0.6667);
      float ang = acos(clamp(dot(dir, starDir), -1.0, 1.0));
      float radius = pixAngle * (0.5 + 0.35 * b); // brighter -> slightly larger
      float fall = 1.0 - smoothstep(0.0, radius, ang);
      col += fall * b * 0.55 * starColor(hash13(seed + 41.0));
    }
  }
  return col;
}

// ============================================================================
// SECTION: main — per-pixel ray construction (pinhole camera)
// ============================================================================
void main() {
  // NDC in [-1,1], y up, aspect-corrected on x.
  vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 dir = normalize(
    uCamForward + uTanHalfFov * (ndc.x * aspect * uCamRight + ndc.y * uCamUp));

  vec3 color = starfield(dir);
  fragColor = vec4(color, 1.0);
}
