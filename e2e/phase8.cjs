// Phase 8 end-to-end test: tetrad camera, redshifted starfield, free fall.
//
// Checks:
//   1. Local-frame shadow: with tetrad ray initialization the textbook
//      formula applies directly — sin(theta) = (3*sqrt(3)M/r0)sqrt(1-2M/r0)
//      at a=0, r0=18 predicts 44.10 px here (the old coordinate camera gave
//      37.27 px; see derivations.md §4 and §8). Tolerance 3%.
//   2. q_t diagnostic: for the central (radial) pixel of a static camera at
//      a=0, q_t = sqrt(1 - 2M/r) exactly (E_infinity per unit local energy).
//   3. Sky redshift toggle changes the background visibly at r = 6 M
//      (g* = 1.22, brightness x2.25).
//   4. Free fall: released at r = 6 (a = 0.9), the camera radius decreases
//      monotonically, frame dragging drifts the azimuth (prograde, phi
//      increasing), and on plunge termination the camera resets to orbit.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, diffFrac } = require("./harness.cjs");

const W = 240;
const H = 180;

function capturedMask(png) {
  const mask = new Uint8Array(png.width * png.height);
  for (let i = 0; i < mask.length; i++) {
    const r = png.data[i * 4];
    const b = png.data[i * 4 + 2];
    mask[i] = b > 160 && r < 80 ? 1 : 0;
  }
  return mask;
}

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: W, height: H });
  await page.addStyleTag({ content: "#panel,#fps,#footer{display:none !important}" });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  const setState = (o) =>
    page.evaluate((s) => {
      const bh = window.__bh;
      Object.assign(bh.params, s.params ?? {});
      Object.assign(bh.camera, s.camera ?? {});
    }, o);

  try {
    // --- 1. Local-frame shadow size ---
    await setState({
      params: { spin: 0, debugView: 3, maxSteps: 600, diskOn: false, resolutionScale: 1 },
      camera: { azimuth: 0, elevation: 0, radius: 18 },
    });
    await settleFrames(page, 4);
    const shot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase8-finalr-a0.png"), shot);
    const png = decodePng(shot);
    let area = 0;
    const mask = capturedMask(png);
    for (let i = 0; i < mask.length; i++) area += mask[i];
    const measured = Math.sqrt(area / Math.PI);
    const r0 = 18;
    const theta = Math.asin(((3 * Math.sqrt(3)) / r0) * Math.sqrt(1 - 2 / r0));
    const predicted = (png.height / 2) * (Math.tan(theta) / Math.tan(Math.PI / 6));
    const shadowErr = Math.abs(measured - predicted) / predicted;

    // --- 2. q_t of the central ray ---
    const qt = await page.evaluate(() => window.__bh.centerQt());
    const qtExpected = Math.sqrt(1 - 2 / r0);
    const qtErr = Math.abs(qt - qtExpected);

    // --- 2b. Moving-observer Doppler (physical camera worldline) ---
    // A velocity toward the forward sky must shift its q_t oppositely to a
    // velocity away (aberration/Doppler), and v = 0 must reproduce the static
    // observer exactly (movingObserver(v=0) ≡ staticObserver).
    const mv = await page.evaluate(() => {
      const fwd = window.__bh.camera.basis().forward; // radial, toward the hole
      const sp = 0.3; // coordinate 3-velocity magnitude (0.3c, sub-luminal)
      const to = [fwd[0] * sp, fwd[1] * sp, fwd[2] * sp];
      const away = [-to[0], -to[1], -to[2]];
      return {
        stat: window.__bh.centerQt(),
        zero: window.__bh.centerQtMoving([0, 0, 0]),
        toward: window.__bh.centerQtMoving(to),
        away: window.__bh.centerQtMoving(away),
      };
    });
    const movingZeroOk = Math.abs(mv.zero - mv.stat) < 1e-12;
    const dopplerOk =
      Math.abs(mv.toward - mv.stat) > 1e-3 &&
      (mv.toward - mv.stat) * (mv.away - mv.stat) < 0;

    // --- 3. Sky-shift toggle ---
    // r = 12: g* = 1.095 (brightness x1.44) with plenty of visible sky —
    // at r = 6 the shadow's 45-degree angular radius fills the whole frame.
    await setState({
      params: { spin: 0, debugView: 0, maxSteps: 300, diskOn: false, skyShift: false },
      camera: { radius: 12, elevation: 0.3 },
    });
    await settleFrames(page, 4);
    const noShift = decodePng(await page.screenshot());
    await setState({ params: { skyShift: true } });
    await settleFrames(page, 4);
    const shiftShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase8-skyshift-r6.png"), shiftShot);
    const shiftDiff = diffFrac(noShift, decodePng(shiftShot), 10);

    // --- 4. Free fall (a = 0.9, fast time scale for the test) ---
    await setState({
      params: { spin: 0.9, maxSteps: 150, resolutionScale: 0.25, diskOn: true },
      camera: { azimuth: 0, elevation: 0.1, radius: 6 },
    });
    await page.evaluate(() => {
      window.__bh.freefall.timeScale = 12;
      window.__bh.release();
    });
    const radii = [];
    const azimuths = [];
    let resetSeen = false;
    for (let i = 0; i < 30; i++) {
      await settleFrames(page, 1);
      const s = await page.evaluate(() => ({
        r: window.__bh.camera.radius,
        az: window.__bh.camera.azimuth,
        active: window.__bh.freefall.active,
      }));
      radii.push(s.r);
      azimuths.push(s.az);
      if (!s.active && s.r > 17) {
        resetSeen = true; // plunged and reset to the default orbit radius
        break;
      }
    }
    const preReset = radii.filter((r) => r < 17);
    const decreasing = preReset.every((r, i) => i === 0 || r <= preReset[i - 1] + 1e-9);
    const maxAz = Math.max(...azimuths.map(Math.abs));

    const results = {
      shadow_measured_px: measured,
      shadow_predicted_px: predicted,
      shadow_rel_err: shadowErr,
      shadow_ok: shadowErr < 0.03,
      center_qt: qt,
      center_qt_expected: qtExpected,
      qt_ok: qtErr < 1e-6,
      moving_qt_static: mv.stat,
      moving_qt_toward: mv.toward,
      moving_qt_away: mv.away,
      moving_zero_ok: movingZeroOk,
      doppler_ok: dopplerOk,
      skyshift_diffFrac: shiftDiff,
      skyshift_ok: shiftDiff > 0.02,
      freefall_min_r: Math.min(...radii),
      freefall_decreasing: decreasing,
      freefall_azimuth_drift: maxAz,
      freefall_reset: resetSeen,
      freefall_ok: decreasing && maxAz > 1e-3 && resetSeen,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (
      !results.shadow_ok || !results.qt_ok || !results.skyshift_ok ||
      !results.freefall_ok || !results.moving_zero_ok || !results.doppler_ok
    )
      process.exitCode = 1;
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
