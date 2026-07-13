// Phase 5 end-to-end test: relativistic accretion disk.
//
// Checks (camera at azimuth 0 on +x, up +z, so screen-left is -y):
//   1. Disk visibility: enabling the disk raises the lit-pixel fraction
//      substantially over the star-only background.
//   2. Beaming asymmetry with the right sign: prograde matter at -y moves
//      toward a +x camera (v = Omega z_hat x r_vec), so the LEFT half must
//      be brighter with beaming on; with beaming off the asymmetry must
//      shrink dramatically (what remains is the small color-ramp effect).
//   3. ISCO lock, face-on view (elevation 1.4 rad): the disk is an annulus
//      whose central hole is bounded by max(shadow, r_ISCO image). At a = 0
//      the hole is the r_ISCO = 6 M image; at a = 0.998 (r_ISCO = 1.24 M)
//      the disk reaches the shadow edge, which is smaller — the measured
//      hole radius must shrink clearly.
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, stats } = require("./harness.cjs");

const W = 240;
const H = 180;

function halfMeans(png) {
  let left = 0;
  let right = 0;
  const w = png.width;
  const h = png.height;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      if (x < w / 2) left += lum;
      else right += lum;
    }
  const n = (w * h) / 2;
  return { left: left / n, right: right / n };
}

// Inner edge of the dominant bright annulus: azimuthal-mean luminance in
// 2 px radial bins, then the first radius (scanning outward) reaching 50%
// of the profile maximum. Robust against the thin photon ring hugging the
// shadow (a real lensed secondary disk image, 1-2 px, which a nearest-lit-
// pixel metric latches onto at every spin).
function annulusInnerRadius(png) {
  const w = png.width;
  const h = png.height;
  const nb = Math.floor(Math.min(w, h) / 4);
  const sum = new Float64Array(nb);
  const cnt = new Float64Array(nb);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      const b = Math.floor(Math.hypot(x - w / 2, y - h / 2) / 2);
      if (b < nb) {
        sum[b] += lum;
        cnt[b]++;
      }
    }
  const prof = Array.from(sum, (s, i) => (cnt[i] ? s / cnt[i] : 0));
  const peak = Math.max(...prof);
  for (let b = 0; b < nb; b++) if (prof[b] >= 0.5 * peak) return b * 2 + 1;
  return Infinity;
}

(async () => {
  const t0 = Date.now();
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: W, height: H });
  await page.addStyleTag({ content: "#panel,#fps,#footer{display:none !important}" });
  const outDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(outDir, { recursive: true });

  const setState = (spin, diskOn, beaming, elevation) =>
    page.evaluate(
      ([s, d, b, el]) => {
        const bh = window.__bh;
        bh.params.spin = s;
        bh.params.diskOn = d;
        bh.params.beaming = b;
        bh.params.debugView = 0;
        bh.params.maxSteps = 500;
        bh.camera.azimuth = 0;
        bh.camera.elevation = el;
        bh.camera.radius = 22;
      },
      [spin, diskOn, beaming, elevation],
    );

  try {
    // --- 1. Visibility ---
    await setState(0.9, false, true, 0.15);
    await settleFrames(page, 4);
    const off = stats(decodePng(await page.screenshot()));

    await setState(0.9, true, true, 0.15);
    await settleFrames(page, 4);
    const onShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase5-disk-a09.png"), onShot);
    const onPng = decodePng(onShot);
    const on = stats(onPng);

    // --- 2. Beaming asymmetry ---
    const hmOn = halfMeans(onPng);
    await setState(0.9, true, false, 0.15);
    await settleFrames(page, 4);
    const noBeamShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase5-disk-nobeam-a09.png"), noBeamShot);
    const hmOff = halfMeans(decodePng(noBeamShot));
    const asymOn = hmOn.left / hmOn.right;
    const asymOff = hmOff.left / hmOff.right;

    // --- 3. ISCO lock (face-on) ---
    await setState(0.0, true, true, 1.4);
    await settleFrames(page, 4);
    const a0Shot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase5-disk-faceon-a0.png"), a0Shot);
    const rA0 = annulusInnerRadius(decodePng(a0Shot));
    await setState(0.998, true, true, 1.4);
    await settleFrames(page, 4);
    const aXShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase5-disk-faceon-a0998.png"), aXShot);
    const rAX = annulusInnerRadius(decodePng(aXShot));

    // Disk visibility via difference image: identical camera and spin with
    // disk off, so the (heavily lensed) starfield cancels exactly and only
    // disk emission/occlusion survives the subtraction.
    await setState(0.9, false, true, 0.15);
    await settleFrames(page, 4);
    const offPng = decodePng(await page.screenshot());
    let diskPixels = 0;
    for (let i = 0; i < onPng.width * onPng.height; i++) {
      const dl =
        0.2126 * (onPng.data[i * 4] - offPng.data[i * 4]) +
        0.7152 * (onPng.data[i * 4 + 1] - offPng.data[i * 4 + 1]) +
        0.0722 * (onPng.data[i * 4 + 2] - offPng.data[i * 4 + 2]);
      if (Math.abs(dl) > 40) diskPixels++;
    }
    const diskFrac = diskPixels / (onPng.width * onPng.height);

    const results = {
      disk_changed_frac: diskFrac,
      visibility_ok: diskFrac > 0.03,
      leftOverRight_beamOn: asymOn,
      leftOverRight_beamOff: asymOff,
      beaming_ok: asymOn > 1.3 && Math.abs(asymOff - 1) < (asymOn - 1) / 2,
      holeRadius_px_a0: rA0,
      holeRadius_px_a0998: rAX,
      isco_ok: rAX < 0.75 * rA0,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (!results.visibility_ok || !results.beaming_ok || !results.isco_ok) process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit();
  }
})();
