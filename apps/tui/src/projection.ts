export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Perspective-project a 3-D point onto a 2-D pixel plane. */
export function perspectiveProject(
  p: Vec3,
  fov: number,
  cameraZ: number,
  centerX: number,
  centerY: number,
  scale: number,
): Vec2 {
  const dz = cameraZ - p.z;
  const f = fov / (dz > 0.01 ? dz : 0.01);
  return {
    x: centerX + p.x * f * scale,
    y: centerY + p.y * f * scale,
  };
}

/** Rotate a point around the Y axis. */
export function rotateY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

/** Rotate a point around the X axis. */
export function rotateX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}
