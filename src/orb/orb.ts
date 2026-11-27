/**
 * The holographic orb: a rotating sphere of glowing nodes joined by short
 * links, around a soft core. A TypeScript reimplementation of the legacy
 * `assets/sphere.html` (canvas 2D) without the Qt bridge, DOM particles or
 * fake stats.
 */

export type OrbState = "off" | "idle" | "connecting" | "listening" | "speaking";

interface Palette {
  primary: string;
  light: string;
  dim: string;
}

/** Cyan HUD theme. Matches `--accent` and `--accent-soft` in `styles.css`. */
const PALETTE: Palette = { primary: "#00c8ff", light: "#7ce8ff", dim: "#0e5a78" };

/** Orb radius in CSS pixels at which nodes, links and glow are drawn full size. */
const FULL_SIZE_RADIUS = 64;
const MIN_DETAIL = 0.4;

interface Motion {
  /** Rotation per frame around Y and X, in radians. */
  spinY: number;
  spinX: number;
  intensity: number;
  /** Max link length as a fraction of the radius. */
  linkReach: number;
  linksPerNode: number;
  pulseSpeed: number;
}

const MOTION: Record<OrbState, Motion> = {
  off: {
    spinY: 0.0006,
    spinX: 0.0002,
    intensity: 0.45,
    linkReach: 0.55,
    linksPerNode: 1,
    pulseSpeed: 0.25,
  },
  idle: {
    spinY: 0.0016,
    spinX: 0.0006,
    intensity: 0.8,
    linkReach: 0.7,
    linksPerNode: 2,
    pulseSpeed: 0.7,
  },
  listening: {
    spinY: 0.0035,
    spinX: 0.0012,
    intensity: 1.1,
    linkReach: 0.75,
    linksPerNode: 3,
    pulseSpeed: 1.2,
  },
  connecting: {
    spinY: 0.018,
    spinX: 0.006,
    intensity: 1.5,
    linkReach: 0.85,
    linksPerNode: 5,
    pulseSpeed: 4.5,
  },
  speaking: {
    spinY: 0.006,
    spinX: 0.002,
    intensity: 1.2,
    linkReach: 0.75,
    linksPerNode: 3,
    pulseSpeed: 2,
  },
};

const NODE_COUNT = 90;
const TARGET_FPS = 50;

interface OrbNode {
  theta: number;
  phi: number;
  size: number;
  color: string;
  pulse: number;
  pulseSpeed: number;
  firing: number;
  x: number;
  y: number;
  z: number;
}

function createNode(): OrbNode {
  const roll = Math.random();
  return {
    theta: Math.random() * Math.PI * 2,
    phi: Math.acos(Math.random() * 2 - 1),
    size: 1.2 + Math.random() * 2.5,
    color: roll > 0.6 ? PALETTE.primary : roll > 0.2 ? PALETTE.light : PALETTE.dim,
    pulse: Math.random() * Math.PI * 2,
    pulseSpeed: 0.03 + Math.random() * 0.06,
    firing: 0,
    x: 0,
    y: 0,
    z: 0,
  };
}

