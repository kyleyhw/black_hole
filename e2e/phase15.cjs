// Suite #15 — real-data chirp strip (amplitude vs time), no audio.
//
// The merger strip no longer synthesizes or plays sound. It plots the ACTUAL
// GW150914 detection: the H1 observed strain (whitened, band-passed 35-350 Hz)
// with the released numerical-relativity reconstruction overlaid, embedded in
// src/gw150914_chirp.json. Checks:
//   1. Real data present & chirps: the embedded reconstruction's zero-crossing
//      rate rises from early inspiral to merger (a genuine frequency sweep in
//      the real signal), and the observed trace is present too.
//   2. Strip shows for GW150914 (real data) and the 2D canvas draws the trace;
//      the readout names the event and detector.
//   3. Other events have no real strain -> the strip is hidden (animation still
//      runs silently).
//   4. No audio: the old audio hook is gone.
//   5. Hide paths: the strip's x hides it (re-select restores), and the sidebar
//      collapse hides it too.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames } = require("./harness.cjs");

function zc(a, lo, hi) {
  let n = 0;
  for (let i = lo + 1; i < hi; i++) if (Math.sign(a[i]) !== Math.sign(a[i - 1])) n++;
  return n;
}

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: 900, height: 520 });
  fs.mkdirSync(path.join(__dirname, "screenshots"), { recursive: true });

  try {
    await page.evaluate(() => {
      window.__bh.params.mode = "binary";
      window.__bh.params.maxSteps = 120;
      window.__bh.params.resolutionScale = 0.25;
      window.__bh.merger.select("GW150914");
    });
    await settleFrames(page, 4);

    // --- 1. Real data present and it chirps ---
    const c = await page.evaluate(() => window.__bh.merger.chirp());
    const recon = c.reconstruction;
    const n = recon.length;
    const zEarly = zc(recon, 0, Math.floor(n / 3));
    const zMerge = zc(recon, Math.floor((2 * n) / 3), n);
    const dataOk =
      c.hasData && c.event === "GW150914" && n === c.n && n > 100 &&
      c.observed.length === n;
    const sweepOk = zMerge > zEarly * 1.5 && zMerge > 6;

    // --- 2. Strip shown for GW150914 with a drawn trace + readout ---
    await page.evaluate(() => {
      window.__bh.merger.setSlowmo(30);
      window.__bh.merger.setPlaying(true);
    });
    await settleFrames(page, 8);
    await page.evaluate(() => window.__bh.merger.setPlaying(false));
    const barShown = await page.evaluate(
      () => document.getElementById("chirpBar").classList.contains("show"),
    );
    const lit = await page.evaluate(() => {
      const cv = document.getElementById("chirpCanvas");
      const ctx = cv.getContext("2d");
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let k = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) k++;
      return k;
    });
    const infoText = await page.evaluate(() => document.getElementById("chirpInfo").textContent);
    const traceOk = lit > 60 && /GW150914/.test(infoText || "") && /strain/.test(infoText || "");

    // --- 3. Other events: no real data -> strip hidden ---
    await page.evaluate(() => window.__bh.merger.select("GW151226"));
    await settleFrames(page, 3);
    const otherHidden = await page.evaluate(
      () =>
        !document.getElementById("chirpBar").classList.contains("show") &&
        !window.__bh.merger.chirp().hasData,
    );

    // --- 4. No audio ---
    const noAudio = await page.evaluate(() => window.__bh.merger.audio === undefined);

    // --- 5. Hide paths (back on GW150914) ---
    await page.evaluate(() => window.__bh.merger.select("GW150914"));
    await settleFrames(page, 3);
    await page.evaluate(() => document.getElementById("chirpHide").click());
    await settleFrames(page, 2);
    const hiddenSelf = await page.evaluate(
      () => !document.getElementById("chirpBar").classList.contains("show"),
    );
    await page.evaluate(() => window.__bh.merger.select("GW150914"));
    await settleFrames(page, 2);
    const restored = await page.evaluate(
      () => document.getElementById("chirpBar").classList.contains("show"),
    );
    await page.evaluate(() => document.getElementById("panelToggle").click());
    await settleFrames(page, 2);
    const hiddenWithUi = await page.evaluate(
      () => !document.getElementById("chirpBar").classList.contains("show"),
    );
    await page.evaluate(() => document.getElementById("panelToggle").click());
    await settleFrames(page, 2);
    const shownAgain = await page.evaluate(
      () => document.getElementById("chirpBar").classList.contains("show"),
    );

    const results = {
      zc_early: zEarly,
      zc_merger: zMerge,
      data_ok: dataOk,
      sweep_ok: sweepOk,
      bar_shown: barShown,
      trace_lit_px: lit,
      trace_ok: traceOk,
      other_event_hidden: otherHidden,
      no_audio: noAudio,
      hide_self_ok: hiddenSelf && restored,
      hide_with_ui_ok: hiddenWithUi && shownAgain,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (
      !dataOk || !sweepOk || !barShown || !traceOk || !otherHidden || !noAudio ||
      !(hiddenSelf && restored) || !(hiddenWithUi && shownAgain)
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
