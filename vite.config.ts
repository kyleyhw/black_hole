import { defineConfig } from "vite";

// base "./" makes the built site path-independent, so it works both on
// GitHub Pages (served from /<repo>/) and when opened from any subpath.
export default defineConfig({
  base: "./",
});
