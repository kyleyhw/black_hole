#version 300 es
// Separable Gaussian blur pass (run twice: uDir = (1,0) then (0,1)).
// The first pass doubles as the bright-pass: each tap is thresholded, so
// only HDR highlights (disk face, bright stars) feed the bloom.
precision highp float;

out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2 uTexelSize;   // 1 / texture size
uniform vec2 uDir;         // blur direction in texels
uniform float uThreshold;  // bright-pass threshold (0 disables)

void main() {
  vec2 uv = gl_FragCoord.xy * uTexelSize;
  // 9-tap Gaussian (sigma ~ 2), taps spaced 1.5 texels for a wider kernel
  // at the same cost; weights sum to ~1.
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 c = max(texture(uTex, uv).rgb - uThreshold, 0.0) * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * uTexelSize * (1.5 * float(i));
    c += max(texture(uTex, uv + off).rgb - uThreshold, 0.0) * w[i];
    c += max(texture(uTex, uv - off).rgb - uThreshold, 0.0) * w[i];
  }
  fragColor = vec4(c, 1.0);
}
