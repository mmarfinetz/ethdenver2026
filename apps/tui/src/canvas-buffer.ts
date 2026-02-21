import type { DrawBuffer } from "./draw-buffer.js";

interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
}

// Lazy-loaded canvas module
let canvasModule: typeof import("@napi-rs/canvas") | undefined;

export async function loadCanvasModule(): Promise<boolean> {
  try {
    canvasModule = await import("@napi-rs/canvas");
    return true;
  } catch {
    return false;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const CANVAS_SCALE_X = 10;
const CANVAS_SCALE_Y = 20;
const DEPTH_BUCKETS = 64;

export class CanvasBuffer implements DrawBuffer {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;

  private readonly canvasWidth: number;
  private readonly canvasHeight: number;
  private segments: Segment[] = [];

  constructor(cellWidth: number, cellHeight: number) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    // Match braille coordinate space for projection compatibility
    this.pixelWidth = cellWidth * 2;
    this.pixelHeight = cellHeight * 4;
    // Internal canvas resolution
    this.canvasWidth = cellWidth * CANVAS_SCALE_X;
    this.canvasHeight = cellHeight * CANVAS_SCALE_Y;
  }

  set(x: number, y: number, z = 0): void {
    // Treat a point as a tiny segment so it shows up as a dot
    this.segments.push({ x0: x, y0: y, x1: x + 0.1, y1: y + 0.1, z });
  }

  line(x0: number, y0: number, x1: number, y1: number, z0 = 0, z1 = 0): void {
    // Use average depth for the segment
    this.segments.push({ x0, y0, x1, y1, z: (z0 + z1) / 2 });
  }

  clear(): void {
    this.segments = [];
  }

  toImageString(minDepth: number, maxDepth: number): string {
    if (!canvasModule) throw new Error("Canvas module not loaded");

    const { createCanvas } = canvasModule;
    const canvas = createCanvas(this.canvasWidth, this.canvasHeight);
    const ctx = canvas.getContext("2d");

    // Transparent black background
    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    // Scale factor from braille pixel coords to canvas coords
    const sx = this.canvasWidth / this.pixelWidth;
    const sy = this.canvasHeight / this.pixelHeight;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.2;

    // Sort segments by depth (dim first, bright overdraw)
    const sorted = this.segments.slice().sort((a, b) => a.z - b.z);

    const range = maxDepth - minDepth || 1;

    // Bucket into DEPTH_BUCKETS levels for batch drawing
    const buckets: Segment[][] = Array.from({ length: DEPTH_BUCKETS }, () => []);
    for (const seg of sorted) {
      const t = clamp01((seg.z - minDepth) / range);
      const bucket = Math.min(DEPTH_BUCKETS - 1, Math.floor(t * DEPTH_BUCKETS));
      buckets[bucket].push(seg);
    }

    for (let bi = 0; bi < DEPTH_BUCKETS; bi++) {
      const segs = buckets[bi];
      if (segs.length === 0) continue;

      const t = (bi + 0.5) / DEPTH_BUCKETS;
      // Same color ramp as braille
      const r = Math.round(5 + t * t * 135);
      const g = Math.round(60 + t * 195);
      const b = Math.round(75 + t * 180);

      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      for (const seg of segs) {
        ctx.moveTo(seg.x0 * sx, seg.y0 * sy);
        ctx.lineTo(seg.x1 * sx, seg.y1 * sy);
      }
      ctx.stroke();
    }

    const pngData = canvas.toBuffer("image/png");
    const base64 = pngData.toString("base64");

    // iTerm2 inline image protocol
    return `\x1b]1337;File=inline=1;width=${this.cellWidth};height=${this.cellHeight};preserveAspectRatio=0:${base64}\x07`;
  }
}
