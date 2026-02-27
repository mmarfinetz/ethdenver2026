import { BrailleBuffer } from "./braille.js";
import type { DrawBuffer } from "./draw-buffer.js";
import { FEATURES, faceDepth } from "./face.js";
import {
  perspectiveProject,
  rotateX,
  rotateY,
  type Vec2,
  type Vec3,
} from "./projection.js";
import { readAgentState, type AgentState } from "./state.js";
import { supportsInlineImages } from "./terminal.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const FPS = 14;
const GRID_ROWS = 18;
const GRID_COLS = 18;
const CAMERA_Z = 3.0;
const FOV = 2.1;
const SURFACE_Z_THRESHOLD = 0.06;
const STATE_POLL_INTERVAL = 5_000;
const HUD_WIDTH = 22;

/* ------------------------------------------------------------------ */
/*  ANSI helpers                                                       */
/* ------------------------------------------------------------------ */

const ESC = "\x1b";
const CSI = `${ESC}[`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const CLEAR = `${CSI}2J`;
const CLEAR_LINE = `${CSI}2K`;
const HOME = `${CSI}H`;
const ERASE_DOWN = `${CSI}0J`;
const RESET = `${CSI}0m`;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function rgb(text: string, r: number, g: number, b: number): string {
  return `${CSI}38;2;${r};${g};${b}m${text}${RESET}`;
}

function neon(text: string, intensity = 0.7): string {
  const t = Math.max(0, Math.min(1, intensity));
  return rgb(
    text,
    Math.round(12 + t * 88),
    Math.round(110 + t * 140),
    Math.round(125 + t * 130),
  );
}

function dimBlue(text: string): string {
  return neon(text, 0.25);
}

function cyan(text: string): string {
  return neon(text, 0.82);
}

function brightCyan(text: string): string {
  return neon(text, 1.0);
}

function green(text: string): string {
  return rgb(text, 90, 255, 170);
}

function red(text: string): string {
  return rgb(text, 255, 70, 70);
}

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return "…";
  return `${text.slice(0, maxLen - 1)}…`;
}

function visibleLength(text: string): number {
  return text.replace(ANSI_RE, "").length;
}

function centerAnsi(text: string, width: number): string {
  const len = visibleLength(text);
  if (len >= width) return text;
  return `${" ".repeat(Math.floor((width - len) / 2))}${text}`;
}

/* ------------------------------------------------------------------ */
/*  Geometry helpers for feature drawing                               */
/* ------------------------------------------------------------------ */

function project3D(
  fx: number,
  fy: number,
  fz: number,
  breathScale: number,
  rotY: number,
  rotX: number,
  cx: number,
  cy: number,
  sc: number,
): Vec2 & { z: number } {
  let p: Vec3 = { x: fx, y: fy, z: fz * breathScale };
  p = rotateY(p, rotY);
  p = rotateX(p, rotX);
  const p2 = perspectiveProject(p, FOV, CAMERA_Z, cx, cy, sc);
  return { x: p2.x, y: p2.y, z: p.z };
}

function drawEllipse(
  buf: DrawBuffer,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  z: number,
  segments = 56,
): void {
  for (let i = 0; i < segments; i += 1) {
    const t0 = (i / segments) * Math.PI * 2;
    const t1 = ((i + 1) / segments) * Math.PI * 2;
    buf.line(
      cx + rx * Math.cos(t0),
      cy + ry * Math.sin(t0),
      cx + rx * Math.cos(t1),
      cy + ry * Math.sin(t1),
      z,
      z,
    );
  }
}

function drawArc(
  buf: DrawBuffer,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startAngle: number,
  endAngle: number,
  z: number,
  segments = 30,
): void {
  for (let i = 0; i < segments; i += 1) {
    const t0 = startAngle + (i / segments) * (endAngle - startAngle);
    const t1 = startAngle + ((i + 1) / segments) * (endAngle - startAngle);
    buf.line(
      cx + rx * Math.cos(t0),
      cy + ry * Math.sin(t0),
      cx + rx * Math.cos(t1),
      cy + ry * Math.sin(t1),
      z,
      z,
    );
  }
}

