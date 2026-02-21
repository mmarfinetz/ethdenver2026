"use client";

import { useMemo, useState } from "react";
import { CopyableText } from "./CopyableText";

type ActivityFilter = "all" | "failed" | "unverified" | "topups";

export type ActivityTimelineRow = {
  timestamp: string;
  source: string;
  action: string;
  status: string;
  userOpHash?: string | null;
  txHash?: string | null;
  txHref?: string | null;
  summary?: string | null;
};

export type ActivityTimelineProps = {
  rows: ActivityTimelineRow[];
};

const FILTER_OPTIONS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "all" },
  { value: "failed", label: "failed" },
  { value: "unverified", label: "unverified" },
  { value: "topups", label: "topups" }
];

function shortHash(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function isFailedStatus(status: string): boolean {
  const normalized = normalizeStatus(status);
  return normalized.includes("fail") || normalized.includes("error") || normalized.includes("revert");
}

function isUnverifiedStatus(status: string): boolean {
  const normalized = normalizeStatus(status);
  return normalized.includes("unverified") || normalized.includes("pending") || normalized.includes("unknown");
}

function isTopupRow(row: ActivityTimelineRow): boolean {
  const action = row.action.trim().toLowerCase();
  const source = row.source.trim().toLowerCase();
  return action === "topup-credits" || source.includes("top-up") || source.includes("topup");
}

function matchesFilter(row: ActivityTimelineRow, filter: ActivityFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "failed") {
    return isFailedStatus(row.status);
  }
  if (filter === "topups") {
    return isTopupRow(row);
  }
  return isUnverifiedStatus(row.status);
}

function statusTone(status: string): "ok" | "warn" | "err" {
  if (isFailedStatus(status)) {
    return "err";
  }
  if (isUnverifiedStatus(status)) {
    return "warn";
  }
  return "ok";
}

export function ActivityTimeline({ rows }: ActivityTimelineProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const counts = useMemo(
    () => ({
      all: rows.length,
      failed: rows.filter((row) => isFailedStatus(row.status)).length,
      unverified: rows.filter((row) => isUnverifiedStatus(row.status)).length,
      topups: rows.filter((row) => isTopupRow(row)).length
    }),
    [rows]
  );

  const filteredRows = useMemo(() => rows.filter((row) => matchesFilter(row, filter)), [rows, filter]);

  return (
    <section className="timeline" aria-label="Activity timeline">
      <div className="filters" role="group" aria-label="Filter activity rows">
        {FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`filterButton ${filter === option.value ? "active" : ""}`}
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
            <span className="count">{counts[option.value]}</span>
          </button>
        ))}
      </div>

      {filteredRows.length === 0 ? (
        <p className="empty">No activity rows for this filter.</p>
      ) : (
        <div className="table" role="table" aria-label="Activity rows">
          <div className="header row" role="row">
            <span role="columnheader">Time</span>
            <span role="columnheader">Source</span>
            <span role="columnheader">Action</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">UserOp</span>
            <span role="columnheader">Tx</span>
            <span role="columnheader">Summary</span>
          </div>

          {filteredRows.map((row, index) => (
            <article
              className="row bodyRow"
              role="row"
              key={`${row.timestamp}-${row.source}-${row.action}-${row.status}-${row.userOpHash ?? "na"}-${row.txHash ?? "na"}-${index}`}
            >
              <div className="cell" role="cell" data-label="Time">
                {formatTimestamp(row.timestamp)}
              </div>
              <div className="cell" role="cell" data-label="Source">
                {row.source}
              </div>
              <div className="cell" role="cell" data-label="Action">
                {row.action}
              </div>
              <div className="cell" role="cell" data-label="Status">
                <span className={`status ${statusTone(row.status)}`}>{row.status}</span>
              </div>
              <div className="cell" role="cell" data-label="UserOp">
                {row.userOpHash ? (
                  <CopyableText fullValue={row.userOpHash} shortLabel={shortHash(row.userOpHash)} />
                ) : (
                  "--"
                )}
              </div>
              <div className="cell" role="cell" data-label="Tx">
                {row.txHash ? (
                  <CopyableText fullValue={row.txHash} shortLabel={shortHash(row.txHash)} href={row.txHref ?? undefined} />
                ) : (
                  "--"
                )}
              </div>
              <div className="cell summary" role="cell" data-label="Summary">
                {row.summary?.trim() ? row.summary : "--"}
              </div>
            </article>
          ))}
        </div>
      )}

      <style jsx>{`
        .timeline {
          display: grid;
          gap: 10px;
        }

        .filters {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .filterButton {
          border: 1px solid var(--line);
          background: rgba(0, 0, 0, 0.18);
          color: var(--ink);
          border-radius: 999px;
          padding: 6px 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-size: 0.72rem;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .filterButton:hover {
          border-color: rgba(77, 226, 188, 0.4);
        }

        .filterButton.active {
          border-color: rgba(77, 226, 188, 0.5);
          background: rgba(77, 226, 188, 0.12);
          color: var(--accent);
        }

        .count {
          color: var(--muted);
          font-size: 0.75rem;
        }

        .table {
          border: 1px solid var(--line);
          border-radius: 12px;
          overflow: hidden;
        }

        .row {
          display: grid;
          gap: 8px;
          grid-template-columns: minmax(150px, 1.2fr) minmax(90px, 0.8fr) minmax(100px, 0.9fr) minmax(90px, 0.75fr) minmax(130px, 1fr) minmax(130px, 1fr) minmax(180px, 1.45fr);
          align-items: start;
          padding: 9px 10px;
          border-bottom: 1px solid var(--line);
          font-size: 0.84rem;
        }

        .row:last-child {
          border-bottom: 0;
        }

        .header {
          color: var(--muted);
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          background: rgba(255, 255, 255, 0.02);
        }

        .bodyRow {
          background: rgba(0, 0, 0, 0.12);
        }

        .cell {
          min-width: 0;
          word-break: break-word;
        }

        .summary {
          color: var(--muted);
        }

        .status {
          border-radius: 999px;
          border: 1px solid var(--line);
          padding: 3px 8px;
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          display: inline-flex;
        }

        .status.ok {
          border-color: rgba(77, 226, 188, 0.45);
          color: var(--accent);
        }

        .status.warn {
          border-color: rgba(255, 210, 123, 0.45);
          color: var(--warn);
        }

        .status.err {
          border-color: rgba(255, 139, 139, 0.5);
          color: var(--bad);
        }

        .empty {
          color: var(--muted);
          border: 1px dashed var(--line);
          border-radius: 10px;
          padding: 12px;
          margin: 0;
        }

        @media (max-width: 980px) {
          .row {
            grid-template-columns: 1fr;
            gap: 6px;
          }

          .header {
            display: none;
          }

          .bodyRow {
            border-radius: 10px;
            border: 1px solid var(--line);
            margin: 8px;
          }

          .cell {
            display: grid;
            grid-template-columns: 82px minmax(0, 1fr);
            gap: 8px;
            align-items: start;
          }

          .cell::before {
            content: attr(data-label);
            color: var(--muted);
            font-size: 0.68rem;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            line-height: 1.35;
          }
        }
      `}</style>
    </section>
  );
}
