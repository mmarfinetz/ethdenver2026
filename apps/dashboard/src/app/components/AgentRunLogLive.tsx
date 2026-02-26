"use client";

import { useEffect, useRef, useState } from "react";

export type AgentRunLogEntry = {
  timestamp: string;
  status: string;
  decision: string;
  summary: string;
  userOpHash: string | null;
  txHash: string | null;
  receiptStatus: string;
  topupStatus: string | null;
};

type AgentRunLogLiveProps = {
  initialRuns: AgentRunLogEntry[];
  pollIntervalMs?: number;
  maxRows?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ROWS = 18;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object") return null;
  return value as UnknownRecord;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeRuns(payload: unknown): AgentRunLogEntry[] {
  const data = asRecord(payload);
  if (!data) return [];
  const rows = Array.isArray(data.runs) ? data.runs : [];
  const normalized: AgentRunLogEntry[] = [];

  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const timestamp = asText(item.timestamp);
    const status = asText(item.status);
    const decision = asText(item.decision);
    if (!timestamp || !status || !decision) continue;

    normalized.push({
      timestamp,
      status,
      decision,
      summary: asText(item.summary) ?? "",
      userOpHash: asText(item.userOpHash),
      txHash: asText(item.txHash),
      receiptStatus: asText(item.receiptStatus) ?? "unknown",
      topupStatus: asText(item.topupStatus)
    });
  }

  return normalized;
}

function shortHash(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleTimeString();
}

function statusTone(status: string): "ok" | "warn" | "err" | "neutral" {
  const normalized = status.toLowerCase();
  if (normalized.includes("error") || normalized.includes("fail") || normalized.includes("revert")) return "err";
  if (normalized.includes("skip") || normalized.includes("unknown") || normalized.includes("pending")) return "warn";
  if (normalized.includes("ok") || normalized.includes("success")) return "ok";
  return "neutral";
}

function toLogLine(run: AgentRunLogEntry): string {
  const summary = run.summary.trim().length > 0 ? run.summary.trim() : "no summary";
  const txPart = run.txHash ? ` tx=${shortHash(run.txHash)}` : "";
  const userOpPart = run.userOpHash ? ` userOp=${shortHash(run.userOpHash)}` : "";
  const receiptPart = run.receiptStatus === "offchain" ? "" : ` receipt=${run.receiptStatus}`;
  const topupPart = run.topupStatus ? ` topup=${run.topupStatus}` : "";
  return `[${formatTimestamp(run.timestamp)}] ${run.status} ${run.decision} ${summary}${receiptPart}${topupPart}${userOpPart}${txPart}`;
}

export function AgentRunLogLive({
  initialRuns,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxRows = DEFAULT_MAX_ROWS
}: AgentRunLogLiveProps) {
  const initial = initialRuns.slice(0, maxRows);
  const [runs, setRuns] = useState<AgentRunLogEntry[]>(initial);
  const runsRef = useRef<AgentRunLogEntry[]>(initial);

  useEffect(() => {
    const next = initialRuns.slice(0, maxRows);
    runsRef.current = next;
    setRuns(next);
  }, [initialRuns, maxRows]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let controller: AbortController | null = null;

    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      controller = new AbortController();

      try {
        const response = await fetch("/api/runs", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) return;
        const json = await response.json();
        const nextRuns = normalizeRuns(json).slice(0, maxRows);
        if (!active) return;

        runsRef.current = nextRuns;
        setRuns(nextRuns);
      } catch {
        // Keep existing logs when polling fails.
      } finally {
        inFlight = false;
        if (active) timer = setTimeout(poll, pollIntervalMs);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
    };
  }, [maxRows, pollIntervalMs]);

  return (
    <section className="section" id="agent-live-logs">
      <div className="section-head">
        <h2>Live Agent Logs</h2>
        <div className="staleness-row">
          <span className="staleness-chip">poll {Math.round(pollIntervalMs / 1000)}s</span>
          <span className="staleness-chip">{runs.length > 0 ? `entries ${runs.length}` : "no entries"}</span>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="empty">No run logs yet.</p>
      ) : (
        <div className="log-list" role="log" aria-live="polite" aria-label="Live agent log lines">
          {runs.map((run, index) => (
            <p className={`log-line tone-${statusTone(run.status)}`} key={`${run.timestamp}-${run.status}-${index}`}>
              {toLogLine(run)}
            </p>
          ))}
        </div>
      )}

      <style jsx>{`
        .log-list {
          display: grid;
          gap: 8px;
          max-height: 360px;
          overflow: auto;
          padding-right: 4px;
        }

        .log-line {
          margin: 0;
          padding: 9px 10px;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: rgba(0, 0, 0, 0.16);
          font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
          font-size: 0.77rem;
          line-height: 1.45;
          word-break: break-word;
        }

        .log-line.tone-ok {
          border-color: rgba(77, 226, 188, 0.35);
        }

        .log-line.tone-warn {
          border-color: rgba(255, 210, 123, 0.35);
        }

        .log-line.tone-err {
          border-color: rgba(255, 139, 139, 0.35);
        }

        .log-line.tone-neutral {
          border-color: rgba(159, 183, 207, 0.3);
        }
      `}</style>
    </section>
  );
}
