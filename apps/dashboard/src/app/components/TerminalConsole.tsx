"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RunwayUrgency = "nominal" | "elevated" | "critical" | "dead" | null;

type Segment = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
};

type Point3 = {
  x: number;
  y: number;
  z: number;
};

type Point2 = {
  x: number;
  y: number;
};

export type TerminalConsoleProps = {
  decision: string;
  status: string;
  reason: string | null;
  riskNote: string | null;
  runwayUrgency: RunwayUrgency;
  collateralLabel: string;
  debtLabel: string;
  netLabel: string;
  runwayLabel: string;
  healthFactorLabel: string;
  totalRuns: number;
  errorRuns: number;
  latestTimestamp: string | null;
};

const CAMERA_Z = 3.0;
const FOV = 2.1;
const SURFACE_Z_THRESHOLD = 0.06;
const GRID_ROWS = 18;
const GRID_COLS = 18;
const DEPTH_BUCKETS = 56;

const FLAVOR_MESSAGES: string[] = [
  "Scanning mempool entropy...",
  "Neural lattice synchronized.",
  "Consensus pulse stable.",
  "Propagating liquidity graph...",
  "Monitoring oracle heartbeat...",
  "Collateral topology clean.",
  "Indexing event horizon...",
  "Checking gas thermals...",
  "All systems green.",
  "I think therefore I loop.",
  "Calculating meaning of yield...",
  "Signal to noise ratio acceptable.",
  "Entropy harvested. Carry on."
];

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function gauss(x: number, y: number, cx: number, cy: number, sx: number, sy: number): number {
  const dx = (x - cx) / sx;
  const dy = (y - cy) / sy;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function faceDepth(x: number, y: number): number {
  const ex = x / 0.65;
  const ey = (y + 0.05) / 0.88;
  const r = Math.sqrt(ex * ex + ey * ey);

  const mask = 1 - smoothstep(0.75, 1.05, r);
  if (mask < 0.001) return 0;

  let z = Math.sqrt(Math.max(0, 1 - Math.min(1, r * r))) * 0.7;
  z += gauss(x, y, 0, -0.52, 0.5, 0.28) * 0.12;

  z += gauss(x, y, -0.18, -0.28, 0.16, 0.055) * 0.16;
  z += gauss(x, y, 0.18, -0.28, 0.16, 0.055) * 0.16;

  z -= gauss(x, y, -0.2, -0.15, 0.11, 0.075) * 0.35;
  z -= gauss(x, y, 0.2, -0.15, 0.11, 0.075) * 0.35;

  z += gauss(x, y, -0.2, -0.14, 0.06, 0.045) * 0.1;
  z += gauss(x, y, 0.2, -0.14, 0.06, 0.045) * 0.1;

  z += gauss(x, y, 0, -0.04, 0.055, 0.2) * 0.35;
  z += gauss(x, y, 0, 0.14, 0.07, 0.045) * 0.3;

  z -= gauss(x, y, -0.07, 0.18, 0.035, 0.025) * 0.1;
  z -= gauss(x, y, 0.07, 0.18, 0.035, 0.025) * 0.1;

  z += gauss(x, y, -0.36, -0.02, 0.14, 0.11) * 0.15;
  z += gauss(x, y, 0.36, -0.02, 0.14, 0.11) * 0.15;

  z -= gauss(x, y, 0, 0.25, 0.03, 0.04) * 0.06;
  z += gauss(x, y, 0, 0.3, 0.11, 0.025) * 0.12;
  z -= gauss(x, y, 0, 0.36, 0.1, 0.035) * 0.1;

  z += gauss(x, y, 0, 0.5, 0.11, 0.1) * 0.18;
  z += gauss(x, y, -0.34, 0.38, 0.11, 0.1) * 0.08;
  z += gauss(x, y, 0.34, 0.38, 0.11, 0.1) * 0.08;

  z -= gauss(x, y, -0.45, -0.18, 0.1, 0.12) * 0.1;
  z -= gauss(x, y, 0.45, -0.18, 0.1, 0.12) * 0.1;

  return z * mask;
}

function rotateY(point: Point3, angle: number): Point3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: point.x * c + point.z * s,
    y: point.y,
    z: -point.x * s + point.z * c
  };
}

