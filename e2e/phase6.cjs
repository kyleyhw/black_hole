// Phase 6 end-to-end test: UI panel, presets, overlays, bloom pipeline.
//
// Checks:
//   1. Page loads with panel, FPS counter, and footer; no page errors; the
//      HDR pipeline (float targets -> blur -> ACES composite) renders a
//      non-black frame.
//   2. Preset buttons drive params (click "Near-extremal" -> spin 0.998,
//      camera moves) and the spin slider drives params.spin.
//   3. Overlays change pixels when enabled (ergosphere + photon rings).
//   4. Bloom strength changes the rendered image.
//   5. Resolution scale 0.25x still renders (no FBO breakage).
//   6. Screenshot button produces a PNG download.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, stats, diffFrac } = require("./harness.cjs");

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: 480, height: 360 });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  const setView = () =>
    page.evaluate(() => {
      const bh = window.__bh;
      bh.params.maxSteps = 300;
      bh.params.resolutionScale = 0.5;
      bh.camera.azimuth = 0;
      bh.camera.elevation = 0.12;
      bh.camera.radius = 18;
    });

  try {
    // --- 1. Chrome loads ---
    const chrome = await page.evaluate(() => ({
      panel: !!document.getElementById("panel"),
      fps: !!document.getElementById("fps"),
      footer: !!document.getElementById("footer"),
      sliders: document.querySelectorAll("#panel input[type=range]").length,
      presets: document.querySelectorAll("#panel button.preset").length,
    }));
    // --- 2. Preset + slider drive params (before hiding the chrome) ---
    await page.click("#panel button.preset:nth-of-type(3)"); // Near-extremal
    const afterPreset = await page.evaluate(() => ({
      spin: window.__bh.params.spin,
      radius: window.__bh.camera.radius,
    }));
    await page.evaluate(() => {
      const s = document.querySelector("#panel input[type=range]");
      s.value = "0.2";
      s.dispatchEvent(new Event("input"));
    });
    const afterSlider = await page.evaluate(() => window.__bh.params.spin);

    // Hide UI chrome for all pixel measurements below.
    await page.addStyleTag({
      content: "#panel,#fps,#footer{display:none !important}",
    });
    await setView();
    await page.evaluate(() => (window.__bh.params.spin = 0.6));
    await settleFrames(page, 6);
    const base = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase6-default.png"), base);
    const basePng = decodePng(base);
    const baseStats = stats(basePng);

    // --- 3. Overlays ---
    await setView();
    await page.evaluate(() => {
      window.__bh.params.spin = 0.9;
      window.__bh.params.ergoOn = false;
      window.__bh.params.photonOn = false;
    });
    await settleFrames(page, 4);
    const noOv = decodePng(await page.screenshot());
    await page.evaluate(() => {
      window.__bh.params.ergoOn = true;
      window.__bh.params.photonOn = true;
    });
    await settleFrames(page, 4);
    const withOvShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase6-overlays.png"), withOvShot);
    const ovDiff = diffFrac(noOv, decodePng(withOvShot), 8);
    await page.evaluate(() => {
      window.__bh.params.ergoOn = false;
      window.__bh.params.photonOn = false;
    });

    // --- 4. Bloom ---
    await page.evaluate(() => (window.__bh.params.bloomStrength = 0));
    await settleFrames(page, 4);
    const noBloom = decodePng(await page.screenshot());
    await page.evaluate(() => (window.__bh.params.bloomStrength = 1.8));
    await settleFrames(page, 4);
    const bloomDiff = diffFrac(noBloom, decodePng(await page.screenshot()), 12);
    await page.evaluate(() => (window.__bh.params.bloomStrength = 0.55));

    // --- 5. Resolution scale ---
    await page.evaluate(() => (window.__bh.params.resolutionScale = 0.25));
    await settleFrames(page, 4);
    const lowRes = stats(decodePng(await page.screenshot()));

    // --- 6. Screenshot button (clicked via JS: the panel is display:none) ---
    const downloadP = page.waitForEvent("download", { timeout: 15000 });
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("#panel button.preset");
      buttons[buttons.length - 1].click();
    });
    const download = await downloadP;
    const dlName = download.suggestedFilename();

    const results = {
      chrome,
      chrome_ok:
        chrome.panel && chrome.fps && chrome.footer && chrome.sliders >= 6 && chrome.presets === 4,
      base_meanLum: baseStats.meanLum,
      renders_ok: baseStats.meanLum > 2,
      preset_spin: afterPreset.spin,
      preset_ok: Math.abs(afterPreset.spin - 0.998) < 1e-9 && afterPreset.radius === 12,
      slider_spin: afterSlider,
      slider_ok: Math.abs(afterSlider - 0.2) < 1e-9,
      overlay_diffFrac: ovDiff,
      overlays_ok: ovDiff > 0.02,
      bloom_diffFrac: bloomDiff,
      bloom_ok: bloomDiff > 0.005,
      lowres_ok: lowRes.meanLum > 2,
      download_name: dlName,
      download_ok: dlName.endsWith(".png"),
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    const ok =
      results.chrome_ok && results.renders_ok && results.preset_ok && results.slider_ok &&
      results.overlays_ok && results.bloom_ok && results.lowres_ok && results.download_ok;
    if (!ok) process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit();
  }
})();
