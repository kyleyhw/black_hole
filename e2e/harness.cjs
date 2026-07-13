// Shared end-to-end harness: serves the built dist/ via `vite preview`,
// opens it in the pre-installed headless Chromium through Playwright, and
// provides pixel-statistics helpers used by the per-phase test scripts.
//
// Run with: NODE_PATH=/opt/node22/lib/node_modules node e2e/<script>.cjs
// (Playwright 1.56 is installed globally in the container, not in the repo.)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const { PNG } = require("pngjs");

const PORT = 4173;

async function startPreview() {
  const proc = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: path.join(__dirname, ".."),
    stdio: "pipe",
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      if (d.toString().includes(String(PORT))) resolve();
    });
    proc.on("exit", (code) => reject(new Error(`vite preview exited: ${code}`)));
    setTimeout(() => reject(new Error("vite preview timed out")), 15000);
  });
  return proc;
}

async function launchPage({ width = 800, height = 600 } = {}) {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    process.exitCode = 1;
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__bh !== undefined, { timeout: 10000 });
  return { browser, page };
}

// Wait until at least `n` more animation frames have been presented.
async function settleFrames(page, n = 3) {
  await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count >= frames ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

// Mean luminance in [0,255] and fraction of pixels above a threshold.
function stats(png, threshold = 32) {
  let sum = 0;
  let bright = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const r = png.data[i * 4];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += lum;
    if (lum > threshold) bright++;
  }
  return { meanLum: sum / n, brightFrac: bright / n };
}

// Fraction of pixels whose luminance differs by more than `tol`.
function diffFrac(a, b, tol = 16) {
  const n = Math.min(a.width * a.height, b.width * b.height);
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const la = 0.2126 * a.data[i * 4] + 0.7152 * a.data[i * 4 + 1] + 0.0722 * a.data[i * 4 + 2];
    const lb = 0.2126 * b.data[i * 4] + 0.7152 * b.data[i * 4 + 1] + 0.0722 * b.data[i * 4 + 2];
    if (Math.abs(la - lb) > tol) diff++;
  }
  return diff / n;
}

module.exports = { startPreview, launchPage, settleFrames, decodePng, stats, diffFrac, PORT };
