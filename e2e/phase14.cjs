// Phase 15 (suite #14) end-to-end test: PN-driven merger animation.
//
// Checks:
//   1. Cross-language PN parity: the TS TaylorT4 driver's inspiral duration
//      for GW150914 (35 Hz -> ISCO, detector frame) must match the Python
//      suite's validated value 0.0905 s within 1% — pins the line-parallel
//      transcription of the coefficients and integrator.
//   2. Initial state: separation = 1/x(f_low) ~ 8.68 M, f_GW = 35 Hz.
//   3. Dynamics: playing the animation, separation shrinks monotonically and
//      f_GW rises monotonically through the inspiral into the plunge.
//   4. Merger completes: the timeline reaches ringdown at the remnant's QNM
//      frequency (249.3 Hz from the Berti-Cardoso-Will fits), the image
//      collapses to a single central shadow, and every sampled frame stays
//      finite (no NaN black/white blowouts while the boost matrices are live).
//   5. Controls: pause freezes the clock; restart rewinds to f_low.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, stats } = require("./harness.cjs");

const W = 320;
const H = 240;

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

  try {
    await page.evaluate(() => {
      const bh = window.__bh;
      bh.params.maxSteps = 250;
      bh.params.resolutionScale = 0.4;
      bh.params.diskOn = false;
      bh.camera.azimuth = 0;
      bh.camera.elevation = 0.35; // above the plane: both holes visible all orbit
      bh.camera.radius = 40;
      bh.merger.select("GW150914");
    });
    await settleFrames(page, 3);

    // --- 1 + 2. Driver timing vs Python; initial state ---
    const info = await page.evaluate(() => window.__bh.merger.info());
    const st0 = await page.evaluate(() => window.__bh.merger.state());
    const pnOk = Math.abs(info.inspiralS - 0.0905) / 0.0905 < 0.01;
    const initOk = Math.abs(st0.separation - 8.68) < 0.15 && Math.abs(st0.fGwHz - 35.0) < 0.3;

    // --- 3 + 4. Play through inspiral -> plunge -> ringdown ---
    // slowmo 30 with the 0.1 s dt clamp gives ~3.3 ms physical per rendered
    // frame; several frames render per sampling iteration (screenshot cost),
    // so this yields ~10+ samples across the 140 ms timeline.
    await page.evaluate(() => {
      window.__bh.merger.setSlowmo(30);
      window.__bh.merger.setPlaying(true);
    });
    const seps = [];
    const freqs = [];
    const phases = [];
    let inspiralShotDone = false;
    let finiteOk = true;
    let ringPng = null;
    for (let i = 0; i < 80; i++) {
      await settleFrames(page, 1);
      const st = await page.evaluate(() => window.__bh.merger.state());
      phases.push(st.phase);
      if (st.phase !== "ringdown") {
        seps.push(st.separation);
        freqs.push(st.fGwHz);
      }
      const shot = await page.screenshot();
      const mean = stats(decodePng(shot)).meanLum;
      if (!(mean > 2 && mean < 220)) finiteOk = false;
      if (!inspiralShotDone && st.phase === "inspiral" && st.separation < 8) {
        fs.writeFileSync(path.join(outDir, "phase14-inspiral.png"), shot);
        inspiralShotDone = true;
      }
      if (st.phase === "plunge" && !fs.existsSync(path.join(outDir, "phase14-plunge.png")))
        fs.writeFileSync(path.join(outDir, "phase14-plunge.png"), shot);
      if (st.phase === "ringdown") {
        fs.writeFileSync(path.join(outDir, "phase14-ringdown.png"), shot);
        ringPng = decodePng(shot);
        break;
      }
    }
    await page.evaluate(() => window.__bh.merger.setPlaying(false));
    // Monotonicity with a small tolerance for interpolation jitter.
    const sepMono = seps.every((s, i) => i === 0 || s <= seps[i - 1] + 1e-3);
    const freqMono = freqs.every((f, i) => i === 0 || f >= freqs[i - 1] - 1e-2);
    const stEnd = await page.evaluate(() => window.__bh.merger.state());
    const qnmOk = stEnd.phase === "ringdown" && Math.abs(stEnd.fGwHz - 249.3) < 5;
    const ringDark = ringPng ? darkFrac(ringPng, W / 2, H / 2, 14) : 0;

    // --- 5. Pause freezes; restart rewinds ---
    await page.evaluate(() => window.__bh.merger.restart());
    await settleFrames(page, 2);
    const stR = await page.evaluate(() => window.__bh.merger.state());
    const sepA = stR.separation;
    await settleFrames(page, 3); // paused: clock must not advance
    const stB = await page.evaluate(() => window.__bh.merger.state());
    const controlsOk =
      Math.abs(sepA - 8.68) < 0.15 && Math.abs(stB.separation - sepA) < 1e-9;

    const results = {
      pn_inspiral_s: info.inspiralS,
      pn_python_ref_s: 0.0905,
      pn_ok: pnOk,
      init_sep_M: st0.separation,
      init_fgw_hz: st0.fGwHz,
      init_ok: initOk,
      samples: seps.length,
      sep_monotonic: sepMono,
      fgw_monotonic: freqMono,
      dynamics_ok: sepMono && freqMono && seps.length >= 5,
      end_phase: stEnd.phase,
      end_fgw_hz: stEnd.fGwHz,
      ring_center_dark: ringDark,
      frames_finite: finiteOk,
      merger_ok: qnmOk && ringDark > 0.5 && finiteOk,
      controls_ok: controlsOk,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (
      !results.pn_ok || !results.init_ok || !results.dynamics_ok ||
      !results.merger_ok || !results.controls_ok
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