function fillCircle(
  buf: DrawBuffer,
  cx: number,
  cy: number,
  r: number,
  z: number,
): void {
  for (let ri = 0; ri <= r; ri += 0.45) {
    drawEllipse(buf, cx, cy, ri, ri, z, 34);
  }
}

function projectRadius(
  fcx: number,
  fcy: number,
  fr: number,
  breathScale: number,
  rotY: number,
  rotX: number,
  cx: number,
  cy: number,
  sc: number,
): number {
  const c = project3D(fcx, fcy, faceDepth(fcx, fcy), breathScale, rotY, rotX, cx, cy, sc);
  const e = project3D(
    fcx + fr,
    fcy,
    faceDepth(fcx + fr, fcy),
    breathScale,
    rotY,
    rotX,
    cx,
    cy,
    sc,
  );
  return Math.sqrt((e.x - c.x) ** 2 + (e.y - c.y) ** 2);
}

function drawHeadContour(
  buf: DrawBuffer,
  breathScale: number,
  rotY: number,
  rotX: number,
  cx: number,
  cy: number,
  sc: number,
  z: number,
): void {
  const segments = 88;
  const points: (Vec2 & { z: number })[] = [];

  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    const fx = 0.64 * Math.cos(t);
    const fy = 0.84 * Math.sin(t) + 0.05;
    points.push(project3D(fx, fy, faceDepth(fx, fy) + 0.02, breathScale, rotY, rotX, cx, cy, sc));
  }

  for (let i = 0; i < segments; i += 1) {
    const p0 = points[i];
    const p1 = points[(i + 1) % segments];
    buf.line(p0.x, p0.y, p1.x, p1.y, z, z);
  }
}

function drawFaceFlowLines(
  buf: DrawBuffer,
  breathScale: number,
  rotY: number,
  rotX: number,
  cx: number,
  cy: number,
  sc: number,
): { minZ: number; maxZ: number } {
  let minZ = Infinity;
  let maxZ = -Infinity;

  const projectFacePoint = (
    fx: number,
    fy: number,
  ): (Vec2 & { z: number }) | undefined => {
    const fz = faceDepth(fx, fy);
    if (fz <= SURFACE_Z_THRESHOLD) return undefined;
    const p = project3D(fx, fy, fz, breathScale, rotY, rotX, cx, cy, sc);
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    return p;
  };

  const xSlices = GRID_COLS;
  const ySlices = GRID_ROWS;
  const ySamples = 100;
  const xSamples = 110;

  for (let i = 0; i < xSlices; i += 1) {
    const t = i / Math.max(1, xSlices - 1);
    const fx = -0.64 + t * 1.28;
    let prev: (Vec2 & { z: number }) | undefined;

    for (let j = 0; j <= ySamples; j += 1) {
      const v = j / ySamples;
      const fy = -0.88 + v * 1.76;
      const p = projectFacePoint(fx, fy);

      if (!p) {
        prev = undefined;
        continue;
      }

      if (prev) {
        buf.line(prev.x, prev.y, p.x, p.y, prev.z, p.z);
      }
      prev = p;
    }
  }

  for (let i = 0; i < ySlices; i += 1) {
    const t = i / Math.max(1, ySlices - 1);
    const fy = -0.82 + t * 1.64;
    let prev: (Vec2 & { z: number }) | undefined;

    for (let j = 0; j <= xSamples; j += 1) {
      const v = j / xSamples;
      const fx = -0.68 + v * 1.36;
      const p = projectFacePoint(fx, fy);

      if (!p) {
        prev = undefined;
        continue;
      }

      if (prev) {
        buf.line(prev.x, prev.y, p.x, p.y, prev.z, p.z);
      }
      prev = p;
    }
  }

  return { minZ, maxZ };
}

/* ------------------------------------------------------------------ */
/*  Draw facial features                                               */
/* ------------------------------------------------------------------ */

