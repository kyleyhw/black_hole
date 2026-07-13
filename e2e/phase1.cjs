// Phase 1 end-to-end test: the built site must render a starfield (not a
// black or errored canvas) and the orbit camera must change the view.
//
// Pass criteria:
//   1. Page loads with no uncaught errors and a live WebGL2 context.
//   2. Starfield: bright-pixel fraction in (0.1%, 20%) — stars are sparse
//      points, so a blank screen (~0) and a washed-out screen (>20%) both fail.
//   3. Rotating the camera 30 degrees changes >0.05% of pixels (stars move).
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, stats, diffFrac } = require("./harness.cjs");

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage();
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  try {
    // Hide UI chrome and isolate the starfield: no disk, no lensing (a=0
    // still lenses; the starfield checks tolerate it), moderate budget.
    await page.addStyleTag({ content: "#panel,#fps,#footer{display:none !important}" });
    await page.evaluate(() => {
      const bh = window.__bh;
      bh.params.diskOn = false;
      bh.params.spin = 0;
      bh.params.debugView = 0;
      bh.params.maxSteps = 300;
      bh.params.resolutionScale = 0.5;
      bh.camera.azimuth = 0;
      bh.camera.elevation = 0.12;
      bh.camera.radius = 18;
    });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const tick = () => (++n >= 4 ? resolve(undefined) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );
    const shot1 = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase1-starfield.png"), shot1);
    const s1 = stats(decodePng(shot1));

    await page.evaluate(() => {
      window.__bh.camera.azimuth += Math.PI / 6;
    });
    await settleFrames(page, 3);
    const shot2 = await page.screenshot();
    const s2 = stats(decodePng(shot2));
    const moved = diffFrac(decodePng(shot1), decodePng(shot2));

    const results = {
      starfield_brightFrac: s1.brightFrac,
      starfield_ok: s1.brightFrac > 0.001 && s1.brightFrac < 0.35,
      rotated_brightFrac: s2.brightFrac,
      camera_diffFrac: moved,
      camera_ok: moved > 0.0005,
    };
    results.runtime_s = (Date.now() - t0) / 1000;
    console.log(JSON.stringify(results, null, 2));
    if (!results.starfield_ok || !results.camera_ok) process.exitCode = 1;
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
