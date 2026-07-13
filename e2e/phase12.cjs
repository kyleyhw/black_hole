// Phase 12 end-to-end test: educational/UX round.
//
// Checks:
//   1. Mass scale-invariance (the physics behind "the mass slider changes
//      nothing visible"): moving M from 10 to 1e6 Msun changes ZERO pixels
//      but does change the physical-unit readout text.
//   2. Coordinate-grid overlay toggles pixels.
//   3. Free-fall stop: the Release button becomes "Stop free fall" while
//      falling; clicking it stops the fall mid-flight (camera keeps its
//      position rather than resetting).
//   4. "Learn more" (i) buttons open the shared modal with content; the
//      modal closes.
//   5. The sidebar collapses and reopens via the #panelToggle tab.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, diffFrac } = require("./harness.cjs");

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: 320, height: 240 });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  try {
    await page.evaluate(() => {
      const bh = window.__bh;
      bh.params.maxSteps = 250;
      bh.params.resolutionScale = 0.5;
      bh.params.spin = 0.6;
      // Disk off: its noise pattern advects with time, which would confound
      // the mass-invariance pixel comparison. The static lensed sky is the
      // clean scale-invariance witness.
      bh.params.diskOn = false;
      bh.camera.azimuth = 0;
      bh.camera.elevation = 0.12;
      bh.camera.radius = 18;
    });

    // --- 1. Mass scale-invariance ---
    const hideStyle = await page.addStyleTag({
      content: "#panel,#fps,#footer,#panelToggle{display:none !important}",
    });
    await settleFrames(page, 4);
    const m10 = decodePng(await page.screenshot());
    const readout10 = await page.evaluate(() => document.querySelector("#panel .readout").textContent);
    await page.evaluate(() => (window.__bh.params.massMsun = 1e6));
    await settleFrames(page, 4);
    const m1e6 = decodePng(await page.screenshot());
    await page.waitForTimeout(250); // readout refreshes at 10 Hz
    const readout1e6 = await page.evaluate(() => document.querySelector("#panel .readout").textContent);
    const massPixelDiff = diffFrac(m10, m1e6, 4);
    await hideStyle.evaluate((s) => s.remove());

    // --- 2. Grid overlay ---
    const hide2 = await page.addStyleTag({
      content: "#panel,#fps,#footer,#panelToggle{display:none !important}",
    });
    await page.evaluate(() => (window.__bh.params.gridOn = true));
    await settleFrames(page, 4);
    const gridShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase12-grid.png"), gridShot);
    const gridDiff = diffFrac(m1e6, decodePng(gridShot), 10);
    await page.evaluate(() => (window.__bh.params.gridOn = false));
    await hide2.evaluate((s) => s.remove());

    // --- 3. Free-fall stop ---
    await page.evaluate(() => {
      window.__bh.camera.radius = 10;
      window.__bh.freefall.timeScale = 4;
      window.__bh.release();
    });
    await page.waitForTimeout(400);
    await settleFrames(page, 3);
    const btnDuring = await page.evaluate(() => document.getElementById("freefallBtn").textContent);
    const rBefore = await page.evaluate(() => window.__bh.camera.radius);
    await page.evaluate(() => document.getElementById("freefallBtn").click()); // Stop
    const stopped = await page.evaluate(() => !window.__bh.freefall.active);
    await settleFrames(page, 3);
    const rAfter = await page.evaluate(() => window.__bh.camera.radius);
    const stayedPut = Math.abs(rAfter - rBefore) < 0.5 && rAfter < 12; // no reset to 18
    await page.waitForTimeout(250);
    const btnAfter = await page.evaluate(() => document.getElementById("freefallBtn").textContent);

    // --- 4. Learn-more modal (first info button = the notation glossary) ---
    await page.evaluate(() => document.querySelector("#panel button.info").click());
    const learn = await page.evaluate(() => {
      const m = document.getElementById("learn");
      return { open: m?.classList.contains("open"), text: m?.textContent ?? "" };
    });
    // Every symbol used in the UI must be defined here: spot-check a, phi, and
    // the redshift factor g.
    const defines = ["spin parameter", "azimuthal angle", "redshift factor"].every((s) =>
      learn.text.includes(s),
    );
    await page.evaluate(() => document.querySelector("#learn .close").click());
    const learnClosed = await page.evaluate(
      () => !document.getElementById("learn").classList.contains("open"),
    );

    // --- 5. Sidebar collapse ---
    await page.evaluate(() => document.getElementById("panelToggle").click());
    const hidden = await page.evaluate(
      () => document.getElementById("panel").classList.contains("hidden"),
    );
    await page.evaluate(() => document.getElementById("panelToggle").click());
    const shown = await page.evaluate(
      () => !document.getElementById("panel").classList.contains("hidden"),
    );

    const results = {
      mass_pixelDiffFrac: massPixelDiff,
      mass_readout_10: readout10.slice(0, 60),
      mass_readout_1e6: readout1e6.slice(0, 60),
      mass_invariance_ok: massPixelDiff === 0 && readout10 !== readout1e6,
      grid_diffFrac: gridDiff,
      grid_ok: gridDiff > 0.01,
      freefall_button_during: btnDuring,
      freefall_button_after: btnAfter,
      freefall_stop_ok:
        btnDuring.includes("Stop") && stopped && stayedPut && btnAfter.includes("Release"),
      learn_open: learn.open,
      learn_has_content: learn.text.length > 100,
      learn_defines_symbols: defines,
      learn_ok: learn.open && learn.text.length > 100 && defines && learnClosed,
      collapse_ok: hidden && shown,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (
      !results.mass_invariance_ok || !results.grid_ok || !results.freefall_stop_ok ||
      !results.learn_ok || !results.collapse_ok
    )
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
