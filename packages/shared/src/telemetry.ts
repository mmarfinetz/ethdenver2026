import { jsonReplacer } from "./utils";

type TelemetryType = "run" | "autopilot-state" | "champion-state";

/**
 * Fire-and-forget push of telemetry data to the dashboard ingest endpoint.
 * No-ops silently when DASHBOARD_INGEST_URL or INGEST_SECRET are not set.
 */
export function pushTelemetry(type: TelemetryType, data: unknown): void {
  const url = process.env.DASHBOARD_INGEST_URL?.trim();
  const secret = process.env.INGEST_SECRET?.trim();

  if (!url || !secret) return;

  const body = JSON.stringify({ type, data }, jsonReplacer);

  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`
    },
    body
  }).catch((err) => {
    console.error(`[telemetry] push ${type} failed:`, err instanceof Error ? err.message : String(err));
  });
}