function rotateX(point: Point3, angle: number): Point3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: point.x,
    y: point.y * c - point.z * s,
    z: point.y * s + point.z * c
  };
}

function perspectiveProject(point: Point3, centerX: number, centerY: number, scale: number): Point2 {
  const dz = CAMERA_Z - point.z;
  const f = FOV / (dz > 0.01 ? dz : 0.01);
  return {
    x: centerX + point.x * f * scale,
    y: centerY + point.y * f * scale
  };
}

function project3d(
  x: number,
  y: number,
  z: number,
  breathScale: number,
  rotYAngle: number,
  rotXAngle: number,
  centerX: number,
  centerY: number,
  scale: number
): Point3 & Point2 {
  let point: Point3 = { x, y, z: z * breathScale };
  point = rotateY(point, rotYAngle);
  point = rotateX(point, rotXAngle);
  const projected = perspectiveProject(point, centerX, centerY, scale);
  return { ...projected, z: point.z };
}

function projectRadius(
  centerX: number,
  centerY: number,
  radius: number,
  breathScale: number,
  rotYAngle: number,
  rotXAngle: number,
  canvasCenterX: number,
  canvasCenterY: number,
  scale: number
): number {
  const start = project3d(
    centerX,
    centerY,
    faceDepth(centerX, centerY),
    breathScale,
    rotYAngle,
    rotXAngle,
    canvasCenterX,
    canvasCenterY,
    scale
  );
  const end = project3d(
    centerX + radius,
    centerY,
    faceDepth(centerX + radius, centerY),
    breathScale,
    rotYAngle,
    rotXAngle,
    canvasCenterX,
    canvasCenterY,
    scale
  );
  return Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
}

