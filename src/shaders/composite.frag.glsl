#version 300 es
// Composite pass: scene + bloom, ACES tonemap, gamma, and the schematic
// diagnostic overlays (ergosphere shell, photon-shell rings). Overlays are
// drawn in FLAT space deliberately — they are coordinate-surface markers,
// not physical objects, and lensing them would misrepresent what they are.
precision highp float;

out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uResolution;
uniform float uBloomStrength;
uniform int uDebugView;  // != 0: pass scene through untouched (exact colors)
uniform int uErgoOn;
uniform int uPhotonOn;
uniform float uSpin;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;

// ACES filmic fit (Narkowicz 2015), input linear HDR, output [0,1].
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Kerr-Schild radius (duplicated from the scene shader for overlay geometry).
float ksRadius(vec3 x, float a) {
  float b = dot(x, x) - a * a;
  float r2 = 0.5 * (b + sqrt(max(b * b + 4.0 * a * a * x.z * x.z, 0.0)));
  return sqrt(max(r2, 1e-8));
}

// Ergosphere surface function: F = r_KS - r_E(theta), zero on the surface
// r_E = M + sqrt(M^2 - a^2 cos^2 theta), cos(theta) = z / r_KS.
float ergoF(vec3 x, float a) {
  float r = ksRadius(x, a);
  float ct = x.z / r;
  return r - (1.0 + sqrt(max(1.0 - a * a * ct * ct, 0.0)));
}

// Photon-shell radii (equatorial): r_ph = 2M(1 + cos(2/3 acos(-+ a))).
float photonR(float a, float sense) {
  return 2.0 * (1.0 + cos((2.0 / 3.0) * acos(clamp(-sense * a, -1.0, 1.0))));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  // Debug views carry categorical false colors — bloom/tonemap would
  // distort exactly what they exist to show. Pass them through raw.
  if (uDebugView != 0) {
    fragColor = vec4(texture(uScene, uv).rgb, 1.0);
    return;
  }
  vec3 hdr = texture(uScene, uv).rgb + uBloomStrength * texture(uBloom, uv).rgb;
  vec3 color = pow(aces(hdr), vec3(1.0 / 2.2));

  // Flat-space pixel ray for the overlays.
  vec2 ndc = uv * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 dir = normalize(
      uCamForward + uTanHalfFov * (ndc.x * aspect * uCamRight + ndc.y * uCamUp));

  if (uErgoOn == 1) {
    // Fixed-step march for a sign change of ergoF, one bisection refine.
    vec3 p0 = uCamPos;
    float f0 = ergoF(p0, uSpin);
    bool hit = false;
    vec3 ph = p0;
    for (int i = 0; i < 96; i++) {
      vec3 p1 = p0 + dir * 0.25;
      float f1 = ergoF(p1, uSpin);
      if (f0 > 0.0 && f1 <= 0.0) {
        ph = mix(p0, p1, f0 / max(f0 - f1, 1e-6));
        hit = true;
        break;
      }
      p0 = p1;
      f0 = f1;
      if (dot(p0, p0) > 900.0 && dot(p0, dir) > 0.0) break;  // walked past
    }
    if (hit) {
      // Grazing-angle emphasis: stronger rim where the ray skims the shell.
      float eps = 0.05;
      vec3 grad = normalize(vec3(
          ergoF(ph + vec3(eps, 0, 0), uSpin) - ergoF(ph - vec3(eps, 0, 0), uSpin),
          ergoF(ph + vec3(0, eps, 0), uSpin) - ergoF(ph - vec3(0, eps, 0), uSpin),
          ergoF(ph + vec3(0, 0, eps), uSpin) - ergoF(ph - vec3(0, 0, eps), uSpin)));
      float rim = pow(1.0 - abs(dot(grad, dir)), 2.0);
      color = mix(color, vec3(0.35, 0.75, 1.0), 0.18 + 0.35 * rim);
    }
  }

  if (uPhotonOn == 1 && abs(dir.z) > 1e-5) {
    // Equatorial rings at the prograde/retrograde photon-orbit radii.
    float t = -uCamPos.z / dir.z;
    if (t > 0.0) {
      vec2 q = uCamPos.xy + t * dir.xy;
      float rho = length(q);
      // Ring KS radius on the equator: r^2 = rho^2 - a^2.
      float rk = sqrt(max(rho * rho - uSpin * uSpin, 0.0));
      float wpx = 0.02 * rho + 0.02;  // ~constant apparent thickness
      float dPro = abs(rk - photonR(uSpin, 1.0));
      float dRet = abs(rk - photonR(uSpin, -1.0));
      if (dPro < wpx) color = mix(color, vec3(1.0, 0.55, 0.2), 0.6 * (1.0 - dPro / wpx));
      if (dRet < wpx) color = mix(color, vec3(0.4, 0.6, 1.0), 0.6 * (1.0 - dRet / wpx));
    }
  }

  fragColor = vec4(color, 1.0);
}
