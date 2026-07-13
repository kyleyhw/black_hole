// Phase 10 end-to-end test: weak-field multi-mass mode.
//
// Checks (camera at azimuth 0, elevation 0, r = 30; masses at (0, ±8, 0)):
//   1. Mode renders: dark capture disks at both projected mass positions,
//      and the image differs massively from Kerr mode.
//   2. Dragging a mass with the pointer moves it (in the camera plane) and
//      does NOT orbit the camera.
//   3. The validity indicator warns when masses are pushed close together.
//   4. Switching back to Kerr restores the disk render.
//
// The physics of this mode (deflection 4M/b, additivity) is validated in
// the float64 suite (validation study 6), not by pixel measurements here.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, diffFrac } = require("./harness.cjs");

const W = 240;
const H = 180;

function lumAt(png, x, y) {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
}

// Fraction of pixels darker than 12/255 within radius r of (x, y): robust
// against individual lensed star arcs grazing the capture disk.
function darkFrac(png, x, y, r) {
  let dark = 0;
  let n = 0;
  for (let yy = Math.round(y - r); yy <= y + r; yy++)
    for (let xx = Math.round(x - r); xx <= x + r; xx++) {
      if (xx < 0 || yy < 0 || xx >= png.width || yy >= png.height) continue;
      if (Math.hypot(xx - x, yy - y) > r) continue;
      if (lumAt(png, xx, yy) < 12) dark++;
      n++;
    }
  return dark / n;
}

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: W, height: H });
  await page.addStyleTag({ content: "#panel,#fps,#footer{display:none !important}" });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  const setBase = (mode) =>
    page.evaluate((m) => {
      const bh = window.__bh;
      bh.params.mode = m;
      bh.params.debugView = 0;
      bh.params.maxSteps = 400;
      bh.params.diskOn = true;
      bh.params.spin = 0.6;
      bh.params.skyShift = false;
      bh.params.masses = [
        { m: 1.0, pos: [0, -8, 0] },
        { m: 1.0, pos: [0, 8, 0] },
      ];
      bh.camera.azimuth = 0;
      bh.camera.elevation = 0;
      bh.camera.radius = 30;
    }, mode);

  // Projected screen positions of (0, ±8, 0) for this camera: forward -x,
  // right +y, up +z; cz = 30, cx = ∓8; tan-projection with fovY 60°.
  const tanHF = Math.tan(Math.PI / 6);
  const aspect = W / H;
  const sx1 = ((-8 / (30 * tanHF * aspect) + 1) / 2) * W; // mass at -y: screen left
  const sx2 = ((+8 / (30 * tanHF * aspect) + 1) / 2) * W;
  const sy = H / 2;

  try {
    // --- 1. Multi-mass renders two capture disks ---
    await setBase("kerr");
    await settleFrames(page, 4);
    const kerrPng = decodePng(await page.screenshot());
    await setBase("multi");
    await settleFrames(page, 4);
    const multiShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase10-two-masses.png"), multiShot);
    const multiPng = decodePng(multiShot);
    const dark1 = darkFrac(multiPng, sx1, sy, 7);
    const dark2 = darkFrac(multiPng, sx2, sy, 7);
    const modeDiff = diffFrac(kerrPng, multiPng, 20);

    // --- 2. Drag mass 1 upward 40 px ---
    const before = await page.evaluate(() => ({
      pos: [...window.__bh.params.masses[0].pos],
      az: window.__bh.camera.azimuth,
    }));
    await page.mouse.move(sx1, sy);
    await page.mouse.down();
    await page.mouse.move(sx1, sy - 40, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => ({
      pos: [...window.__bh.params.masses[0].pos],
      az: window.__bh.camera.azimuth,
    }));
    const moved = Math.hypot(
      after.pos[0] - before.pos[0],
      after.pos[1] - before.pos[1],
      after.pos[2] - before.pos[2],
    );

    // --- 3. Validity indicator: far state (0.5+0.5)/24 = 0.04 (linear),
    // near state 1/3 = 0.33 (warns above 0.1) ---
    await page.evaluate(() => {
      window.__bh.params.masses[0] = { m: 0.5, pos: [0, -12, 0] };
      window.__bh.params.masses[1] = { m: 0.5, pos: [0, 12, 0] };
    });
    await page.waitForTimeout(400); // indicator refreshes at 5 Hz
    const farText = await page.evaluate(() => document.getElementById("validity").textContent);
    await page.evaluate(() => {
      window.__bh.params.masses[0].pos = [0, -1.5, 0];
      window.__bh.params.masses[1].pos = [0, 1.5, 0];
    });
    await page.waitForTimeout(400);
    const nearText = await page.evaluate(() => document.getElementById("validity").textContent);

    // --- 4. Back to Kerr ---
    await setBase("kerr");
    await settleFrames(page, 4);
    const backPng = decodePng(await page.screenshot());
    const backDiff = diffFrac(multiPng, backPng, 20);

    const results = {
      darkFrac_at_mass1: dark1,
      darkFrac_at_mass2: dark2,
      capture_disks_ok: dark1 > 0.5 && dark2 > 0.5,
      mode_diffFrac: modeDiff,
      mode_ok: modeDiff > 0.15,
      drag_moved_M: moved,
      drag_azimuth_delta: Math.abs(after.az - before.az),
      drag_ok: moved > 2 && Math.abs(after.az - before.az) < 1e-9,
      validity_far: farText,
      validity_near: nearText,
      validity_ok: !farText.includes("⚠") && nearText.includes("⚠"),
      back_to_kerr_ok: backDiff > 0.15,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (
      !results.capture_disks_ok || !results.mode_ok || !results.drag_ok ||
      !results.validity_ok || !results.back_to_kerr_ok
    )
      process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit();
  }
})();