function pushLine(
  segments: Segment[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  z1: number
): void {
  segments.push({
    x0,
    y0,
    x1,
    y1,
    z: (z0 + z1) * 0.5
  });
}

function pushEllipse(
  segments: Segment[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  z: number,
  samples = 40
): void {
  for (let i = 0; i < samples; i += 1) {
    const t0 = (i / samples) * Math.PI * 2;
    const t1 = ((i + 1) / samples) * Math.PI * 2;
    pushLine(
      segments,
      cx + rx * Math.cos(t0),
      cy + ry * Math.sin(t0),
      cx + rx * Math.cos(t1),
      cy + ry * Math.sin(t1),
      z,
      z
    );
  }
}

function pushArc(
  segments: Segment[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  start: number,
  end: number,
  z: number,
  samples = 24
): void {
  for (let i = 0; i < samples; i += 1) {
    const t0 = start + (i / samples) * (end - start);
    const t1 = start + ((i + 1) / samples) * (end - start);
    pushLine(
      segments,
      cx + rx * Math.cos(t0),
      cy + ry * Math.sin(t0),
      cx + rx * Math.cos(t1),
      cy + ry * Math.sin(t1),
      z,
      z
    );
  }
}

function pushCircleFill(segments: Segment[], cx: number, cy: number, radius: number, z: number): void {
  for (let r = 0; r <= radius; r += 0.45) {
    pushEllipse(segments, cx, cy, r, r, z, 28);
  }
}

function depthColor(t: number, alpha = 1): string {
  const clamped = clamp01(t);
  const red = Math.round(5 + clamped * clamped * 135);
  const green = Math.round(60 + clamped * 195);
  const blue = Math.round(75 + clamped * 180);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function renderFace(ctx: CanvasRenderingContext2D, width: number, height: number, seconds: number): void {
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(4, 11, 20, 0.96)");
  gradient.addColorStop(1, "rgba(8, 27, 48, 0.92)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.5, height * 0.46, 8, width * 0.5, height * 0.48, width * 0.55);
  glow.addColorStop(0, "rgba(77, 226, 188, 0.2)");
  glow.addColorStop(1, "rgba(77, 226, 188, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const centerX = width * 0.5;
  const centerY = height * 0.52;
  const scale = Math.min(width, height) * 0.42;

  const breathScale = 1.3 + Math.sin(seconds * 1.05) * 0.015;
  const rotYAngle = Math.sin(seconds * 0.4) * 0.2;
  const rotXAngle = Math.sin(seconds * 0.27) * 0.045;
  const blinkCycle = seconds % 4.0;
  const blinkT = blinkCycle < 0.15 ? Math.sin((blinkCycle / 0.15) * Math.PI) : 0;
  const gazeX = Math.sin(seconds * 0.75) * 0.011;
  const gazeY = Math.cos(seconds * 0.45) * 0.005;

  const segments: Segment[] = [];
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;

  const updateDepth = (z: number) => {
    if (z < minDepth) minDepth = z;
    if (z > maxDepth) maxDepth = z;
  };

  const projectFacePoint = (x: number, y: number): (Point2 & { z: number }) | null => {
    const z = faceDepth(x, y);
    if (z <= SURFACE_Z_THRESHOLD) return null;
    const projected = project3d(x, y, z, breathScale, rotYAngle, rotXAngle, centerX, centerY, scale);
    updateDepth(projected.z);
    return projected;
  };

  for (let xSlice = 0; xSlice < GRID_COLS; xSlice += 1) {
    const tx = xSlice / Math.max(1, GRID_COLS - 1);
    const x = -0.64 + tx * 1.28;
    let prev: (Point2 & { z: number }) | null = null;

    for (let yIndex = 0; yIndex <= 100; yIndex += 1) {
      const ty = yIndex / 100;
      const y = -0.88 + ty * 1.76;
      const point = projectFacePoint(x, y);
      if (!point) {
        prev = null;
        continue;
      }
      if (prev) {
        pushLine(segments, prev.x, prev.y, point.x, point.y, prev.z, point.z);
      }
      prev = point;
    }
  }

  for (let ySlice = 0; ySlice < GRID_ROWS; ySlice += 1) {
    const ty = ySlice / Math.max(1, GRID_ROWS - 1);
    const y = -0.82 + ty * 1.64;
    let prev: (Point2 & { z: number }) | null = null;

    for (let xIndex = 0; xIndex <= 110; xIndex += 1) {
      const tx = xIndex / 110;
      const x = -0.68 + tx * 1.36;
      const point = projectFacePoint(x, y);
      if (!point) {
        prev = null;
        continue;
      }
      if (prev) {
        pushLine(segments, prev.x, prev.y, point.x, point.y, prev.z, point.z);
      }
      prev = point;
    }
  }

  const featureZ = Math.max(0.5, maxDepth * 2.0);
  const eyeOpenFactor = 1 - blinkT;

  const projectFeature = (x: number, y: number) =>
    project3d(x, y, faceDepth(x, y), breathScale, rotYAngle, rotXAngle, centerX, centerY, scale);
  const projectFeatureRadius = (x: number, y: number, r: number) =>
    projectRadius(x, y, r, breathScale, rotYAngle, rotXAngle, centerX, centerY, scale);

  const eyeCenters = [
    { x: -0.21, y: -0.14 },
    { x: 0.21, y: -0.14 }
  ];

  for (const eye of eyeCenters) {
    const center = projectFeature(eye.x, eye.y);
    const rx = projectFeatureRadius(eye.x, eye.y, 0.095);
    const ry = projectFeatureRadius(eye.x, eye.y, 0.055) * Math.max(0.1, eyeOpenFactor);

    pushEllipse(segments, center.x, center.y, rx, ry, featureZ * 1.3, 44);
    if (eyeOpenFactor > 0.3) {
      pushLine(segments, center.x - rx, center.y, center.x + rx, center.y, featureZ * 1.2, featureZ * 1.2);
    }
  }

  const leftEye = projectFeature(-0.21, -0.14);
  const rightEye = projectFeature(0.21, -0.14);
  const visorInset = projectFeatureRadius(-0.21, -0.14, 0.02);
  pushLine(
    segments,
    leftEye.x + visorInset,
    leftEye.y,
    rightEye.x - visorInset,
    rightEye.y,
    featureZ * 1.1,
    featureZ * 1.1
  );

  if (eyeOpenFactor > 0.3) {
    const irisCenters = [
      { x: -0.21 + gazeX, y: -0.14 + gazeY },
      { x: 0.21 + gazeX, y: -0.14 + gazeY }
    ];

    for (const iris of irisCenters) {
      const center = projectFeature(iris.x, iris.y);
      const radius = projectFeatureRadius(iris.x, iris.y, 0.035);
      pushEllipse(segments, center.x, center.y, radius * 1.4, radius * 1.4 * eyeOpenFactor, featureZ * 1.6, 30);
      pushEllipse(segments, center.x, center.y, radius, radius * eyeOpenFactor, featureZ * 1.8, 24);
    }

    const pupilCenters = [
      { x: -0.21 + gazeX, y: -0.14 + gazeY },
      { x: 0.21 + gazeX, y: -0.14 + gazeY }
    ];

    for (const pupil of pupilCenters) {
      const center = projectFeature(pupil.x, pupil.y);
      const radius = projectFeatureRadius(pupil.x, pupil.y, 0.012);
      pushCircleFill(segments, center.x, center.y, radius * 1.2, featureZ * 2.0);
    }
  }

  const brows = [
    { x: -0.21, y: -0.26 },
    { x: 0.21, y: -0.26 }
  ];

  for (const brow of brows) {
    const center = projectFeature(brow.x, brow.y);
    const rx = projectFeatureRadius(brow.x, brow.y, 0.13);
    const ry = projectFeatureRadius(brow.x, brow.y, 0.02) * 2.8;
    pushArc(segments, center.x, center.y, rx, ry, Math.PI, 2 * Math.PI, featureZ, 16);
  }

  const noseTop = projectFeature(0, -0.06);
  const noseBottom = projectFeature(0, 0.1);
  pushLine(segments, noseTop.x, noseTop.y, noseBottom.x, noseBottom.y, featureZ * 0.82, featureZ * 0.82);

  const nostrils = [
    { x: -0.055, y: 0.16, rx: 0.025, ry: 0.018 },
    { x: 0.055, y: 0.16, rx: 0.025, ry: 0.018 }
  ];

  for (const nostril of nostrils) {
    const center = projectFeature(nostril.x, nostril.y);
    const rx = projectFeatureRadius(nostril.x, nostril.y, nostril.rx);
    const ry = projectFeatureRadius(nostril.x, nostril.y, nostril.ry);
    pushArc(segments, center.x, center.y, rx, ry, 0, Math.PI, featureZ * 0.8, 12);
  }

  const mouthCenter = projectFeature(0, 0.33);
  const mouthRx = projectFeatureRadius(0, 0.33, 0.13);
  const mouthRy = projectFeatureRadius(0, 0.33, 0.035);
  pushArc(segments, mouthCenter.x, mouthCenter.y - mouthRy * 0.3, mouthRx, mouthRy * 0.7, 0, Math.PI, featureZ, 20);
  pushArc(
    segments,
    mouthCenter.x,
    mouthCenter.y + mouthRy * 0.3,
    mouthRx * 0.85,
    mouthRy * 0.8,
    Math.PI,
    2 * Math.PI,
    featureZ,
    20
  );
  pushLine(
    segments,
    mouthCenter.x - mouthRx,
    mouthCenter.y,
    mouthCenter.x + mouthRx,
    mouthCenter.y,
    featureZ,
    featureZ
  );

  maxDepth = Math.max(maxDepth, featureZ * 1.4);

  const buckets: Segment[][] = Array.from({ length: DEPTH_BUCKETS }, () => []);
  if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
    return;
  }
  const depthRange = maxDepth - minDepth || 1;

  for (const segment of segments) {
    const t = clamp01((segment.z - minDepth) / depthRange);
    const bucket = Math.min(DEPTH_BUCKETS - 1, Math.floor(t * DEPTH_BUCKETS));
    buckets[bucket].push(segment);
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let i = 0; i < DEPTH_BUCKETS; i += 1) {
    const bucket = buckets[i];
    if (bucket.length === 0) continue;

    const t = (i + 0.5) / DEPTH_BUCKETS;
    ctx.strokeStyle = depthColor(t, 0.26 + t * 0.7);
    ctx.lineWidth = 0.45 + t * 1.15;
    ctx.beginPath();
    for (const segment of bucket) {
      ctx.moveTo(segment.x0, segment.y0);
      ctx.lineTo(segment.x1, segment.y1);
    }
    ctx.stroke();
  }
}

function formatAge(timestamp: string | null): string {
  if (!timestamp) return "unknown";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "unknown";

  const now = Date.now();
  const diff = Math.max(0, now - parsed);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;

  if (diff < minute) return "now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

function decisionMessage(decision: string): string {
  if (decision === "loop") return "Executing leveraged loop.";
  if (decision === "delever") return "Delevering position.";
  if (decision === "fund-escrow") return "Funding escrow.";
  if (decision === "pay-escrow") return "Paying escrow.";
  if (decision === "topup-credits") return "Topping up Conway credits.";
  return "Systems nominal.";
}

function statusMessage(props: TerminalConsoleProps, idlePool: string[], idleIndex: number): string {
  if (!props.latestTimestamp) return "Awaiting first run data...";
  if (props.status === "error") return `Error: ${props.reason ?? "unknown"}`;
  if (props.decision !== "none") return decisionMessage(props.decision);
  if (idlePool.length === 0) return "Systems nominal.";
  return idlePool[idleIndex % idlePool.length];
}

export function TerminalConsole(props: TerminalConsoleProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [idleIndex, setIdleIndex] = useState(() => Math.floor(Math.random() * FLAVOR_MESSAGES.length));

  const urgencyCritical = props.runwayUrgency === "critical" || props.runwayUrgency === "dead";

  const idlePool = useMemo(() => {
    const pool: string[] = [];
    if (props.riskNote && props.riskNote.trim().length > 0) {
      pool.push(props.riskNote.trim());
      pool.push(props.riskNote.trim());
    }
    pool.push(...FLAVOR_MESSAGES);
    return pool;
  }, [props.riskNote]);

  const line = useMemo(() => statusMessage(props, idlePool, idleIndex), [props, idlePool, idleIndex]);

  useEffect(() => {
    const timer = setInterval(() => {
      setIdleIndex((prev) => prev + 1 + Math.floor(Math.random() * 2));
    }, 4_000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    let frameHandle = 0;
    let width = 0;
    let height = 0;
    let start = performance.now();

    const resize = () => {
      const rect = shell.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      width = Math.max(320, Math.floor(rect.width));
      height = Math.max(220, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const loop = (timestamp: number) => {
      const seconds = (timestamp - start) / 1000;
      renderFace(context, width, height, seconds);
      frameHandle = window.requestAnimationFrame(loop);
    };

    const observer = new ResizeObserver(() => {
      resize();
    });

    observer.observe(shell);
    resize();
    frameHandle = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frameHandle);
      observer.disconnect();
    };
  }, []);

  return (
    <section className="terminal-card" aria-label="Terminal console view">
      <div className="terminal-head">
        <span className="terminal-kicker">Terminal Bridge</span>
        <span className="terminal-age">latest run {formatAge(props.latestTimestamp)}</span>
      </div>

      <div className="terminal-stage">
        <div className="terminal-shell" ref={shellRef}>
          <canvas ref={canvasRef} />

          <aside className="hud left">
            <div className="hud-box">
              <span className="hud-title">Position</span>
              <span>Collat {props.collateralLabel}</span>
              <span>Debt {props.debtLabel}</span>
              <span>HF {props.healthFactorLabel}</span>
            </div>
          </aside>

          <aside className="hud right">
            <div className="hud-box">
              <span className="hud-title">Econ</span>
              <span>Net {props.netLabel}</span>
              <span>Runway {props.runwayLabel}</span>
              <span>Urgency {props.runwayUrgency ?? "--"}</span>
            </div>
          </aside>
        </div>

        <div className={`ready ${urgencyCritical ? "critical" : ""}`}>
          <span>&gt;&gt; AI READY</span>
        </div>

        <p className={`line ${urgencyCritical ? "critical" : ""}`}>{line}</p>
        <p className="counts">
          Runs {props.totalRuns} | Errors {props.errorRuns} | Decision {props.decision} | Status {props.status}
        </p>
      </div>

      <style jsx>{`
        .terminal-card {
          background: linear-gradient(140deg, rgba(9, 30, 52, 0.94), rgba(2, 14, 28, 0.96));
          border: 1px solid rgba(77, 226, 188, 0.28);
          border-radius: 16px;
          padding: 12px;
          display: grid;
          gap: 10px;
          overflow: hidden;
        }

        .terminal-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .terminal-kicker {
          text-transform: uppercase;
          letter-spacing: 0.09em;
          font-size: 0.72rem;
          color: rgba(155, 184, 209, 0.94);
        }

        .terminal-age {
          font-size: 0.75rem;
          color: rgba(155, 184, 209, 0.9);
          font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
        }

        .terminal-stage {
          display: grid;
          gap: 10px;
        }

        .terminal-shell {
          position: relative;
          min-height: 300px;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid rgba(77, 226, 188, 0.2);
          background: rgba(0, 0, 0, 0.26);
        }

        canvas {
          display: block;
          width: 100%;
          height: 100%;
        }

        .hud {
          position: absolute;
          top: 12px;
          bottom: 12px;
          width: min(22vw, 170px);
          pointer-events: none;
          display: flex;
          align-items: center;
        }

        .hud.left {
          left: 10px;
          justify-content: flex-start;
        }

        .hud.right {
          right: 10px;
          justify-content: flex-end;
        }

        .hud-box {
          width: 100%;
          display: grid;
          gap: 4px;
          padding: 8px;
          border-radius: 10px;
          border: 1px solid rgba(77, 226, 188, 0.24);
          background: rgba(5, 21, 38, 0.68);
          color: rgba(205, 245, 234, 0.96);
          font-size: 0.76rem;
          font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .hud-title {
          color: rgba(234, 246, 255, 0.95);
          font-size: 0.7rem;
          letter-spacing: 0.1em;
          margin-bottom: 4px;
        }

        .ready {
          border: 1px solid rgba(90, 255, 170, 0.6);
          border-radius: 10px;
          padding: 7px 10px;
          color: rgba(132, 255, 186, 0.97);
          font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
          text-align: center;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          animation: readyPulse 1.5s ease-in-out infinite;
          background: rgba(4, 22, 18, 0.7);
        }

        .ready.critical {
          border-color: rgba(255, 130, 130, 0.75);
          color: rgba(255, 170, 170, 0.97);
          background: rgba(43, 8, 8, 0.72);
        }

        .line {
          margin: 0;
          text-align: center;
          font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
          color: rgba(130, 240, 255, 0.95);
          font-size: 0.85rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .line.critical {
          color: rgba(255, 159, 159, 0.96);
        }

        .counts {
          margin: 0;
          text-align: center;
          font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
          color: rgba(155, 184, 209, 0.88);
          font-size: 0.78rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        @keyframes readyPulse {
          0%,
          100% {
            box-shadow: 0 0 0 rgba(77, 226, 188, 0);
          }
          50% {
            box-shadow: 0 0 24px rgba(77, 226, 188, 0.22);
          }
        }

        @media (max-width: 860px) {
          .terminal-shell {
            min-height: 250px;
          }

          .hud {
            display: none;
          }

          .line,
          .counts {
            white-space: normal;
            text-overflow: unset;
          }
        }
      `}</style>
    </section>
  );
}
