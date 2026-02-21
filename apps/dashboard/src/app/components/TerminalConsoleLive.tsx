"use client";

import { useEffect, useRef, useState } from "react";
import { fmt, fmtHf } from "../../lib/format";
import { TerminalConsole, type TerminalConsoleProps } from "./TerminalConsole";

type TerminalConsoleLiveProps = {
  initial: TerminalConsoleProps;
  pollIntervalMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object") return null;
  return value as UnknownRecord;
}

function parseBigIntLike(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value);
  return null;
}

function parseRunwayUrgency(value: unknown): TerminalConsoleProps["runwayUrgency"] {
  if (value === "nominal" || value === "elevated" || value === "critical" || value === "dead") {
    return value;
  }
  return null;
}

function parseIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

function toRunwayLabel(value: bigint | null): string {
  if (value == null) return "--";
  const days = Number(value) / 1e18;
  if (!Number.isFinite(days)) return "--";
  return `${days.toFixed(2)}d`;
}

function buildConsoleProps(statePayload: unknown, runsPayload: unknown, fallback: TerminalConsoleProps): TerminalConsoleProps {
  const state = asRecord(statePayload);
  const runs = asRecord(runsPayload);

  const position = asRecord(state?.position);
  const freshness = asRecord(state?.freshness);
  const runsList = Array.isArray(runs?.runs) ? runs.runs : null;
  const latestRun = runsList && runsList.length > 0 ? asRecord(runsList[0]) : null;

  const collateralBase = parseBigIntLike(position?.totalCollateralBase);
  const debtBase = parseBigIntLike(position?.totalDebtBase);
  const healthFactor = parseBigIntLike(position?.healthFactor);
  const netCarry = parseBigIntLike(state?.netCarryEstimateUsd);
  const runwayDays = parseBigIntLike(state?.liveRunwayDaysWad);
  const runwayUrgency = parseRunwayUrgency(state?.liveRunwayUrgency);
  const latestTimestamp = parseIso(freshness?.latestRun);

  const totalRuns = runsList ? runsList.length : fallback.totalRuns;
  const errorRuns = runsList
    ? runsList.filter((run) => asRecord(run)?.status === "error").length
    : fallback.errorRuns;

  return {
    decision: typeof latestRun?.decision === "string" ? latestRun.decision : fallback.decision,
    status: typeof state?.lastRunStatus === "string" ? state.lastRunStatus : fallback.status,
    reason: typeof state?.lastRunReason === "string" ? state.lastRunReason : fallback.reason,
    riskNote: typeof state?.riskNote === "string" ? state.riskNote : fallback.riskNote,
    runwayUrgency: runwayUrgency ?? fallback.runwayUrgency,
    collateralLabel: collateralBase == null ? fallback.collateralLabel : fmt(collateralBase, 8, "USD"),
    debtLabel: debtBase == null ? fallback.debtLabel : fmt(debtBase, 8, "USD"),
    netLabel: netCarry == null ? fallback.netLabel : fmt(netCarry, 8, "USD"),
    runwayLabel: runwayDays == null ? fallback.runwayLabel : toRunwayLabel(runwayDays),
    healthFactorLabel: healthFactor == null ? fallback.healthFactorLabel : fmtHf(healthFactor),
    totalRuns,
    errorRuns,
    latestTimestamp: latestTimestamp ?? fallback.latestTimestamp
  };
}

export function TerminalConsoleLive({ initial, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: TerminalConsoleLiveProps) {
  const [consoleProps, setConsoleProps] = useState<TerminalConsoleProps>(initial);
  const propsRef = useRef<TerminalConsoleProps>(initial);

  useEffect(() => {
    propsRef.current = initial;
    setConsoleProps(initial);
  }, [initial]);

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
        const [stateResponse, runsResponse] = await Promise.all([
          fetch("/api/state", {
            method: "GET",
            cache: "no-store",
            signal: controller.signal
          }),
          fetch("/api/runs", {
            method: "GET",
            cache: "no-store",
            signal: controller.signal
          })
        ]);

        if (!stateResponse.ok || !runsResponse.ok) return;

        const [stateJson, runsJson] = await Promise.all([stateResponse.json(), runsResponse.json()]);
        const next = buildConsoleProps(stateJson, runsJson, propsRef.current);
        if (!active) return;

        propsRef.current = next;
        setConsoleProps(next);
      } catch {
        // Keep existing UI state when polling fails.
      } finally {
        inFlight = false;
        if (active) {
          timer = setTimeout(poll, pollIntervalMs);
        }
      }
    };

    void poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
    };
  }, [pollIntervalMs]);

  return <TerminalConsole {...consoleProps} />;
}