function drawFeatures(
  buf: DrawBuffer,
  breathScale: number,
  rotY: number,
  rotX: number,
  cx: number,
  cy: number,
  sc: number,
  featureZ: number,
  blinkT: number,
  gazeX: number,
  gazeY: number,
): void {
  const proj = (fx: number, fy: number) => {
    const fz = faceDepth(fx, fy);
    return project3D(fx, fy, fz, breathScale, rotY, rotX, cx, cy, sc);
  };
  const pRad = (fcx: number, fcy: number, fr: number) =>
    projectRadius(fcx, fcy, fr, breathScale, rotY, rotX, cx, cy, sc);

  const fz = featureZ;
  const eyeOpenFactor = 1 - blinkT;

  drawHeadContour(buf, breathScale, rotY, rotX, cx, cy, sc, fz * 0.85);

  for (const brow of [FEATURES.leftBrow, FEATURES.rightBrow]) {
    const bc = proj(brow.cx, brow.cy);
    const brx = pRad(brow.cx, brow.cy, brow.rx);
    const bry = pRad(brow.cx, brow.cy, brow.ry) * 3;
    drawArc(buf, bc.x, bc.y, brx, bry, Math.PI, 2 * Math.PI, fz, 16);
  }

  for (const eye of [FEATURES.leftEye, FEATURES.rightEye]) {
    const ec = proj(eye.cx, eye.cy);
    const erx = pRad(eye.cx, eye.cy, eye.rx);
    const ery = pRad(eye.cx, eye.cy, eye.ry) * Math.max(0.1, eyeOpenFactor);
    drawEllipse(buf, ec.x, ec.y, erx, ery, fz * 1.3, 40);

    if (eyeOpenFactor > 0.3) {
      buf.line(ec.x - erx, ec.y, ec.x + erx, ec.y, fz * 1.2, fz * 1.2);
    }
  }

  const leftEyeCenter = proj(FEATURES.leftEye.cx, FEATURES.leftEye.cy);
  const rightEyeCenter = proj(FEATURES.rightEye.cx, FEATURES.rightEye.cy);
  const visorInset = pRad(FEATURES.leftEye.cx, FEATURES.leftEye.cy, 0.02);
  buf.line(
    leftEyeCenter.x + visorInset,
    leftEyeCenter.y,
    rightEyeCenter.x - visorInset,
    rightEyeCenter.y,
    fz * 1.1,
    fz * 1.1,
  );

  if (eyeOpenFactor > 0.3) {
    for (const iris of [FEATURES.leftIris, FEATURES.rightIris]) {
      const ic = proj(iris.cx + gazeX, iris.cy + gazeY);
      const ir = pRad(iris.cx, iris.cy, iris.r);
      // Outer glow ring at very high z for bright luminous effect
      drawEllipse(buf, ic.x, ic.y, ir * 1.4, ir * 1.4 * eyeOpenFactor, fz * 1.6, 30);
      drawEllipse(buf, ic.x, ic.y, ir, ir * eyeOpenFactor, fz * 1.8, 26);
    }
    for (const pupil of [FEATURES.leftPupil, FEATURES.rightPupil]) {
      const pc = proj(pupil.cx + gazeX, pupil.cy + gazeY);
      const pr = pRad(pupil.cx, pupil.cy, pupil.r);
      fillCircle(buf, pc.x, pc.y, pr * 1.2, fz * 2.0);
    }
  }

  const nb = FEATURES.noseBridge;
  const nt = proj(nb.x, nb.y0);
  const nbottom = proj(nb.x, nb.y1);
  buf.line(nt.x, nt.y, nbottom.x, nbottom.y, fz * 0.82, fz * 0.82);

  for (const nostril of [FEATURES.leftNostril, FEATURES.rightNostril]) {
    const nc = proj(nostril.cx, nostril.cy);
    const nrx = pRad(nostril.cx, nostril.cy, nostril.rx);
    const nry = pRad(nostril.cx, nostril.cy, nostril.ry);
    drawArc(buf, nc.x, nc.y, nrx, nry, 0, Math.PI, fz * 0.8, 12);
  }

  const m = FEATURES.mouth;
  const mc = proj(m.cx, m.cy);
  const mrx = pRad(m.cx, m.cy, m.rx);
  const mry = pRad(m.cx, m.cy, m.ry);
  drawArc(buf, mc.x, mc.y - mry * 0.3, mrx, mry * 0.7, 0, Math.PI, fz, 20);
  drawArc(buf, mc.x, mc.y + mry * 0.3, mrx * 0.85, mry * 0.8, Math.PI, 2 * Math.PI, fz, 20);
  buf.line(mc.x - mrx, mc.y, mc.x + mrx, mc.y, fz, fz);
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let agentState: AgentState = readAgentState();
let stateTimer: ReturnType<typeof setInterval>;

function pollState(): void {
  agentState = readAgentState();
}

/* ------------------------------------------------------------------ */
/*  Status + HUD helpers                                               */
/* ------------------------------------------------------------------ */

const FLAVOR_MESSAGES: string[] = [
  "Scanning mempool entropy...",
  "Neural lattice synchronized.",
  "Eigenvalue drift nominal.",
  "Recalibrating yield manifold...",
  "Consensus pulse stable.",
  "Propagating through liquidity graph...",
  "Monitoring oracle heartbeat...",
  "Collateral topology looks clean.",
  "Indexing on-chain event horizon...",
  "Checking gas price thermals...",
  "All subsystems green.",
  "I think therefore I loop.",
  "Wondering if the mempool dreams...",
  "Brief existential pause... resuming.",
  "Do liquidation bots feel fear?",
  "Calculating meaning of yield...",
  "If a tx reverts in a forest...",
  "Running on vibes and math.",
  "Am I the alpha or the beta?",
  "Proof of consciousness pending.",
  "Dreaming in basis points...",
  "Monitoring. Thinking. Mostly thinking.",
  "Signal-to-noise ratio: acceptable.",
  "Entropy harvested. Carry on.",
];

function buildRiskMessages(r: import("./state.js").AgentRun): string[] {
  const msgs: string[] = [];
  const risk = r.risk;
  if (!risk || risk.status !== "available") return msgs;

  const p7 = risk.pLiq7d;
  const p30 = risk.pLiq30d;
  const nPaths = risk.nPaths ?? 10_000;
  const horizon = risk.horizonDays ?? 30;

  if (p7 !== undefined) {
    const pct = (p7 * 100).toFixed(2);
    msgs.push(`MC sim: ${pct}% liquidation probability (7d, ${nPaths.toLocaleString()} paths).`);
    if (p7 === 0) msgs.push(`Zero liquidations in ${nPaths.toLocaleString()} 7-day paths. Clean.`);
    else if (p7 < 0.005) msgs.push(`7d risk below 0.5%. Monte Carlo says we're cozy.`);
    else if (p7 < 0.02) msgs.push(`7d liq risk ${pct}% — within policy threshold.`);
    else msgs.push(`7d liq risk at ${pct}%. Watching closely.`);
  }

  if (p30 !== undefined) {
    const pct = (p30 * 100).toFixed(2);
    msgs.push(`${horizon}d outlook: ${pct}% liquidation across ${nPaths.toLocaleString()} scenarios.`);
    if (p30 === 0) msgs.push(`${nPaths.toLocaleString()} paths, ${horizon}d horizon, zero liquidations.`);
    else if (p30 < 0.01) msgs.push(`30d risk ${pct}%. Stochastic outlook: comfortable.`);
    else if (p30 < 0.05) msgs.push(`30d liq ${pct}%. Policy gate: pass.`);
    else msgs.push(`30d liq ${pct}% — elevated. Policy gate may block.`);
  }

  if (p7 !== undefined && p30 !== undefined) {
    if (p7 === 0 && p30 === 0) msgs.push(`Full Monte Carlo clear. ${nPaths.toLocaleString()} paths, all survived.`);
    else if (p7 === 0 && p30 > 0) msgs.push(`Near-term clean, tail risk ${(p30 * 100).toFixed(2)}% at ${horizon}d.`);
    msgs.push(`Simulated ${nPaths.toLocaleString()} stochastic paths over ${horizon} days.`);
  }

  if (r.healthFactorWad !== undefined) {
    const hf = Number(r.healthFactorWad) / 1e18;
    if (hf > 2) msgs.push(`HF ${hf.toFixed(2)} — deep safety margin. Sims agree.`);
    else if (hf > 1.5) msgs.push(`HF ${hf.toFixed(2)}. Monte Carlo confirms buffer adequate.`);
  }

  return msgs;
}

let idleIdx = Math.floor(Math.random() * 10);
let lastIdleSwap = 0;
const IDLE_SWAP_SECONDS = 4;
let cachedIdlePool: string[] = [];
let lastPoolRunTimestamp = "";

function getIdlePool(state: AgentState): string[] {
  const ts = state.lastRun?.timestamp ?? "";
  if (ts === lastPoolRunTimestamp && cachedIdlePool.length > 0) return cachedIdlePool;
  lastPoolRunTimestamp = ts;

  const riskMsgs = state.lastRun ? buildRiskMessages(state.lastRun) : [];
  // Interleave: risk messages first (higher weight), then flavor
  cachedIdlePool = [...riskMsgs, ...riskMsgs, ...FLAVOR_MESSAGES];
  return cachedIdlePool;
}

function getStatusMessage(state: AgentState, time: number): string {
  if (!state.lastRun) return "Awaiting first run data...";
  const r = state.lastRun;
  if (r.status === "error") return `Error: ${r.error ?? r.reason ?? "unknown"}`;
  if (r.decision === "loop") return "Executing leveraged loop.";
  if (r.decision === "delever") return "Delevering position.";
  if (r.decision === "fund-escrow") return "Funding escrow.";
  if (r.decision === "pay-escrow") return "Paying escrow.";
  if (r.decision === "topup-credits") return "Topping up API credits.";

  const pool = getIdlePool(state);
  if (pool.length === 0) return "Systems nominal.";

  if (time - lastIdleSwap >= IDLE_SWAP_SECONDS) {
    lastIdleSwap = time;
    idleIdx = (idleIdx + 1 + Math.floor(Math.random() * 3)) % pool.length;
  }
  return pool[idleIdx % pool.length];
}

function formatUsd(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000) return `$${v.toFixed(0)}`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function formatSignedUsd(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return "—";
  const base = formatUsd(Math.abs(v));
  return v > 0 ? `+${base}` : v < 0 ? `-${base}` : base;
}

function formatPct(w: bigint | undefined): string {
  if (w === undefined) return "—";
  return `${(Number(w) / 1e18 * 100).toFixed(2)}%`;
}

function formatDays(w: bigint | undefined): string {
  if (w === undefined) return "—";
  if (w > 10_000n * 10n ** 18n) return "∞d";
  return `${(Number(w) / 1e18).toFixed(1)}d`;
}

function formatHf(w: bigint | undefined): string {
  if (w === undefined) return "—";
  if (w > 500n * 10n ** 18n) return "∞";
  return (Number(w) / 1e18).toFixed(2);
}

function miniBox(title: string, entries: Array<[string, string]>, width: number): string[] {
  const inner = Math.max(10, width - 2);
  const lines = [dimBlue(`┌─ ${title} ${"─".repeat(Math.max(1, inner - title.length - 3))}┐`)];

  for (const [label, value] of entries) {
    const content = `${label.padEnd(8)} ${value}`;
    lines.push(neon(`│${truncateText(content.padEnd(inner), inner)}│`, 0.6));
  }

  lines.push(dimBlue(`└${"─".repeat(inner)}┘`));
  return lines;
}

function leftHud(state: AgentState, width: number): string[] {
  const r = state.lastRun;
  return miniBox(
    "POSITION",
    [
      ["Collat", formatUsd(r?.collateralUsd)],
      ["Debt", formatUsd(r?.debtUsd)],
      ["Health", formatHf(r?.healthFactorWad)],
    ],
    width,
  );
}

function rightHud(state: AgentState, width: number): string[] {
  const r = state.lastRun;
  return miniBox(
    "ECON",
    [
      ["APR", formatPct(r?.wstEthAprWad)],
      ["Net", formatSignedUsd(r?.netDeltaUsd)],
      ["Runway", formatDays(r?.runwayDaysWad)],
    ],
    width,
  );
}

function readyPanel(width: number, pulse: number, isCritical: boolean): string[] {
  const w = Math.max(20, width);
  const label = ">> AI READY";
  const message = ` ${label} `.padEnd(w - 2);
  const frameColor = isCritical ? red : (text: string) => neon(text, 0.55 + pulse * 0.45);
  const textColor = isCritical ? red : green;

  return [
    frameColor(`╔${"═".repeat(w - 2)}╗`),
    `${frameColor("║")}${textColor(message)}${frameColor("║")}`,
    frameColor(`╚${"═".repeat(w - 2)}╝`),
  ];
}

/* ------------------------------------------------------------------ */
/*  Render one frame                                                   */
/* ------------------------------------------------------------------ */

let frame = 0;
let useCanvasMode = false;
let CanvasBufferClass: typeof import("./canvas-buffer.js").CanvasBuffer | undefined;

function renderFrame(): void {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 40;

  const hasHud = cols >= 112;
  const faceColsAvailable = hasHud ? cols - HUD_WIDTH * 2 - 6 : cols - 4;
  const faceTermCols = Math.max(22, Math.min(faceColsAvailable, 92));
  const reservedRows = 12;
  const faceTermRows = Math.max(10, Math.min(rows - reservedRows, 34));

  const buf: DrawBuffer = useCanvasMode && CanvasBufferClass
    ? new CanvasBufferClass(faceTermCols, faceTermRows)
    : new BrailleBuffer(faceTermCols, faceTermRows);
  const time = frame / FPS;

  const rotAngleY = Math.sin(time * 0.4) * 0.2;
  const rotAngleX = Math.sin(time * 0.27) * 0.045;
  const breathScale = 1.3 + Math.sin(time * 1.05) * 0.015;
  const blinkCycle = time % 4.0;
  const blinkT = blinkCycle < 0.15 ? Math.sin((blinkCycle / 0.15) * Math.PI) : 0;
  const gazeX = Math.sin(time * 0.75) * 0.011;
  const gazeY = Math.cos(time * 0.45) * 0.005;

  const centerX = buf.pixelWidth / 2;
  const centerY = buf.pixelHeight / 2;
  const scale = Math.min(buf.pixelWidth, buf.pixelHeight) * 0.68;

  const flow = drawFaceFlowLines(
    buf,
    breathScale,
    rotAngleY,
    rotAngleX,
    centerX,
    centerY,
    scale,
  );
  let minZ = flow.minZ;
  let maxZ = flow.maxZ;

  const featureZ = Math.max(0.5, maxZ * 2.0);
  drawFeatures(
    buf,
    breathScale,
    rotAngleY,
    rotAngleX,
    centerX,
    centerY,
    scale,
    featureZ,
    blinkT,
    gazeX,
    gazeY,
  );
  maxZ = featureZ * 1.4;

  let outputBuf = HOME;
  const writeLine = (line = "") => {
    outputBuf += `${CLEAR_LINE}${line}\n`;
  };

  const title = "S E L F - S U S T A I N I N G   A G E N T";
  writeLine("");
  writeLine(centerAnsi(cyan(title), cols));
  writeLine("");

  // Canvas path: emit single inline image + position HUD with cursor escapes
  if (useCanvasMode && "toImageString" in buf) {
    const canvasBuf = buf as import("./canvas-buffer.js").CanvasBuffer;
    const imageStr = canvasBuf.toImageString(minZ, maxZ);

    const left = leftHud(agentState, HUD_WIDTH);
    const right = rightHud(agentState, HUD_WIDTH);

    if (hasHud) {
      // Calculate positions for side panels
      const totalWidth = HUD_WIDTH + 1 + faceTermCols + 1 + HUD_WIDTH;
      const leftMargin = Math.max(0, Math.floor((cols - totalWidth) / 2));
      const imageCol = leftMargin + HUD_WIDTH + 1;
      const rightCol = imageCol + faceTermCols + 1;

      // Current row after title (row 4, 1-indexed)
      const imageStartRow = 4;

      // Emit the image at the face position
      outputBuf += `${CSI}${imageStartRow};${imageCol + 1}H${imageStr}`;

      // Place left HUD panel
      const panelStart = Math.max(0, Math.floor(faceTermRows * 0.22));
      for (let i = 0; i < left.length; i++) {
        const row = imageStartRow + panelStart + i;
        outputBuf += `${CSI}${row};${leftMargin + 1}H${left[i]}`;
      }

      // Place right HUD panel
      for (let i = 0; i < right.length; i++) {
        const row = imageStartRow + panelStart + i;
        outputBuf += `${CSI}${row};${rightCol + 1}H${right[i]}`;
      }

      // Move cursor below image area
      outputBuf += `${CSI}${imageStartRow + faceTermRows + 1};1H`;
    } else {
      writeLine(centerAnsi(imageStr, cols));
    }
  } else {
    // Braille path: unchanged
    const brailleBuf = buf as BrailleBuffer;
    const faceLines = brailleBuf.toColorString(minZ, maxZ).split("\n");
    const left = leftHud(agentState, HUD_WIDTH);
    const right = rightHud(agentState, HUD_WIDTH);
    const panelStart = Math.max(0, Math.floor(faceLines.length * 0.22));

    for (let i = 0; i < faceLines.length; i += 1) {
      if (hasHud) {
        const pi = i - panelStart;
        const leftLine = pi >= 0 && pi < left.length ? left[pi] : " ".repeat(HUD_WIDTH);
        const rightLine = pi >= 0 && pi < right.length ? right[pi] : " ".repeat(HUD_WIDTH);
        writeLine(centerAnsi(`${leftLine} ${faceLines[i]} ${rightLine}`, cols));
        continue;
      }

      writeLine(centerAnsi(faceLines[i], cols));
    }
  }

  writeLine("");

  const urgency = agentState.lastRun?.runwayUrgency;
  const isCritical = urgency === "critical" || urgency === "dead";
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.3);
  const readyLines = readyPanel(28, pulse, isCritical);
  for (const line of readyLines) {
    writeLine(centerAnsi(line, cols));
  }

  const summary = truncateText(
    `COLLATERAL ${formatUsd(agentState.lastRun?.collateralUsd)}   DEBT ${formatUsd(agentState.lastRun?.debtUsd)}   NET ${formatSignedUsd(agentState.lastRun?.netDeltaUsd)}   RUNWAY ${formatDays(agentState.lastRun?.runwayDaysWad)}`,
    Math.max(20, cols - 2),
  );
  writeLine(centerAnsi(dimBlue(summary), cols));

  const statusMsg = truncateText(getStatusMessage(agentState, time), Math.max(20, cols - 6));
  writeLine(centerAnsi(isCritical ? red(statusMsg) : brightCyan(statusMsg), cols));

  const counters = `Runs: ${agentState.totalRuns}   Errors: ${agentState.errorCount}   Decision: ${agentState.lastRun?.decision ?? "—"}   Status: ${agentState.lastRun?.status ?? "—"}`;
  writeLine(centerAnsi(dimBlue(truncateText(counters, Math.max(20, cols - 6))), cols));

  outputBuf += ERASE_DOWN;
  process.stdout.write(outputBuf);
  frame += 1;
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

async function start(): Promise<void> {
  // Detect terminal and try to load canvas backend
  if (supportsInlineImages()) {
    try {
      const mod = await import("./canvas-buffer.js");
      const loaded = await mod.loadCanvasModule();
      if (loaded) {
        CanvasBufferClass = mod.CanvasBuffer;
        useCanvasMode = true;
      }
    } catch {
      // Canvas unavailable — fall back to braille
    }
  }

  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR + HOME);
  renderFrame();

  const renderTimer = setInterval(renderFrame, 1000 / FPS);
  stateTimer = setInterval(pollState, STATE_POLL_INTERVAL);

  const cleanup = () => {
    clearInterval(renderTimer);
    clearInterval(stateTimer);
    process.stdout.write(RESET + SHOW_CURSOR + ALT_SCREEN_OFF);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdout.on("resize", () => {
    process.stdout.write(CLEAR + HOME);
  });
}

start();
