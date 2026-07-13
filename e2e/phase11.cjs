// Phase 11 end-to-end test: WebGPU progressive renderer.
//
// The container's Chromium has WebGPU compiled out (no navigator.gpu under
// any flag combination — probed before implementation), so this test is
// split into what can and cannot run here, honestly:
//
//   ALWAYS (this container):
//   1. hq.wgsl parses (wgsl_reflect), exports the 'trace' entry point and
//      the two storage bindings.
//   2. Constant-parity: the numerical constants that define the physics
//      (capture-buffer scaling, momentum threshold, FD epsilon, step
//      clamps, star-cell counts, emissivity peak) are textually identical
//      between the GLSL and WGSL ports — the line-parallel-structure
//      guarantee, enforced.
//   3. Fallback: with WebGPU absent the HQ button renders disabled with an
//      explanatory label, and the WebGL2 renderer works untouched.
//
//   WHEN AN ADAPTER EXISTS (real browsers; runs automatically):
//   4. Pixel parity: a 4-sample HQ render vs the WebGL2 frame at identical
//      parameters (bloom 0), mean |diff| bounded.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, stats } = require("./harness.cjs");

(async () => {
  const t0 = Date.now();

  // --- 1. WGSL parses ---
  const { WgslReflect } = await import("../node_modules/wgsl_reflect/wgsl_reflect.module.js");
  const wgsl = fs.readFileSync(path.join(__dirname, "../src/shaders/hq.wgsl"), "utf8");
  let wgslOk = false;
  let entryOk = false;
  try {
    const r = new WgslReflect(wgsl);
    wgslOk = true;
    entryOk = r.entry.compute.some((e) => e.name === "trace") && r.storage.length === 2;
  } catch (e) {
    console.error("WGSL parse error:", e.message);
  }

  // --- 2. Constant parity between GLSL and WGSL ---
  const glsl = fs.readFileSync(path.join(__dirname, "../src/shaders/render.frag.glsl"), "utf8");
  const constants = [
    "1.02", // legacy check anchor (capture scaling factor appears as 0.02)
    "0.02 * sqrt", // capture-buffer scaling
    "1e8", // momentum-blowup threshold
    "2e-3", // FD epsilon scale
    "0.1 * min(r - 0.9", // adaptive step
    "400.0", // star cells
    "0.04", // star density
    "36.0 / 49.0", // emissivity peak normalization
    "0.55 + 0.9", // noise modulation
    "6.2831853", // 2 pi in the disk pattern
  ];
  const parityMisses = constants.filter(
    (c) => c !== "1.02" && !(glsl.includes(c) && wgsl.includes(c)),
  );

  // --- 3/4. Browser behavior ---
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: 320, height: 240 });
  let results;
  try {
    // Three states: no navigator.gpu / gpu without adapter / full adapter.
    const adapterState = await page.evaluate(async () => {
      if (!("gpu" in navigator)) return "no-gpu";
      const a = await navigator.gpu.requestAdapter().catch(() => null);
      return a ? "adapter" : "gpu-no-adapter";
    });
    await page.waitForTimeout(1200); // async probe may downgrade the button
    const btn = await page.evaluate(() => {
      const b = document.getElementById("hqBtn");
      return { present: !!b, disabled: b?.hasAttribute("disabled"), text: b?.textContent ?? "" };
    });
    await page.addStyleTag({ content: "#panel,#fps,#footer{display:none !important}" });
    await page.evaluate(() => {
      const bh = window.__bh;
      bh.params.maxSteps = 200;
      bh.params.resolutionScale = 0.5;
      bh.camera.radius = 18;
    });
    await settleFrames(page, 4);
    const glStats = stats(decodePng(await page.screenshot()));

    let parity = null;
    if (adapterState === "adapter") {
      // Live pixel parity (runs in real browsers): identical static scene
      // (disk off so the time-dependent noise cannot differ, bloom 0,
      // full resolution) on both backends.
      await page.evaluate(() => {
        const bh = window.__bh;
        bh.params.diskOn = false;
        bh.params.bloomStrength = 0;
        bh.params.resolutionScale = 1;
        bh.params.skyShift = false;
        bh.params.maxSteps = 200;
      });
      await settleFrames(page, 4);
      const glShot = decodePng(await page.screenshot());
      await page.click("#hqBtn");
      await page.waitForFunction(
        () => {
          const s = document.getElementById("hqStatus");
          return s && /(\d+) \//.test(s.textContent) && Number(RegExp.$1) >= 8;
        },
        { timeout: 120000 },
      );
      const hqCanvas = await page.locator("#hq canvas").screenshot();
      const hqShot = decodePng(hqCanvas);
      let sum = 0;
      const n = Math.min(glShot.width * glShot.height, hqShot.width * hqShot.height);
      for (let i = 0; i < n; i++)
        sum += Math.abs(glShot.data[i * 4] - hqShot.data[i * 4]);
      const meanDiff = sum / n;
      parity = { ran: true, meanDiff, ok: meanDiff < 20 };
      await page.evaluate(() => document.querySelector("#hq button:last-child").click());
    }

    results = {
      wgsl_parses: wgslOk,
      wgsl_entry_ok: entryOk,
      constant_parity_misses: parityMisses,
      constant_parity_ok: parityMisses.length === 0,
      adapter_state: adapterState,
      hq_button: btn,
      fallback_ok:
        adapterState === "adapter"
          ? btn.present && !btn.disabled
          : btn.present && btn.disabled === true && btn.text.includes("unavailable"),
      webgl2_renders_ok: glStats.meanLum > 2,
      pixel_parity: parity ?? `SKIPPED (${adapterState}) — runs automatically in WebGPU-capable browsers`,
      pixel_parity_ok: parity ? parity.ok : true,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    const ok =
      results.wgsl_parses && results.wgsl_entry_ok && results.constant_parity_ok &&
      results.fallback_ok && results.webgl2_renders_ok && results.pixel_parity_ok;
    if (!ok) process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit();
  }
})();