function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export class Orb {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #nodes: OrbNode[] = Array.from({ length: NODE_COUNT }, createNode);
  #state: OrbState = "off";
  #level = 0;
  #rotationX = 0;
  #rotationY = 0;
  #radius = 100;
  /** Shrinks strokes and glow so a small orb does not turn into a blob. */
  #detail = 1;
  #frame = 0;
  #lastFrame = 0;
  readonly #resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#resize();
  }

  setState(state: OrbState): void {
    if (state === this.#state) return;
    // A burst of firing nodes when a conversation starts.
    if (state === "connecting" || (state === "listening" && this.#state === "idle")) {
      for (const node of this.#nodes) if (Math.random() > 0.6) node.firing = 0.9;
    }
    this.#state = state;
  }

  /** Audio level `0..1` (microphone while listening, speaker while speaking). */
  setLevel(level: number): void {
    // Smooth so the orb does not flicker with every 50 ms update.
    this.#level = this.#level * 0.6 + Math.min(1, Math.max(0, level)) * 0.4;
  }

  start(): void {
    if (this.#frame) return;
    const loop = (time: number) => {
      this.#frame = requestAnimationFrame(loop);
      if (document.hidden || time - this.#lastFrame < 1000 / TARGET_FPS) return;
      this.#lastFrame = time;
      this.#draw(time);
    };
    this.#frame = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  #resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = this.#canvas;
    this.#canvas.width = Math.max(1, Math.round(clientWidth * ratio));
    this.#canvas.height = Math.max(1, Math.round(clientHeight * ratio));
    this.#radius = Math.min(this.#canvas.width, this.#canvas.height) * 0.36;
    this.#detail = Math.min(1, Math.max(MIN_DETAIL, this.#radius / (ratio * FULL_SIZE_RADIUS)));
  }

  #draw(time: number): void {
    const ctx = this.#ctx;
    const motion = MOTION[this.#state];
    const voice = this.#state === "speaking" || this.#state === "listening" ? this.#level : 0;
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    const cx = width / 2;
    const cy = height / 2;

    this.#rotationY += motion.spinY + voice * 0.03;
    this.#rotationX += motion.spinX + voice * 0.01;
    const intensity = motion.intensity + voice * 0.8;
    let radius = this.#radius * (1 + voice * 0.3);
    if (this.#state === "connecting") radius *= 1 + Math.sin(time * 0.015) * 0.04;

    ctx.clearRect(0, 0, width, height);

    if (this.#state !== "off") {
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.95);
      glow.addColorStop(0, withAlpha(PALETTE.primary, 0.22 + voice * 0.35));
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.95, 0, Math.PI * 2);
      ctx.fill();
    }

    const cosY = Math.cos(this.#rotationY);
    const sinY = Math.sin(this.#rotationY);
    const cosX = Math.cos(this.#rotationX);
    const sinX = Math.sin(this.#rotationX);
    for (const node of this.#nodes) {
      node.pulse += node.pulseSpeed * motion.pulseSpeed;
      if (node.firing > 0) node.firing = Math.max(0, node.firing - 0.04);
      const r = radius * (1 + Math.sin(node.pulse + time * 0.001) * 0.04 * intensity);
      const x = r * Math.sin(node.phi) * Math.cos(node.theta);
      const y = r * Math.sin(node.phi) * Math.sin(node.theta);
      const z = r * Math.cos(node.phi);
      const x1 = x * cosY - z * sinY;
      const z1 = x * sinY + z * cosY;
      node.x = x1;
      node.y = y * cosX - z1 * sinX;
      node.z = y * sinX + z1 * cosX;
    }

    // Links between nearby nodes, then nodes, back to front.
    const reach = radius * motion.linkReach;
    const sorted = [...this.#nodes].sort((a, b) => a.z - b.z);
    ctx.lineCap = "round";
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (!a) continue;
      let links = 0;
      for (let j = i + 1; j < sorted.length && links < motion.linksPerNode; j++) {
        const b = sorted[j];
        if (!b) continue;
        const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (distance >= reach) continue;
        links++;
        const depth = ((a.z + b.z) / 2 + radius) / (radius * 2);
        ctx.globalAlpha = Math.min(1, (1 - distance / reach) * 0.42 * depth * intensity);
        ctx.strokeStyle = a.color;
        ctx.lineWidth = (0.5 + depth * 1.8) * this.#detail;
        ctx.beginPath();
        ctx.moveTo(cx + a.x, cy + a.y);
        ctx.lineTo(cx + b.x, cy + b.y);
        ctx.stroke();
        if (Math.random() > (this.#state === "connecting" ? 0.93 : 0.995)) a.firing = 0.7;
      }
    }

    for (const node of sorted) {
      const depth = (node.z + radius) / (radius * 2);
      const scale = depth * 0.75 + 0.25;
      const size =
        (node.size * scale * (1 + (this.#state === "speaking" ? voice * 2 : 0)) + node.firing * 4) *
        this.#detail;
      ctx.globalAlpha = Math.min(
        1,
        scale * (0.4 + Math.sin(node.pulse) * 0.25) * intensity + node.firing,
      );
      ctx.fillStyle = node.color;
      if (scale > 0.6 || node.firing > 0.1) {
        ctx.shadowBlur = (15 + node.firing * 40) * intensity * this.#detail;
        ctx.shadowColor = node.color;
      }
      ctx.beginPath();
      ctx.arc(cx + node.x, cy + node.y, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }
}
