// Phase 14 (suite #13) end-to-end test: BINARY shader variant — superposed
// Kerr-Schild two-hole rendering (static preview).
//
// Checks:
//   1. Single-hole limit: binary mode with M2 = 0 must render PIXEL-IDENTICAL
//      to Kerr mode at the same spin/camera — the shader's BINARY branches
//      are engineered to reduce bit-for-bit when f2 = 0 (guarded step/eps
//      terms, exact 0-additions), and the CPU tetrad path shares the same
//      Gram-Schmidt core. Any drift here means the reduction broke.
//   2. Two-hole scene: dark capture regions at the two PREDICTED projected
//      screen positions (pinhole model computed independently in the test),
//      and a large image change vs the single-hole frame.
//   3. |H|-drift debug view: the integrator's conservation error in the
//      superposed metric stays in the same band as single Kerr (the debug
//      view false-colors log10|H|; similar mean luminance = similar drift).
//   4. Deep-overlap smoke (sep = 2 M): the Sherman-Morrison D-guard and
//      per-hole capture keep the image finite — stars visible, merged dark
//      core present, no NaN blowout.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, stats, diffFrac } = require("./harness.cjs");

const W = 320;
const H = 240;

// Fraction of dark pixels (lum < 20) in a disk of radius rad about (cx, cy).
function darkFrac(png, cx, cy, rad) {
  let dark = 0;
  let n = 0;
  for (let y = Math.max(0, cy - rad); y < Math.min(png.height, cy + rad); y++)
    for (let x = Math.max(0, cx - rad); x < Math.min(png.width, cx + rad); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
      const i = (y * png.width + x) * 4;
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      n++;
      if (lum < 20) dark++;
    }
  return dark / Math.max(n, 1);
}

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: W, height: H });
  await page.addStyleTag({ content: "#panel,#fps,#footer,#panelToggle{display:none !important}" });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  const setState = (o) =>
    page.evaluate((s) => {
      const bh = window.__bh;
      Object.assign(bh.params, {
        maxSteps: 300,
        resolutionScale: 0.5,
        diskOn: false, // no disk in binary mode; keep the Kerr reference equal
        debugView: 0,
        skyShift: true,
        ...s.params,
      });
      Object.assign(bh.camera, { azimuth: 0, elevation: 0, radius: 30, ...s.camera });
    }, o);

  try {
    // --- 1. Single-hole limit: binary(M2 = 0) vs Kerr, pixel parity ---
    await setState({ params: { mode: "kerr", spin: 0.6 } });
    await settleFrames(page, 4);
    const kerrShot = decodePng(await page.screenshot());
    await setState({
      params: { mode: "binary", binaryQ: 0, binaryChi1: 0.6, binarySep: 16 },
    });
    await settleFrames(page, 4);
    const binZeroShot = decodePng(await page.screenshot());
    const parityDiff = diffFrac(kerrShot, binZeroShot, 2);

    // --- 2. Two equal holes at +-8 M: shadows at predicted positions ---
    await setState({
      params: { mode: "binary", binaryQ: 1, binaryChi1: 0.7, binaryChi2: -0.3, binarySep: 16 },
    });
    await settleFrames(page, 4);
    const pairShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase13-binary-pair.png"), pairShot);
    const pairPng = decodePng(pairShot);
    // Pinhole projection (same math as the app camera): camera at (30,0,0)
    // looking -x, right = +y, up = +z; holes at y = -+8 (barycentric, q = 1).
    const tanHF = Math.tan(Math.PI / 6);
    const aspect = W / H;
    const sx1 = Math.round(((-8 / (30 * tanHF * aspect)) + 1) * 0.5 * W);
    const sx2 = Math.round(((8 / (30 * tanHF * aspect)) + 1) * 0.5 * W);
    const dark1 = darkFrac(pairPng, sx1, H / 2, 15);
    const dark2 = darkFrac(pairPng, sx2, H / 2, 15);
    const pairVsSingle = diffFrac(binZeroShot, pairPng, 20);

    // --- 3. |H|-drift band vs single Kerr ---
    await setState({ params: { mode: "kerr", spin: 0.6, debugView: 2 } });
    await settleFrames(page, 4);
    const driftKerr = stats(decodePng(await page.screenshot())).meanLum;
    await setState({
      params: {
        mode: "binary", binaryQ: 1, binaryChi1: 0.7, binaryChi2: -0.3,
        binarySep: 16, debugView: 2,
      },
    });
    await settleFrames(page, 4);
    const driftShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase13-binary-drift.png"), driftShot);
    const driftBinary = stats(decodePng(driftShot)).meanLum;
    const driftRatio = driftBinary / Math.max(driftKerr, 1e-6);

    // --- 4. Deep-overlap smoke (sep = 2 M) ---
    await setState({
      params: { mode: "binary", binaryQ: 1, binaryChi1: 0.7, binaryChi2: -0.3, binarySep: 2 },
    });
    await settleFrames(page, 4);
    const overlapPng = decodePng(await page.screenshot());
    const ov = stats(overlapPng, 32);
    const ovDark = darkFrac(overlapPng, W / 2, H / 2, 30);

    const results = {
      parity_diffFrac: parityDiff,
      parity_ok: parityDiff < 0.001,
      pair_dark_left: dark1,
      pair_dark_right: dark2,
      pair_vs_single_diffFrac: pairVsSingle,
      pair_ok: dark1 > 0.4 && dark2 > 0.4 && pairVsSingle > 0.15,
      drift_mean_kerr: driftKerr,
      drift_mean_binary: driftBinary,
      drift_ratio: driftRatio,
      drift_ok: driftRatio > 0.5 && driftRatio < 2.0,
      overlap_meanLum: ov.meanLum,
      overlap_starFrac: ov.brightFrac,
      overlap_darkCore: ovDark,
      overlap_ok: ov.brightFrac > 0.005 && ovDark > 0.1 && ov.meanLum > 2 && ov.meanLum < 200,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (!results.parity_ok || !results.pair_ok || !results.drift_ok || !results.overlap_ok)
      process.exitCode = 1;
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit();
  }
})();
