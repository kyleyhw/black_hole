// Phase 3 end-to-end test: Kerr integrator correctness, observed in-browser.
//
// Rendering runs on SwiftShader (software WebGL2), so the viewport is small
// and the step budget moderate; the physics is identical to a real GPU.
//
// Checks:
//   1. Schwarzschild shadow size (a=0): captured-pixel disk radius in the
//      "final r" debug view vs the analytic prediction. Since the Phase 8
//      tetrad camera, pixel directions are proper local-frame angles, so
//      the textbook formula applies directly:
//      sin(theta) = (3*sqrt(3) M/r0) sqrt(1 - 2M/r0)  ->  44.09 px here.
//      (Phases 3-7 used a coordinate-covector camera; its distinct
//      prediction, 37.27 px, is derived in derivations.md §4 and was
//      verified to 0.13% at the time. Tolerance 3%.)
//   2. |H| drift view (a=0.9): the red fraction (drift > ~1e-2) must be
//      small — bounded integration error over the visible field.
//   3. Kerr asymmetry (a=0.998, equatorial camera): the shadow centroid
//      shifts horizontally by >1% of width; at a=0 it is centered (<0.5%).
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng } = require("./harness.cjs");

const W = 240;
const H = 180;

// Captured pixels in the "final r" debug view are deep blue (ramp t ~ 0).
function capturedMask(png) {
  const mask = new Uint8Array(png.width * png.height);
  for (let i = 0; i < mask.length; i++) {
    const r = png.data[i * 4];
    const b = png.data[i * 4 + 2];
    mask[i] = b > 160 && r < 80 ? 1 : 0;
  }
  return mask;
}

function maskStats(mask, w, h) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        area++;
        cx += x;
        cy += y;
      }
  return area > 0 ? { area, cx: cx / area, cy: cy / area } : { area: 0, cx: 0, cy: 0 };
}

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: W, height: H });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  // Hide the DOM controls: the canvas must be the only thing screenshotted.
  // !important: the strip sets display via inline style, which would win.
  await page.addStyleTag({ content: "#panel,#fps,#footer{display:none !important}" });

  const setState = (spin, debugView, elevation) =>
    page.evaluate(
      ([s, d, el]) => {
        const bh = window.__bh;
        bh.params.spin = s;
        bh.params.debugView = d;
        bh.params.maxSteps = 600;
        bh.camera.azimuth = 0;
        bh.camera.elevation = el;
        bh.camera.radius = 18;
      },
      [spin, debugView, elevation],
    );

  try {
    // --- 1. Schwarzschild shadow size ---
    await setState(0.0, 3, 0.0);
    await settleFrames(page, 4);
    const shotA0 = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase3-finalr-a0.png"), shotA0);
    const pngA0 = decodePng(shotA0);
    const m0 = maskStats(capturedMask(pngA0), pngA0.width, pngA0.height);
    const measuredRadius = Math.sqrt(m0.area / Math.PI);

    const r0 = 18;
    const fovY = (60 * Math.PI) / 180;
    const alphaEdge = Math.asin(((3 * Math.sqrt(3)) / r0) * Math.sqrt(1 - 2 / r0));
    const predictedRadius = (pngA0.height / 2) * (Math.tan(alphaEdge) / Math.tan(fovY / 2));
    const shadowErr = Math.abs(measuredRadius - predictedRadius) / predictedRadius;

    // --- 2. |H| drift bounded (a=0.9) ---
    await setState(0.9, 2, 0.2);
    await settleFrames(page, 4);
    const shotDrift = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase3-hdrift-a09.png"), shotDrift);
    const pngD = decodePng(shotDrift);
    let redFrac = 0;
    for (let i = 0; i < pngD.width * pngD.height; i++) {
      if (pngD.data[i * 4] > 160 && pngD.data[i * 4 + 2] < 80) redFrac++;
    }
    redFrac /= pngD.width * pngD.height;

    // --- 3. Kerr shadow asymmetry (a=0.998) ---
    await setState(0.998, 3, 0.0);
    await settleFrames(page, 4);
    const shotK = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase3-finalr-a0998.png"), shotK);
    const pngK = decodePng(shotK);
    const mK = maskStats(capturedMask(pngK), pngK.width, pngK.height);
    const shift0 = Math.abs(m0.cx - pngA0.width / 2) / pngA0.width;
    const shiftK = Math.abs(mK.cx - pngK.width / 2) / pngK.width;

    // --- 4. Lensed-sky screenshot for the record (a=0.9, normal shading) ---
    await setState(0.9, 0, 0.2);
    await settleFrames(page, 4);
    fs.writeFileSync(path.join(outDir, "phase3-shadow-a09.png"), await page.screenshot());

    const results = {
      shadow_measured_px: measuredRadius,
      shadow_predicted_px: predictedRadius,
      shadow_rel_err: shadowErr,
      shadow_ok: shadowErr < 0.03,
      hdrift_red_frac: redFrac,
      hdrift_ok: redFrac < 0.15,
      centroid_shift_a0: shift0,
      centroid_shift_a0998: shiftK,
      asymmetry_ok: shift0 < 0.005 && shiftK > 0.01,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (!results.shadow_ok || !results.hdrift_ok || !results.asymmetry_ok) process.exitCode = 1;
  } catch (err) {
    // Without this, a throw inside try is masked by process.exit() in
    // finally and the script dies silently with code 0.
    console.error("TEST ERROR:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit();
  }
})();
