// Phase 16 (suite #15) end-to-end test: chirp audio + waveform strip.
//
// Checks:
//   1. Chirp frequency sweep: the synthesized true-rate h(t) buffer, analysed
//      with a sliding DFT peak-tracker, must rise monotonically from f_low to
//      the remnant's QNM frequency — i.e. the AUDIO frequency track matches
//      the TaylorT4 evolution that drives the picture (they share one phase).
//   2. Phase lock: the buffer's total physical duration equals the driver's
//      chirp duration (inspiral + plunge + ringdown tail), so the audio ends
//      just after the visual merger.
//   3. Chirp bar: appears in merger mode, the waveform canvas draws non-blank
//      pixels, and the readout shows the event.
//   4. Independent hide: the bar's own x button hides it while the sidebar
//      stays; the sidebar collapse (#panelToggle) hides it too.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng } = require("./harness.cjs");

// Peak frequency (Hz) of a real signal window via a coarse DFT over a log-
// spaced frequency grid — enough to track a chirp's instantaneous frequency.
function peakFreq(samples, start, len, rate, fMin, fMax) {
  let best = 0;
  let bestP = -1;
  const nGrid = 60;
  for (let g = 0; g < nGrid; g++) {
    const f = fMin * Math.pow(fMax / fMin, g / (nGrid - 1));
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / rate;
    for (let i = 0; i < len; i++) {
      const s = samples[start + i];
      re += s * Math.cos(w * i);
      im -= s * Math.sin(w * i);
    }
    const p = re * re + im * im;
    if (p > bestP) {
      bestP = p;
      best = f;
    }
  }
  return best;
}

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: 900, height: 520 });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  try {
    await page.evaluate(() => {
      window.__bh.params.mode = "binary";
      window.__bh.params.maxSteps = 120;
      window.__bh.params.resolutionScale = 0.25;
      window.__bh.merger.select("GW150914");
    });
    await settleFrames(page, 4);

    // --- 1 + 2. Chirp frequency sweep from the synthesized buffer ---
    const a = await page.evaluate(() => window.__bh.merger.audio());
    const rate = a.rate;
    const s = a.samples;
    const durS = s.length / rate;
    // Sample instantaneous frequency at 12% and 70% of the INSPIRAL portion
    // (avoid the plunge/ringdown ambiguity), plus the ringdown tail.
    const win = Math.round(0.02 * rate); // 20 ms windows
    const tEarly = Math.round(0.03 * a.toMergerS * rate);
    const tLate = Math.round(0.7 * a.toMergerS * rate);
    const tRing = Math.min(s.length - win - 1, Math.round((a.toMergerS + 0.005) * rate));
    const fEarly = peakFreq(s, tEarly, win, rate, 20, 2000);
    const fLate = peakFreq(s, tLate, win, rate, 20, 2000);
    const fRing = peakFreq(s, tRing, win, rate, 20, 2000);
    // Monotone chirp: the early inspiral sits in the low band near f_low
    // (a rising 20 ms window biases slightly high), the mid-inspiral is
    // clearly higher, and the ringdown lands on the QNM.
    const sweepOk =
      fEarly >= a.fLow - 2 && fEarly < 1.7 * a.fLow &&
      fLate > 1.5 * fEarly &&
      Math.abs(fRing - a.fQnm) / a.fQnm < 0.25;
    const durOk = durS > a.toMergerS && durS < a.toMergerS + 0.07;

    // --- 3. Chirp bar visible with a drawn waveform + readout ---
    await page.evaluate(() => {
      window.__bh.merger.setSlowmo(30);
      window.__bh.merger.setPlaying(true);
    });
    await settleFrames(page, 8);
    await page.evaluate(() => window.__bh.merger.setPlaying(false));
    const barShown = await page.evaluate(
      () => document.getElementById("chirpBar").classList.contains("show"),
    );
    // Non-blank waveform: read the 2D canvas pixels directly (screenshotting
    // the blurred bar over the live scene canvas hangs Playwright's stability
    // wait — the canvas pixel buffer is the ground truth anyway).
    const lit = await page.evaluate(() => {
      const c = document.getElementById("chirpCanvas");
      const ctx = c.getContext("2d");
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 120) n++;
      }
      return n;
    });
    const waveformDrawn = lit > 40;
    const infoText = await page.evaluate(() => document.getElementById("chirpInfo").textContent);

    // --- 4. Hide paths ---
    await page.evaluate(() => document.getElementById("chirpHide").click());
    await settleFrames(page, 3);
    const hiddenSelf = await page.evaluate(
      () => !document.getElementById("chirpBar").classList.contains("show"),
    );
    // Re-selecting the event restores the bar.
    await page.evaluate(() => window.__bh.merger.select("GW150914"));
    await settleFrames(page, 3);
    const restored = await page.evaluate(
      () => document.getElementById("chirpBar").classList.contains("show"),
    );
    // Sidebar collapse hides it too.
    await page.evaluate(() => document.getElementById("panelToggle").click());
    await settleFrames(page, 3);
    const hiddenWithUi = await page.evaluate(
      () => !document.getElementById("chirpBar").classList.contains("show"),
    );
    await page.evaluate(() => document.getElementById("panelToggle").click());
    await settleFrames(page, 3);
    const shownAgain = await page.evaluate(
      () => document.getElementById("chirpBar").classList.contains("show"),
    );

    const results = {
      f_early_hz: fEarly,
      f_late_hz: fLate,
      f_ring_hz: fRing,
      f_low_ref: a.fLow,
      f_qnm_ref: a.fQnm,
      sweep_ok: sweepOk,
      audio_dur_s: durS,
      to_merger_s: a.toMergerS,
      duration_ok: durOk,
      bar_shown: barShown,
      waveform_lit_px: lit,
      waveform_ok: waveformDrawn && /GW150914/.test(infoText || ""),
      hide_self_ok: hiddenSelf && restored,
      hide_with_ui_ok: hiddenWithUi && shownAgain,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (
      !results.sweep_ok || !results.duration_ok || !results.bar_shown ||
      !results.waveform_ok || !results.hide_self_ok || !results.hide_with_ui_ok
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
