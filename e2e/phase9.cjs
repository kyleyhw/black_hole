// Phase 9 end-to-end test: retrograde disk flow and disk inclination.
//
// Checks:
//   1. r_ISCO(a, s) values against Bardeen-Press-Teukolsky at a = 0.9:
//      prograde 2.3209 M, retrograde 8.7174 M.
//   2. Beaming asymmetry flips under s -> -s (a = 0.9, edge-on): the bright
//      side moves from screen-left (prograde approaching at -y for a +x
//      camera) to screen-right.
//   3. Retrograde ISCO hole (face-on): with r_ISCO jumping 2.32 -> 8.72 M
//      the central hole must widen far beyond the shadow-bounded prograde
//      hole.
//   4. Inclination: tilting the disk by 23 degrees changes the image
//      substantially and the disk remains visible (tilted-plane crossing
//      detection works).
const fs = require("fs");
const path = require("path");
const { startPreview, launchPage, settleFrames, decodePng, diffFrac } = require("./harness.cjs");

const W = 240;
const H = 180;

function halfMeans(png) {
  let left = 0;
  let right = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      if (x < png.width / 2) left += lum;
      else right += lum;
    }
  const n = (png.width * png.height) / 2;
  return { left: left / n, right: right / n };
}

function annulusInnerRadius(png) {
  const nb = Math.floor(Math.min(png.width, png.height) / 4);
  const sum = new Float64Array(nb);
  const cnt = new Float64Array(nb);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      const b = Math.floor(Math.hypot(x - png.width / 2, y - png.height / 2) / 2);
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

  const setState = (o) =>
    page.evaluate((s) => {
      const bh = window.__bh;
      Object.assign(bh.params, {
        diskOn: true,
        beaming: true,
        debugView: 0,
        maxSteps: 500,
        skyShift: false,
        diskIncl: 0,
        ...s.params,
      });
      Object.assign(bh.camera, { azimuth: 0, radius: 22, ...s.camera });
    }, o);

  try {
    // --- 1. BPT ISCO values ---
    const isco = await page.evaluate(() => ({
      pro: window.__bh.risco(0.9, 1),
      retro: window.__bh.risco(0.9, -1),
    }));
    const iscoOk = Math.abs(isco.pro - 2.3209) < 2e-3 && Math.abs(isco.retro - 8.7174) < 2e-3;

    // --- 2. Beaming flip under s -> -s ---
    await setState({ params: { spin: 0.9, diskSense: 1 }, camera: { elevation: 0.15 } });
    await settleFrames(page, 4);
    const hmPro = halfMeans(decodePng(await page.screenshot()));
    await setState({ params: { spin: 0.9, diskSense: -1 }, camera: { elevation: 0.15 } });
    await settleFrames(page, 4);
    const retroShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase9-retro-a09.png"), retroShot);
    const hmRet = halfMeans(decodePng(retroShot));
    const asymPro = hmPro.left / hmPro.right;
    const asymRet = hmRet.left / hmRet.right;

    // --- 3. Retrograde ISCO hole (face-on) ---
    await setState({ params: { spin: 0.9, diskSense: 1 }, camera: { elevation: 1.4 } });
    await settleFrames(page, 4);
    const holePro = annulusInnerRadius(decodePng(await page.screenshot()));
    await setState({ params: { spin: 0.9, diskSense: -1 }, camera: { elevation: 1.4 } });
    await settleFrames(page, 4);
    const retroFaceShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase9-retro-faceon-a09.png"), retroFaceShot);
    const holeRet = annulusInnerRadius(decodePng(retroFaceShot));

    // --- 4. Inclination ---
    await setState({ params: { spin: 0, diskSense: 1, diskIncl: 0 }, camera: { elevation: 0.25 } });
    await settleFrames(page, 4);
    const flat = decodePng(await page.screenshot());
    await setState({ params: { spin: 0, diskSense: 1, diskIncl: 0.4 }, camera: { elevation: 0.25 } });
    await settleFrames(page, 4);
    const tiltShot = await page.screenshot();
    fs.writeFileSync(path.join(outDir, "phase9-tilt-a0.png"), tiltShot);
    const tilted = decodePng(tiltShot);
    const tiltDiff = diffFrac(flat, tilted, 20);
    // Disk visibility on the tilted plane: bright pixels present.
    let bright = 0;
    for (let i = 0; i < tilted.width * tilted.height; i++) {
      const lum =
        0.2126 * tilted.data[i * 4] + 0.7152 * tilted.data[i * 4 + 1] + 0.0722 * tilted.data[i * 4 + 2];
      if (lum > 130) bright++;
    }
    const tiltBrightFrac = bright / (tilted.width * tilted.height);

    const results = {
      isco_pro: isco.pro,
      isco_retro: isco.retro,
      isco_bpt_ok: iscoOk,
      leftOverRight_prograde: asymPro,
      leftOverRight_retrograde: asymRet,
      flip_ok: asymPro > 1.2 && asymRet < 1 / 1.1,
      holeRadius_prograde: holePro,
      holeRadius_retrograde: holeRet,
      retro_hole_ok: holeRet > 1.4 * holePro,
      tilt_diffFrac: tiltDiff,
      tilt_brightFrac: tiltBrightFrac,
      tilt_ok: tiltDiff > 0.05 && tiltBrightFrac > 0.01,
      runtime_s: (Date.now() - t0) / 1000,
    };
    console.log(JSON.stringify(results, null, 2));
    if (!results.isco_bpt_ok || !results.flip_ok || !results.retro_hole_ok || !results.tilt_ok)
      process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit();
  }
})();
