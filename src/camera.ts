// Orbit camera around the origin (the black hole), spherical coordinates
// (azimuth, elevation, radius) with pointer-drag rotation, wheel/pinch zoom,
// exponential inertial damping, and double-click reset.

export interface CameraBasis {
  /** Camera position in Cartesian scene coordinates (units of M). */
  readonly pos: readonly [number, number, number];
  /** Orthonormal basis: right, up, forward (forward points at the origin). */
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
}

// Zoom clamp per spec §4: inside the photon shell is fine in Kerr-Schild
// coordinates, but stay outside the horizon buffer. 2.2 M > 1.02 r_+ for all
// allowed spins (r_+ <= 2 M at a = 0).
const R_MIN = 2.2;
const R_MAX = 60.0;
const ELEV_LIMIT = (89 * Math.PI) / 180;
const DEFAULTS = { azimuth: 0.0, elevation: 0.12, radius: 18.0 } as const;

export class OrbitCamera {
  azimuth: number = DEFAULTS.azimuth;
  elevation: number = DEFAULTS.elevation;
  radius: number = DEFAULTS.radius;
  fovY: number = (60 * Math.PI) / 180;

  private velAz = 0;
  private velEl = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pinchDist: number | null = null;
  private lastInteractMs = 0;

  /** True while the user is actively dragging or pinching. */
  get isManipulating(): boolean {
    return this.dragging || this.pinchDist !== null;
  }

  /** Reset the idle clock — called on any discrete user interaction. */
  markInteraction(): void {
    this.lastInteractMs = performance.now();
  }

  /** Seconds since the last interaction (∞ before the first one). */
  idleSeconds(): number {
    return this.lastInteractMs === 0 ? Infinity : (performance.now() - this.lastInteractMs) / 1000;
  }

  attach(el: HTMLElement): void {
    this.lastInteractMs = performance.now();
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const scale = 0.005; // radians per pixel of drag
      this.azimuth -= dx * scale;
      this.elevation = clamp(this.elevation + dy * scale, -ELEV_LIMIT, ELEV_LIMIT);
      this.velAz = -dx * scale;
      this.velEl = dy * scale;
    });
    el.addEventListener("pointerup", () => (this.dragging = false));
    el.addEventListener("pointercancel", () => (this.dragging = false));
    el.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        this.zoomBy(Math.exp(e.deltaY * 0.001));
      },
      { passive: false },
    );
    el.addEventListener("dblclick", () => this.reset());
    // Pinch zoom: track two-touch distance ratio.
    el.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        if (!t0 || !t1) return;
        const d = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        if (this.pinchDist !== null) this.zoomBy(this.pinchDist / d);
        this.pinchDist = d;
      },
      { passive: false },
    );
    el.addEventListener("touchend", () => (this.pinchDist = null));
  }

  zoomBy(factor: number): void {
    this.radius = clamp(this.radius * factor, R_MIN, R_MAX);
  }

  reset(): void {
    this.azimuth = DEFAULTS.azimuth;
    this.elevation = DEFAULTS.elevation;
    this.radius = DEFAULTS.radius;
    this.velAz = 0;
    this.velEl = 0;
  }

  /** Advance inertial coast; dt in seconds. */
  update(dt: number): void {
    if (this.dragging) return;
    const damping = Math.exp(-6.0 * dt); // ~0.17 s decay constant
    this.velAz *= damping;
    this.velEl *= damping;
    if (Math.abs(this.velAz) + Math.abs(this.velEl) < 1e-5) return;
    this.azimuth += this.velAz;
    this.elevation = clamp(this.elevation + this.velEl, -ELEV_LIMIT, ELEV_LIMIT);
  }

  /**
   * Camera basis in scene coordinates. The black hole spin axis is +z;
   * elevation is measured from the equatorial (x,y) plane.
   */
  basis(): CameraBasis {
    const ce = Math.cos(this.elevation);
    const se = Math.sin(this.elevation);
    const ca = Math.cos(this.azimuth);
    const sa = Math.sin(this.azimuth);
    const pos: [number, number, number] = [
      this.radius * ce * ca,
      this.radius * ce * sa,
      this.radius * se,
    ];
    // forward = -r_hat; up spans the (r_hat, z_hat) plane; right = forward x up.
    const forward: [number, number, number] = [-ce * ca, -ce * sa, -se];
    const up: [number, number, number] = [-se * ca, -se * sa, ce];
    const right: [number, number, number] = [
      forward[1] * up[2] - forward[2] * up[1],
      forward[2] * up[0] - forward[0] * up[2],
      forward[0] * up[1] - forward[1] * up[0],
    ];
    return { pos, right, up, forward };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
