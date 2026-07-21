// Phase 18 (suite #16) end-to-end test: time-dependent (retarded) ray transport.
//
// The binary metric is time-dependent, so the default renderer FREEZES it per
// frame (holes at their frame-instant positions for every ray sample). The
// retarded variant instead advances each hole along its worldline c(t)=c0+v t
// and integrates (t, p_t) along the ray. Checks:
//   1. Static-limit anchor: with v = 0 (the static two-hole preview), the
//      retarded program must reproduce the frozen image bit-for-bit — the
//      integrated t/p_t machinery collapses to the frozen flow. This also
//      proves the retarded GLSL program compiles and renders under SwiftShader
//      (no JIT blow-up: a hang here would time the test out).
//   2. Retardation is real and grows as the orbit tightens: for a moving
//      system the two renders must differ (the holes ride their circular
//      worldlines, bounded to the orbit), and the difference must be LARGER
//      at a tighter/faster orbital point than at a wide/slow one — omega x
//      light-crossing-time is the controlling combination and it grows toward
//      merger.
//   3. Both renders stay finite (mean luminance in a sane band) throughout.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, stats, diffFrac } = require("./harness.cjs");

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: 600, height: 400 });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  // Render the current merger state with retarded off/on and return both
  // frames. Uses __bh.capture() (a synchronous render + canvas readback) so we
  // compare ONLY the WebGL scene — no DOM panel to dilute the pixel diff — and
  // the two frames are the exact same instant, differing only in the toggle.
  async function pair() {
    const grab = async (ret) => {
      const url = await page.evaluate((r) => {
        window.__bh.params.retarded = r;
        return window.__bh.capture();
      }, ret);
      return decodePng(Buffer.from(url.split(",")[1], "base64"));
    };
    const frozen = await grab(false);
    const ret = await grab(true);
    return { frozen, ret };
  }

  try {
    // Common low-cost render settings (the retarded flow is ~2x the frozen).
    await page.evaluate(() => {
      window.__bh.params.mode = "binary";
      window.__bh.params.maxSteps = 120;
      window.__bh.params.resolutionScale = 0.25;
    });

    // --- 1. Static-limit anchor: two static holes, v = 0 ---
    const tCompile0 = Date.now();
    await page.evaluate(() => {
      window.__bh.merger.select(null); // static preview => hole velocities are 0
      window.__bh.params.binarySep = 12;
      window.__bh.params.binaryQ = 1;
    });
    await settleFrames(page, 4);
    const s = await pair();
    const compileMs = Date.now() - tCompile0; // includes first retarded draw (JIT)
    const staticDiff = diffFrac(s.frozen, s.ret, 8);
    fs.writeFileSync(path.join(outDir, "phase16-static-frozen.png"), require("pngjs").PNG.sync.write(s.frozen));
    const staticOk = staticDiff < 2e-3;
    const staticFinite = stats(s.ret).meanLum > 1 && stats(s.ret).meanLum < 230;

    // --- 2. Moving system: retardation is real and grows with the orbit ---
    // The holes ride their circular worldlines (bounded to the orbit), so the
    // frozen/retarded difference is a genuine light-travel effect. Sample a
    // wide/slow point and a tight/fast point; the effect must be present at
    // both and larger at the tighter orbit (bigger omega x crossing time).
    await page.evaluate(() => window.__bh.merger.select("GW150914"));
    const tM = await page.evaluate(() => window.__bh.merger.tMergerGeom());

    await page.evaluate((t) => window.__bh.merger.seek(t), 0.08 * tM);
    const wide = await pair();
    const diffWide = diffFrac(wide.frozen, wide.ret, 8);

    await page.evaluate((t) => window.__bh.merger.seek(t), 0.6 * tM);
    const tight = await pair();
    const diffTight = diffFrac(tight.frozen, tight.ret, 8);
    fs.writeFileSync(path.join(outDir, "phase16-tight-frozen.png"), require("pngjs").PNG.sync.write(tight.frozen));
    fs.writeFileSync(path.join(outDir, "phase16-tight-retarded.png"), require("pngjs").PNG.sync.write(tight.ret));

    const movingFinite =
      stats(wide.frozen).meanLum > 1 && stats(wide.frozen).meanLum < 230 &&
      stats(wide.ret).meanLum > 1 && stats(wide.ret).meanLum < 230 &&
      stats(tight.frozen).meanLum > 1 && stats(tight.frozen).meanLum < 230 &&
      stats(tight.ret).meanLum > 1 && stats(tight.ret).meanLum < 230;
    // Real effect at both points, and it grows as the orbit tightens.
    const retardOk = diffWide > 2e-3 && diffTight > 0.02 && diffTight > diffWide;

    const results = {
      compile_and_first_draw_s: compileMs / 1000,
      static_diffFrac: staticDiff,
      static_limit_ok: staticOk,
      static_finite: staticFinite,
      diff_wide_slow: diffWide,
      diff_tight_fast: diffTight,
      retardation_grows_ok: retardOk,
      renders_finite: movingFinite && staticFinite,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (!staticOk || !staticFinite || !retardOk || !movingFinite)
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
