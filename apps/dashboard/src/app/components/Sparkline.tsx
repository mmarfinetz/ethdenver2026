export type SparklinePoint = {
  timestamp: string;
  value: number | null;
};

export type SparklineProps = {
  points: SparklinePoint[];
  width?: number;
  height?: number;
};

type PlotPoint = {
  x: number;
  y: number;
};

const DEFAULT_WIDTH = 148;
const DEFAULT_HEIGHT = 44;
const PADDING = 3;

function toLinePath(points: PlotPoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function toAreaPath(points: PlotPoint[], baseline: number): string {
  if (points.length === 0) {
    return "";
  }

  const first = points[0];
  const last = points[points.length - 1];
  const upper = points.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  return `M ${first.x.toFixed(2)} ${baseline.toFixed(2)} ${upper} L ${last.x.toFixed(2)} ${baseline.toFixed(2)} Z`;
}

export function Sparkline({ points, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT }: SparklineProps) {
  const safeWidth = Math.max(width, 24);
  const safeHeight = Math.max(height, 16);
  const innerWidth = Math.max(safeWidth - PADDING * 2, 1);
  const innerHeight = Math.max(safeHeight - PADDING * 2, 1);

  const validEntries = points
    .map((point, index) => ({ index, value: point.value }))
    .filter((entry): entry is { index: number; value: number } => typeof entry.value === "number" && Number.isFinite(entry.value));

  if (points.length < 2 || validEntries.length < 2) {
    return (
      <svg width={safeWidth} height={safeHeight} viewBox={`0 0 ${safeWidth} ${safeHeight}`} role="img" aria-label="No trend data">
        <rect
          x={0.5}
          y={0.5}
          width={safeWidth - 1}
          height={safeHeight - 1}
          rx={6}
          fill="rgba(255, 255, 255, 0.03)"
          stroke="rgba(255, 255, 255, 0.22)"
          strokeDasharray="3 3"
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="rgba(234, 246, 255, 0.62)"
          fontSize={Math.max(9, Math.floor(safeHeight * 0.22))}
        >
          no data
        </text>
      </svg>
    );
  }

  const minValue = Math.min(...validEntries.map((entry) => entry.value));
  const maxValue = Math.max(...validEntries.map((entry) => entry.value));
  const range = maxValue - minValue || 1;

  const xForIndex = (index: number): number => {
    if (points.length <= 1) {
      return PADDING;
    }
    return PADDING + (index / (points.length - 1)) * innerWidth;
  };

  const yForValue = (value: number): number => PADDING + ((maxValue - value) / range) * innerHeight;

  const segments: PlotPoint[][] = [];
  let currentSegment: PlotPoint[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const value = points[index]?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = [];
      continue;
    }

    currentSegment.push({
      x: xForIndex(index),
      y: yForValue(value)
    });
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  const drawableSegments = segments.filter((segment) => segment.length >= 2);
  if (drawableSegments.length === 0) {
    return (
      <svg width={safeWidth} height={safeHeight} viewBox={`0 0 ${safeWidth} ${safeHeight}`} role="img" aria-label="No trend data">
        <rect
          x={0.5}
          y={0.5}
          width={safeWidth - 1}
          height={safeHeight - 1}
          rx={6}
          fill="rgba(255, 255, 255, 0.03)"
          stroke="rgba(255, 255, 255, 0.22)"
          strokeDasharray="3 3"
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="rgba(234, 246, 255, 0.62)"
          fontSize={Math.max(9, Math.floor(safeHeight * 0.22))}
        >
          no data
        </text>
      </svg>
    );
  }

  const baseline = safeHeight - PADDING;

  return (
    <svg
      width={safeWidth}
      height={safeHeight}
      viewBox={`0 0 ${safeWidth} ${safeHeight}`}
      role="img"
      aria-label="Trend sparkline"
      preserveAspectRatio="none"
    >
      <rect
        x={0.5}
        y={0.5}
        width={safeWidth - 1}
        height={safeHeight - 1}
        rx={6}
        fill="rgba(255, 255, 255, 0.02)"
        stroke="rgba(255, 255, 255, 0.12)"
      />
      {drawableSegments.map((segment, index) => (
        <path
          key={`area-${index}`}
          d={toAreaPath(segment, baseline)}
          fill="rgba(77, 226, 188, 0.18)"
          stroke="none"
        />
      ))}
      {drawableSegments.map((segment, index) => (
        <path
          key={`line-${index}`}
          d={toLinePath(segment)}
          fill="none"
          stroke="rgba(77, 226, 188, 0.96)"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
