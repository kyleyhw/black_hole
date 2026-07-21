// Tooling (not a test): capture a merger playthrough as a GIF for the README.
//
// Deterministic frames via __bh.merger.seek(tGeom) + __bh.capture() (a
// synchronous render + canvas.toDataURL, so preserveDrawingBuffer being off
// is not a problem). Each frame composites the WebGL scene with the live
// chirp waveform strip (its 2D canvas, read via toDataURL) so the GIF shows
// exactly what the app shows: two holes spiralling in over the scrolling
// h(t) trace. Frames are timed denser toward merger (the whirl is fast
// there) via a sub-linear time warp. PNGs are handed to Pillow to assemble
// the GIF (ffmpeg in this image lacks a PNG decoder).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { startPreview, launchPage, settleFrames } = require("./harness.cjs");

const N = 40; // frames
const WARP = 0.55; // t(i) = tEnd * (i/(N-1))^WARP  -> steps shrink toward merger
const EVENT = "GW150914";

(async () => {
  const server = await startPreview();
  // 16:9-ish, large enough to look good downscaled in the README.
  const { browser, page } = await launchPage({ width: 720, height: 460 });
  const tmp = path.join(__dirname, "screenshots", "gifframes");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  try {
    await page.evaluate((ev) => {
      window.__bh.params.mode = "binary";
      // Lower the render cost for the capture: the binary shader's
      // per-step Sherman-Morrison is expensive under SwiftShader. Half
      // internal resolution + a modest step budget keeps each frame a
      // few seconds; the GIF is downscaled anyway, and rays that exhaust
      // the budget near the holes just render as shadow (correct there).
      window.__bh.params.resolutionScale = 0.5;
      window.__bh.params.maxSteps = 150;
      window.__bh.merger.select(ev);
      window.__bh.merger.setSlowmo(25);
    }, EVENT);
    await settleFrames(page, 4);

    const tMerger = await page.evaluate(() => window.__bh.merger.tMergerGeom());
    const tEnd = tMerger * 1.12; // carry a little into the ringdown

    for (let i = 0; i < N; i++) {
      const tGeom = tEnd * Math.pow(i / (N - 1), WARP);
      const frame = await page.evaluate((t) => {
        window.__bh.merger.seek(t);
        const scene = window.__bh.capture(); // forces a render (updates both canvases)
        const chirp = document.getElementById("chirpCanvas");
        return { scene, chirp: chirp.toDataURL("image/png"), cw: chirp.width, ch: chirp.height };
      }, tGeom);
      const b = (u) => Buffer.from(u.split(",")[1], "base64");
      fs.writeFileSync(path.join(tmp, `scene-${String(i).padStart(3, "0")}.png`), b(frame.scene));
      fs.writeFileSync(path.join(tmp, `chirp-${String(i).padStart(3, "0")}.png`), b(frame.chirp));
      if (i % 10 === 0) process.stdout.write(`  captured ${i + 1}/${N}\n`);
    }
    console.log(`captured ${N} frames to ${tmp}`);
  } catch (err) {
    console.error("CAPTURE ERROR:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
  }

  // Assemble with Pillow: composite scene + a slim waveform strip, quantize,
  // save an optimized looping GIF.
  const py = `
import sys
from pathlib import Path
from PIL import Image

tmp = Path("${tmp.replace(/\\/g, "\\\\")}")
out = Path("${path.join(__dirname, "..", "docs", "img", "merger.gif").replace(/\\/g, "\\\\")}")
scenes = sorted(tmp.glob("scene-*.png"))
frames = []
STRIP_H = 54  # waveform strip height in the composited frame
for sp in scenes:
    cp = tmp / sp.name.replace("scene-", "chirp-")
    scene = Image.open(sp).convert("RGB")
    W, H = scene.size
    canvas = Image.new("RGB", (W, H), (0, 0, 0))
    canvas.paste(scene, (0, 0))
    if cp.exists():
        chirp = Image.open(cp).convert("RGB").resize((W, STRIP_H))
        canvas.paste(chirp, (0, H - STRIP_H))
    # Downscale for a lean README asset.
    canvas = canvas.resize((W // 2, H // 2), Image.LANCZOS)
    frames.append(canvas.convert("P", palette=Image.ADAPTIVE, colors=128))
# Hold the final ringdown frame a touch longer.
durations = [70] * (len(frames) - 1) + [700]
frames[0].save(out, save_all=True, append_images=frames[1:], loop=0,
               duration=durations, optimize=True, disposal=2)
print(f"wrote {out} ({out.stat().st_size // 1024} KiB, {len(frames)} frames)")
`;
  const pyBin = path.join(__dirname, "..", "validation", ".venv", "bin", "python");
  const res = execFileSync(pyBin, ["-c", py], { encoding: "utf8" });
  process.stdout.write(res);
  process.exit();
})();
