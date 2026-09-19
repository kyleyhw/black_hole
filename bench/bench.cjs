// agent-evolve eval for the Kerr ray tracer (bench/bench.cjs).
//
// Prints ONE flat JSON line on stdout:
//   {"build_ok":1,"frame_ms":<median>,"pixel_parity":<min over scenes>,...}
//
//  frame_ms     — median wall time of a full synchronous frame (frame() +
//                 gl.finish()) on the fixed Kerr timing scene, headless
//                 SwiftShader. No GPU here: SwiftShader executes the same
//                 shader instructions on the CPU, so it is a fair RELATIVE
//                 proxy for shader cost; absolute numbers do not transfer.
//  pixel_parity — behaviour-preservation gate. Four deterministic scenes
//                 (every compiled shader variant) are rendered and compared
//                 to committed reference renders (bench/reference/*.png);
//                 parity = 1 - diffFrac(tol=8/255) per scene, min reported.
//                 A legitimately equivalent optimisation (e.g. analytic vs
//                 finite-difference gradients) differs at the truncation
//                 level, so a few photon-ring pixels may flip; a wrong metric
//                 or termination collapses parity to ~0.5.
//
// Determinism: camera/spin/steps/resolution pinned, disk clock pinned via
// __bhDiskTime, idle auto-orbit off (harness __bhTest). Runs at the worktree
// root; per-tree dist/ is built here; node_modules is symlinked from the
// main repository when absent (worktrees do not carry it).
//
// Flags: --write-reference  regenerate bench/reference/*.png from THIS tree
//        --selftest         render the timing scene twice, assert identical
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ROOT = process.cwd();
const REF = path.join(ROOT, "bench", "reference");

function out(o, code = 0) { console.log(JSON.stringify(o)); process.exit(code); }

// node_modules: symlink from the main repository for worktrees.
if (!fs.existsSync(path.join(ROOT, "node_modules"))) {
  try {
    const common = execSync("git rev-parse --git-common-dir", { cwd: ROOT }).toString().trim();
    const mainRepo = path.dirname(path.resolve(ROOT, common));
    fs.symlinkSync(path.join(mainRepo, "node_modules"), path.join(ROOT, "node_modules"), "dir");
  } catch (e) { out({ build_ok: 0, frame_ms: -1, pixel_parity: 0, error: "node_modules: " + e.message }, 1); }
}
// Build (typecheck + vite). A shader that fails to compile at build time
// surfaces here; a GLSL compile failure surfaces as a page error below.
try { execSync("npm run build", { cwd: ROOT, stdio: "pipe" }); }
catch (e) { out({ build_ok: 0, frame_ms: -1, pixel_parity: 0, error: "build failed" }, 1); }

const { startPreview, launchPage, settleFrames, decodePng, diffFrac } = require(path.join(ROOT, "e2e", "harness.cjs"));
const { PNG } = require("pngjs");

// Fixed scenes. Scene 1 is the timing scene.
const SCENES = [
  { id: 1, mode: "kerr", spin: 0.6,   diskOn: true,  az: 0, el: 0.12, r: 18 },
  { id: 2, mode: "kerr", spin: 0.0,   diskOn: false, az: 0, el: 0.12, r: 18 },
  { id: 3, mode: "kerr", spin: 0.998, diskOn: true,  az: 0.4, el: 0.6, r: 14 },
  { id: 4, mode: "binary", event: "GW150914", seekFrac: 0.12 },
];
const WARM = 2, MEASURE = 6;

(async () => {
  const flags = new Set(process.argv.slice(2));
  const server = await startPreview();
  const { browser, page } = await launchPage({ width: 320, height: 240 });
  let pageErr = null; page.on("pageerror", (e) => { pageErr = e.message; });
  const grab = async () => decodePng(Buffer.from((await page.evaluate(() => window.__bh.capture())).split(",")[1], "base64"));
  const apply = async (sc) => {
    await page.evaluate((s) => {
      const bh = window.__bh; window.__bhDiskTime = 100; // pin disk clock
      bh.params.maxSteps = s.mode === "binary" ? 200 : 400;
      bh.params.resolutionScale = 0.5;
      if (s.mode === "binary") {
        bh.params.mode = "binary"; bh.merger.select(s.event);
        bh.merger.seek(s.seekFrac * bh.merger.tMergerGeom());
      } else {
        bh.merger.select(null); bh.params.mode = "kerr";
        bh.params.spin = s.spin; bh.params.diskOn = s.diskOn;
        bh.camera.azimuth = s.az; bh.camera.elevation = s.el; bh.camera.radius = s.r;
      }
    }, sc);
    await settleFrames(page, 2);
  };
  try {
    if (flags.has("--selftest")) {
      await apply(SCENES[0]); const a = await grab(); const b = await grab();
      out({ selftest_diffFrac: diffFrac(a, b, 0), deterministic: diffFrac(a, b, 0) === 0 });
    }
    // --- parity over all scenes (or write references) ---
    let parity = 1; const per = {};
    for (const sc of SCENES) {
      await apply(sc); const img = await grab();
      if (pageErr) out({ build_ok: 0, frame_ms: -1, pixel_parity: 0, error: "page error: " + pageErr }, 1);
      const refPath = path.join(REF, `scene-${sc.id}.png`);
      if (flags.has("--write-reference")) { fs.writeFileSync(refPath, PNG.sync.write(img)); continue; }
      if (!fs.existsSync(refPath)) out({ build_ok: 1, frame_ms: -1, pixel_parity: 0, error: "missing reference " + refPath }, 1);
      const ref = decodePng(fs.readFileSync(refPath));
      const p = 1 - diffFrac(ref, img, 8); per[`parity_scene${sc.id}`] = +p.toFixed(5); parity = Math.min(parity, p);
    }
    if (flags.has("--write-reference")) out({ wrote: SCENES.length, dir: REF });
    // --- timing on scene 1 ---
    await apply(SCENES[0]);
    for (let i = 0; i < WARM; i++) await page.evaluate(() => window.__bh.bench());
    const t = [];
    for (let i = 0; i < MEASURE; i++) t.push(await page.evaluate(() => window.__bh.bench()));
    t.sort((a, b) => a - b);
    const med = t[Math.floor(t.length / 2)];
    const mean = t.reduce((a, b) => a + b, 0) / t.length;
    const sd = Math.sqrt(t.reduce((a, b) => a + (b - mean) ** 2, 0) / t.length);
    out({ build_ok: 1, frame_ms: +med.toFixed(1), pixel_parity: +parity.toFixed(5), ...per,
          frame_ms_min: +t[0].toFixed(1), frame_ms_max: +t[t.length - 1].toFixed(1), frame_ms_sd: +sd.toFixed(1) });
  } catch (e) {
    out({ build_ok: 1, frame_ms: -1, pixel_parity: 0, error: String(e && e.message || e) }, 1);
  } finally { try { await browser.close(); } catch {} try { server.kill(); } catch {} }
})();
