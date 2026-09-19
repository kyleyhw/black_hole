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

    // --- 5b. Interactive drag is a STATIC observer: dragging never aberrates ---
    // A drag moves the camera but is NOT an observer worldline. Two
    // assertions: the mapped observer speed is exactly 0 at rest, throughout a
    // real pointer drag, and after release; and the frame rendered mid-drag is
    // pixel-identical to a static render at the same camera pose (see the
    // contract note below). The retired moving-observer design aberrated the
    // view with the drag velocity, sliding the shadow off-center on every drag.
    await page.evaluate(() => {
      const c = window.__bh.camera;
      c.azimuth = 0;
      c.elevation = 0.12;
      c.radius = 18;
    });
    // The panel overlays the drag point at this width; hide the chrome so the
    // pointer reaches the canvas and the camera actually receives the drag.
    const dragHide = await page.addStyleTag({
      content: "#panel,#fps,#footer,#panelToggle{display:none !important}",
    });
    await page.evaluate(() => {
      window.__bh.params.maxSteps = 150;
      window.__bh.params.resolutionScale = 0.25;
      window.__bh.params.diskOn = false; // no disk clock => frames comparable
    });
    await settleFrames(page, 4);
    // Contract: what you see mid-drag is EXACTLY what a static render at the
    // same camera pose shows — dragging changes the pose, never the observer.
    // (The retired moving-observer design made these two frames differ by its
    // aberration.) Sky-independent and deterministic: capture a frame mid-
    // gesture, record the pose it rendered at, then after release re-render
    // statically at that pose and compare pixels. The disk is off so no
    // time-varying input (disk clock) can separate the two frames.
    const capture = async () =>
      decodePng(Buffer.from((await page.evaluate(() => window.__bh.capture())).split(",")[1], "base64"));
    const dragRestSpeed = await page.evaluate(() => window.__bh.camSpeed());
    await page.mouse.move(160, 120);
    await page.mouse.down();
    const dragSpeeds = [];
    let midImg = null;
    let midPose = null;
    for (let i = 1; i <= 25; i++) {
      await page.mouse.move(160 + i * 8, 120);
      await page.waitForTimeout(15);
      dragSpeeds.push(await page.evaluate(() => window.__bh.camSpeed()));
      if (i === 13) { // sample mid-gesture: the image and the pose it rendered at
        midImg = await capture();
        midPose = await page.evaluate(() => {
          const c = window.__bh.camera;
          return { azimuth: c.azimuth, elevation: c.elevation, radius: c.radius };
        });
      }
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    const dragAfterSpeed = await page.evaluate(() => window.__bh.camSpeed());
    // Static re-render at the EXACT mid-drag pose. The orbit camera's inertial
    // coast (velAz * e^(-6t)) is still decaying after release and capture()'s
    // own update(dt) would nudge the pose by it (~1e-4 rad, a sub-pixel star
    // shift that flips a few % of pixels) — so zero the velocity first via
    // reset(), then set the pose. Mid-drag the same update() returned early
    // (dragging), so that frame was rendered at exactly this pose too.
    await page.evaluate((p) => {
      const c = window.__bh.camera;
      c.reset(); // zeroes velAz/velEl (also resets pose; overwritten next)
      c.azimuth = p.azimuth; c.elevation = p.elevation; c.radius = p.radius;
    }, midPose);
    const refImg = await capture();
    const dragViewDiff = diffFrac(midImg, refImg, 12);
    await page.evaluate(() => {
      window.__bh.params.maxSteps = 250;
      window.__bh.params.resolutionScale = 0.5;
      window.__bh.params.diskOn = true;
    });
    await dragHide.evaluate((s) => s.remove());
    const dragMax = Math.max(...dragSpeeds);
    let dragMaxJump = 0;
    for (let i = 1; i < dragSpeeds.length; i++)
      dragMaxJump = Math.max(dragMaxJump, Math.abs(dragSpeeds[i] - dragSpeeds[i - 1]));
    const cameraDragOk =
      dragRestSpeed === 0 && dragMax === 0 && dragMaxJump === 0 && dragAfterSpeed === 0 &&
      dragViewDiff < 0.01;

    // --- 6. Cinematic idle auto-orbit ---
    // Lift the test freeze; the page loaded > 4 s ago and the last click was
    // the collapse toggle, so after IDLE_ORBIT_DELAY (4 s) of stillness the
    // camera must drift in azimuth, then freeze when the toggle is off.
    await page.evaluate(() => {
      window.__bhTest = false;
      window.__bh.params.autoOrbit = true;
    });
    await page.waitForTimeout(4300);
    const azA = await page.evaluate(() => window.__bh.camera.azimuth);
    // Pump frames explicitly: headless rAF throttles under a raw timeout, and
    // the drift only advances per rendered frame. settleFrames guarantees
    // real frames elapse so the signal is well above the noise floor.
    await settleFrames(page, 90);
    const azB = await page.evaluate(() => window.__bh.camera.azimuth);
    const drift = azB - azA; // monotone azimuthal advance; magnitude set by frame count
    await page.evaluate(() => (window.__bh.params.autoOrbit = false));
    await settleFrames(page, 5);
    const azC = await page.evaluate(() => window.__bh.camera.azimuth);
    await settleFrames(page, 30);
    const azD = await page.evaluate(() => window.__bh.camera.azimuth);
    const froze = Math.abs(azD - azC) < 1e-4;

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
      camera_drag_rest_speed: dragRestSpeed,
      camera_drag_max_speed: dragMax,
      camera_drag_max_frame_jump: dragMaxJump,
      camera_drag_after_speed: dragAfterSpeed,
      camera_drag_view_vs_static_diff: +dragViewDiff.toFixed(4),
      camera_drag_ok: cameraDragOk,
      autoorbit_drift_rad: drift,
      autoorbit_froze: froze,
      autoorbit_ok: drift > 0.005 && drift < 1.5 && froze,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (
      !results.mass_invariance_ok || !results.grid_ok || !results.freefall_stop_ok ||
      !results.learn_ok || !results.collapse_ok || !results.autoorbit_ok ||
      !results.camera_drag_ok
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
