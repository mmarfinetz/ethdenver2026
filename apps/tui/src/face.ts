import type { Vec3 } from './projection.js';

/* ------------------------------------------------------------------ */
/*  Gaussian helper                                                   */
/* ------------------------------------------------------------------ */

function gauss(
  x: number, y: number,
  cx: number, cy: number,
  sx: number, sy: number,
): number {
  const dx = (x - cx) / sx;
  const dy = (y - cy) / sy;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/*  Procedural face depth map                                         */
/* ------------------------------------------------------------------ */

/**
 * Returns a Z-depth for any (x, y) in the range [-1, 1].
 * The face shape smoothly emerges from a flat grid — the surrounding
 * grid stays at z ≈ 0, giving the "graph paper stretched" effect.
 */
export function faceDepth(x: number, y: number): number {
  // Elliptical boundary for the head
  const ex = x / 0.65;
  const ey = (y + 0.05) / 0.88; // shifted slightly so forehead is larger
  const r = Math.sqrt(ex * ex + ey * ey);

  // Smooth mask: 1 inside, fades to 0 at boundary
  const mask = 1 - smoothstep(0.75, 1.05, r);
  if (mask < 0.001) return 0;

  // Base dome — amplified for dramatic 3D
  let z = Math.sqrt(Math.max(0, 1 - Math.min(1, r * r))) * 0.7;

  // Forehead — broad, gently curved
  z += gauss(x, y, 0, -0.52, 0.50, 0.28) * 0.12;

  // Brow ridge — strong overhang
  z += gauss(x, y, -0.18, -0.28, 0.16, 0.055) * 0.16;
  z += gauss(x, y,  0.18, -0.28, 0.16, 0.055) * 0.16;

  // Eye sockets (deep recess)
  z -= gauss(x, y, -0.20, -0.15, 0.11, 0.075) * 0.35;
  z -= gauss(x, y,  0.20, -0.15, 0.11, 0.075) * 0.35;

  // Eyeballs (bump inside the socket)
  z += gauss(x, y, -0.20, -0.14, 0.06, 0.045) * 0.10;
  z += gauss(x, y,  0.20, -0.14, 0.06, 0.045) * 0.10;

  // Nose bridge — tall ridge
  z += gauss(x, y, 0, -0.04, 0.055, 0.20) * 0.35;

  // Nose tip — prominent
  z += gauss(x, y, 0, 0.14, 0.07, 0.045) * 0.30;

  // Nostrils (indent)
  z -= gauss(x, y, -0.07, 0.18, 0.035, 0.025) * 0.10;
  z -= gauss(x, y,  0.07, 0.18, 0.035, 0.025) * 0.10;

  // Cheekbones — pronounced
  z += gauss(x, y, -0.36, -0.02, 0.14, 0.11) * 0.15;
  z += gauss(x, y,  0.36, -0.02, 0.14, 0.11) * 0.15;

  // Philtrum (groove above lips)
  z -= gauss(x, y, 0, 0.25, 0.03, 0.04) * 0.06;

  // Lips — fuller
  z += gauss(x, y, 0, 0.30, 0.11, 0.025) * 0.12;

  // Mouth recess (below lips)
  z -= gauss(x, y, 0, 0.36, 0.10, 0.035) * 0.10;

  // Chin — stronger
  z += gauss(x, y, 0, 0.50, 0.11, 0.10) * 0.18;

  // Jaw line
  z += gauss(x, y, -0.34, 0.38, 0.11, 0.10) * 0.08;
  z += gauss(x, y,  0.34, 0.38, 0.11, 0.10) * 0.08;

  // Temple hollows — deeper
  z -= gauss(x, y, -0.45, -0.18, 0.10, 0.12) * 0.10;
  z -= gauss(x, y,  0.45, -0.18, 0.10, 0.12) * 0.10;

  return z * mask;
}

/* ------------------------------------------------------------------ */
/*  Grid mesh                                                          */
/* ------------------------------------------------------------------ */

export interface GridMesh {
  /** points[row][col] */
  points: Vec3[][];
  rows: number;
  cols: number;
}

/**
 * Sample the depth map on a regular grid.
 * `extent` controls how far the flat grid extends beyond the face (>1 = wider).
 */
export function generateFaceMesh(
  rows: number,
  cols: number,
  extent = 1.3,
): GridMesh {
  const points: Vec3[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Vec3[] = [];
    const y = -extent + (2 * extent * r) / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const x = -extent + (2 * extent * c) / (cols - 1);
      row.push({ x, y, z: faceDepth(x, y) });
    }
    points.push(row);
  }
  return { points, rows, cols };
}

/* ------------------------------------------------------------------ */
/*  Feature landmarks (face-space coordinates)                         */
/* ------------------------------------------------------------------ */

export const FEATURES = {
  leftEye:   { cx: -0.21, cy: -0.14, rx: 0.095, ry: 0.055 },
  rightEye:  { cx:  0.21, cy: -0.14, rx: 0.095, ry: 0.055 },
  leftIris:  { cx: -0.21, cy: -0.14, r: 0.035 },
  rightIris: { cx:  0.21, cy: -0.14, r: 0.035 },
  leftPupil:  { cx: -0.21, cy: -0.14, r: 0.012 },
  rightPupil: { cx:  0.21, cy: -0.14, r: 0.012 },
  mouth:     { cx: 0, cy: 0.33, rx: 0.13, ry: 0.035 },
  noseBridge: { x: 0, y0: -0.06, y1: 0.10 },
  leftNostril:  { cx: -0.055, cy: 0.16, rx: 0.025, ry: 0.018 },
  rightNostril: { cx:  0.055, cy: 0.16, rx: 0.025, ry: 0.018 },
  leftBrow:  { cx: -0.21, cy: -0.26, rx: 0.13, ry: 0.02 },
  rightBrow: { cx:  0.21, cy: -0.26, rx: 0.13, ry: 0.02 },
} as const;
