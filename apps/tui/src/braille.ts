/**
 * Braille-dot wireframe buffer.
 *
 * Each terminal cell maps to a 2×4 sub-pixel grid rendered as a single
 * Unicode Braille character (U+2800–U+28FF).  This gives smooth, curved
 * lines at sub-cell resolution instead of the blocky right-angle look
 * of box-drawing characters.
 */

const SUBPIXELS_X = 2;
const SUBPIXELS_Y = 4;

/**
 * Braille dot bit positions indexed by [column][row] within a cell.
 *
 *   col 0   col 1
 *   ─────   ─────
 *   bit 0   bit 3    row 0
 *   bit 1   bit 4    row 1
 *   bit 2   bit 5    row 2
 *   bit 6   bit 7    row 3
 */
const DOT_BIT: readonly (readonly number[])[] = [
  [0, 1, 2, 6], // left  column (px % 2 === 0)
  [3, 4, 5, 7], // right column (px % 2 === 1)
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class BrailleBuffer {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;

  private dots: Uint8Array;
  private depth: Float32Array;

  constructor(cellWidth: number, cellHeight: number) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.pixelWidth = cellWidth * SUBPIXELS_X;
    this.pixelHeight = cellHeight * SUBPIXELS_Y;

    const count = cellWidth * cellHeight;
    this.dots = new Uint8Array(count);
    this.depth = new Float32Array(count).fill(-Infinity);
  }

  clear(): void {
    this.dots.fill(0);
    this.depth.fill(-Infinity);
  }

  /** Set a single sub-pixel dot. */
  set(x: number, y: number, z = 0): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || px >= this.pixelWidth || py < 0 || py >= this.pixelHeight) return;

    const cx = Math.floor(px / SUBPIXELS_X);
    const cy = Math.floor(py / SUBPIXELS_Y);
    const sx = px - cx * SUBPIXELS_X; // 0 or 1
    const sy = py - cy * SUBPIXELS_Y; // 0..3

    const idx = cy * this.cellWidth + cx;
    this.dots[idx] |= 1 << DOT_BIT[sx][sy];
    if (z > this.depth[idx]) this.depth[idx] = z;
  }

  /** Draw a line between two sub-pixel positions using Bresenham stepping. */
  line(x0: number, y0: number, x1: number, y1: number, z0 = 0, z1 = 0): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(Math.round(dx)), Math.abs(Math.round(dy)));

    if (steps === 0) {
      this.set(x0, y0, z0);
      return;
    }

    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      this.set(x0 + dx * t, y0 + dy * t, z0 + (z1 - z0) * t);
    }
  }

  /** Render the buffer to an ANSI-colored string with depth-based coloring. */
  toColorString(minDepth: number, maxDepth: number): string {
    const range = maxDepth - minDepth || 1;
    const lines: string[] = [];

    for (let cy = 0; cy < this.cellHeight; cy += 1) {
      let line = "";
      for (let cx = 0; cx < this.cellWidth; cx += 1) {
        const idx = cy * this.cellWidth + cx;
        const mask = this.dots[idx];

        if (mask === 0) {
          line += " ";
          continue;
        }

        const ch = String.fromCharCode(0x2800 + mask);
        const d = this.depth[idx];
        const t = clamp01((d - minDepth) / range);

        // Higher floor so mesh lines are visible; quadratic R adds white glow at peaks
        const r = Math.round(5 + t * t * 135);
        const g = Math.round(60 + t * 195);
        const b = Math.round(75 + t * 180);

        line += `\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
      }
      lines.push(line);
    }

    return lines.join("\n");
  }
}
