import { ActivityTimeline, CopyableText, Sparkline, TerminalConsoleLive, type ActivityTimelineRow } from "./components";
import { fmt, fmtHf, fmtPercentWad, fmtShortHash } from "../lib/format";
import { queryDashboardState, queryRecentRuns } from "../lib/queries";

export const dynamic = "force-dynamic";

type Tone = "ok" | "warn" | "err" | "neutral";
type FreshnessTone = "fresh" | "aging" | "stale" | "unknown";
type RecentRunItem = Awaited<ReturnType<typeof queryRecentRuns>>["runs"][number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HF_WARN = 1_100_000_000_000_000_000n;
const HF_OK = 1_250_000_000_000_000_000n;

function toTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function formatTimestamp(value: string | null | undefined): string {
  const ms = toTimestampMs(value);
  if (ms == null) return "--";
  return new Date(ms).toLocaleString();
}

function formatAge(timestampMs: number | null, nowMs: number): string {
  if (timestampMs == null) return "unknown";
  const diff = Math.max(0, nowMs - timestampMs);

  if (diff < MINUTE_MS) return "now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  return `${Math.floor(diff / DAY_MS)}d ago`;
}

function freshnessTone(timestampMs: number | null, nowMs: number): FreshnessTone {
  if (timestampMs == null) return "unknown";
  const diff = Math.max(0, nowMs - timestampMs);

  if (diff <= 5 * MINUTE_MS) return "fresh";
  if (diff <= 30 * MINUTE_MS) return "aging";
  return "stale";
}

function toneClass(tone: Tone): string {
  return `tone-${tone}`;
}

function freshnessClass(tone: FreshnessTone): string {
  return `freshness-${tone}`;
}

function boolTone(value: boolean | null): Tone {
  if (value == null) return "neutral";
  return value ? "ok" : "err";
}

function boolLabel(value: boolean | null, ok = "pass", err = "fail"): string {
  if (value == null) return "--";
  return value ? ok : err;
}

function lastRunTone(status: string | null): Tone {
  if (status == null) return "neutral";
  if (status === "ok") return "ok";
  if (status === "error") return "err";
  return "warn";
}

function runwayTone(urgency: string | null): Tone {
  if (urgency == null) return "neutral";
  if (urgency === "nominal") return "ok";
  if (urgency === "elevated") return "warn";
  if (urgency === "critical" || urgency === "dead") return "err";
  return "neutral";
}

function topupTone(status: string | null): Tone {
  if (status == null) return "neutral";
  if (status === "ok") return "ok";
  if (status === "skipped") return "warn";
  if (status === "error") return "err";
  return "neutral";
}

function healthFactorTone(value: bigint): Tone {
  if (value > 10n ** 30n) return "ok";
  if (value >= HF_OK) return "ok";
  if (value >= HF_WARN) return "warn";
  return "err";
}

function healthFactorLabel(value: bigint): string {
  if (value > 10n ** 30n) return "infinite buffer";
  if (value >= HF_OK) return "stable";
  if (value >= HF_WARN) return "watch";
  return "critical";
}

function formatBps(value: bigint): string {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const ms = toTimestampMs(value);
    if (ms == null) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = value ?? null;
    }
  }

  return best;
}

function scaleTrendPoint(value: bigint | null, decimals: number): number | null {
  if (value == null) return null;
  const scaled = Number(value) / 10 ** decimals;
  return Number.isFinite(scaled) ? scaled : null;
}

function toRunReceiptStatus(status: string, receiptStatus: string, topupStatus: string | null | undefined): string {
  if (receiptStatus === "offchain") {
    if (typeof topupStatus === "string" && topupStatus.trim().length > 0) return topupStatus;
    if (status === "error") return "error";
    if (status === "skipped") return "skipped";
    return "success";
  }
  if (receiptStatus === "unknown") return "unverified";
  if (receiptStatus === "reverted") return "reverted";
  if (status === "error") return "error";
  return "success";
}

function fundingSourceLabel(source: string | null): string {
  if (source === "escrow-fallback") return "escrow (fallback)";
  return source === "conway-credits" ? "conway-credits" : "escrow";
}

function formatTopupActivitySummary(run: RecentRunItem, usdcDecimals: number): string {
  const details: string[] = [];
  if (run.topupAmountUsdc != null) details.push(fmt(run.topupAmountUsdc, usdcDecimals, "USDC"));
  if (run.topupStatus) details.push(`status ${run.topupStatus}`);
  if (run.fundingSource) details.push(`source ${run.fundingSource}`);
  if (run.fallbackWarning) details.push(run.fallbackWarning);
  if (run.summary.trim()) details.push(run.summary);
  return details.length > 0 ? details.join(" • ") : "Credit top-up event";
}

export default async function HomePage() {
  const [state, runs] = await Promise.all([queryDashboardState(), queryRecentRuns()]);
  const nowMs = Date.now();

  const runwayDays = state.liveRunwayDaysWad == null ? "--" : (Number(state.liveRunwayDaysWad) / 1e18).toFixed(2);
  const isConwayCredits = state.fundingSource === "conway-credits";
  const activeFundingSource = fundingSourceLabel(state.fundingSource);
  const sourceBalanceLabel = isConwayCredits ? "Conway Credits Balance" : "Escrow Balance";
  const sourceBalanceUsdc = isConwayCredits ? (state.creditBalanceUsdc ?? state.escrowBalanceUsdc) : state.escrowBalanceUsdc;
  const latestTopupTimestamp = runs.runs.find((run) => run.decision === "topup-credits")?.timestamp ?? null;

  const smartAccountLabel = state.champion.basenames.smartAccount?.basename ?? fmtShortHash(state.smartAccountAddress);
  const escrowLabel = state.champion.basenames.escrow?.basename ?? fmtShortHash(state.escrowAddress);
  const championSubmitter = state.champion.currentChampion?.submitterAddress ?? null;
  const championSubmitterLabel =
    state.champion.basenames.currentChampionSubmitter?.basename ??
    (championSubmitter ? fmtShortHash(championSubmitter) : null);

  const activityRows: ActivityTimelineRow[] = [
    ...state.recentUserOps.map((op) => ({
      timestamp: op.timestamp,
      source: "UserOp",
      action: op.action,
      status: op.success ? "success" : "reverted",
      userOpHash: op.userOpHash,
      txHash: op.txHash,
      txHref: `${state.explorerTxUrl}${op.txHash}`,
      summary: op.summary
    })),
    ...state.escrowPayments.map((payment) => ({
      timestamp: payment.timestamp,
      source: "Escrow",
      action: "pay-escrow",
      status: "settled",
      txHash: payment.txHash,
      txHref: `${state.explorerTxUrl}${payment.txHash}`,
      summary: `${fmt(payment.amount, state.usdcDecimals, "USDC")} to ${fmtShortHash(payment.recipient)}`
    })),
    ...runs.runs.map((run) => ({
      timestamp: run.timestamp,
      source: run.decision === "topup-credits" ? "Top-up" : "Run Receipt",
      action: run.decision,
      status: toRunReceiptStatus(run.status, run.receiptStatus, run.topupStatus),
      userOpHash: run.userOpHash,
      txHash: run.txHash,
      txHref: run.txHash ? `${state.explorerTxUrl}${run.txHash}` : null,
      summary: run.decision === "topup-credits" ? formatTopupActivitySummary(run, state.usdcDecimals) : run.summary
    }))
  ].sort((a, b) => {
    const aMs = toTimestampMs(a.timestamp) ?? 0;
    const bMs = toTimestampMs(b.timestamp) ?? 0;
    return bMs - aMs;
  });

  const terminalDecision = runs.runs[0]?.decision ?? "none";
  const terminalStatus = state.lastRunStatus ?? "unknown";
  const terminalErrorCount = runs.runs.filter((run) => run.status === "error").length;
  const terminalNetLabel = state.netCarryEstimateUsd == null ? "--" : fmt(state.netCarryEstimateUsd, 8, "USD");
  const terminalRunwayLabel = runwayDays === "--" ? "--" : `${runwayDays}d`;

  const latestExecutionTimestamp = activityRows[0]?.timestamp ?? state.freshness.latestRun;
  const lineageTimestamp = maxTimestamp(state.champion.lineage.flatMap((entry) => [entry.createdAt, entry.evaluatedAt]));
  const governanceTimestamp = state.freshness.champion ?? lineageTimestamp;

  const healthFactorTrend = state.trends.healthFactor.map((point) => ({
    timestamp: point.timestamp,
    value: scaleTrendPoint(point.value, 18)
  }));
  const netCarryTrend = state.trends.netCarryUsd.map((point) => ({
    timestamp: point.timestamp,
    value: scaleTrendPoint(point.value, 8)
  }));
  const runwayTrend = state.trends.runwayDays.map((point) => ({
    timestamp: point.timestamp,
    value: scaleTrendPoint(point.value, 18)
  }));

  const renderStalenessChip = (label: string, timestamp: string | null | undefined) => {
    const tsMs = toTimestampMs(timestamp);
    const freshness = freshnessTone(tsMs, nowMs);
    return (
      <span className={`staleness-chip ${freshnessClass(freshness)}`} title={formatTimestamp(timestamp)}>
        {label} {formatAge(tsMs, nowMs)}
      </span>
    );
  };

  return (
    <main className="dashboard-shell">
      <section className="hero">
        <div>
          <p className="hero-kicker">Operator Console</p>
          <h1>Self-Sustaining Onchain Agent on Base</h1>
          <p className="hero-subtitle">ERC-4337 smart account, offchain policy engine, onchain settlement only.</p>
        </div>

        <div className="badges">
          <span className="badge">chainId {state.chainId}</span>
          <span className="badge">autopilot phase {state.autopilot.phase ?? "--"}</span>
          <span className="badge">autopilot stage {state.autopilot.stage ?? "--"}</span>
          <span className="badge">champion gate {state.champion.gateStatus}</span>
          <span className="badge">champion id {state.champion.currentChampionId ?? "--"}</span>
        </div>

        <div className="identity-row" aria-label="Address and identity details">
          <div className="identity-item">
            <span className="identity-label">Smart Account</span>
            <CopyableText fullValue={state.smartAccountAddress} shortLabel={smartAccountLabel} />
          </div>
          <div className="identity-item">
            <span className="identity-label">Escrow</span>
            <CopyableText fullValue={state.escrowAddress} shortLabel={escrowLabel} />
          </div>
          <div className="identity-item">
            <span className="identity-label">EntryPoint</span>
            <CopyableText fullValue={state.entryPointAddress} shortLabel={fmtShortHash(state.entryPointAddress)} />
          </div>
          <div className="identity-item">
            <span className="identity-label">Champion Submitter</span>
            {championSubmitter && championSubmitterLabel ? (
              <CopyableText fullValue={championSubmitter} shortLabel={championSubmitterLabel} />
            ) : (
              <span className="identity-fallback">--</span>
            )}
          </div>
        </div>

        <div className="staleness-row">
          {renderStalenessChip("snapshot", state.freshness.dashboard)}
          {renderStalenessChip("autopilot", state.freshness.autopilot)}
          {renderStalenessChip("execution", latestExecutionTimestamp)}
          {renderStalenessChip("governance", governanceTimestamp)}
        </div>
      </section>

      <TerminalConsoleLive
        initial={{
          decision: terminalDecision,
          status: terminalStatus,
          reason: state.lastRunReason ?? null,
          riskNote: state.riskNote,
          runwayUrgency: state.liveRunwayUrgency,
          collateralLabel: fmt(state.position.totalCollateralBase, 8, "USD"),
          debtLabel: fmt(state.position.totalDebtBase, 8, "USD"),
          netLabel: terminalNetLabel,
          runwayLabel: terminalRunwayLabel,
          healthFactorLabel: fmtHf(state.position.healthFactor),
          totalRuns: runs.runs.length,
          errorRuns: terminalErrorCount,
          latestTimestamp: state.freshness.latestRun
        }}
      />

      <section className="status-strip" aria-label="Critical status strip">
        <article className={`status-badge ${toneClass(healthFactorTone(state.position.healthFactor))}`}>
          <span className="status-label">Health Factor</span>
          <strong className="status-value">{fmtHf(state.position.healthFactor)}</strong>
          <span className="status-sub">{healthFactorLabel(state.position.healthFactor)}</span>
          <span className="status-meta">{formatAge(toTimestampMs(state.freshness.dashboard), nowMs)}</span>
        </article>

        <article className={`status-badge ${toneClass(runwayTone(state.liveRunwayUrgency))}`}>
          <span className="status-label">Runway Urgency</span>
          <strong className="status-value">{state.liveRunwayUrgency ?? "--"}</strong>
          <span className="status-sub">{runwayDays === "--" ? "--" : `${runwayDays} days`}</span>
          <span className="status-meta">{formatAge(toTimestampMs(state.freshness.latestRun), nowMs)}</span>
        </article>

        <article className={`status-badge ${toneClass(state.autopilot.emergencyStop ? "err" : "ok")}`}>
          <span className="status-label">Emergency Stop</span>
          <strong className="status-value">{state.autopilot.emergencyStop ? "on" : "off"}</strong>
          <span className="status-sub">autopilot control</span>
          <span className="status-meta">{formatAge(toTimestampMs(state.freshness.autopilot), nowMs)}</span>
        </article>

        <article className={`status-badge ${toneClass(lastRunTone(state.lastRunStatus))}`}>
          <span className="status-label">Last Run Status</span>
          <strong className="status-value">{state.lastRunStatus ?? "No runs yet"}</strong>
          <span className="status-sub">{state.lastRunReason ?? "No reason"}</span>
          <span className="status-meta">{formatAge(toTimestampMs(state.freshness.latestRun), nowMs)}</span>
        </article>

        <article className={`status-badge ${toneClass(boolTone(state.autopilot.lastPolicyGateOk))}`}>
          <span className="status-label">Policy Gate</span>
          <strong className="status-value">{boolLabel(state.autopilot.lastPolicyGateOk)}</strong>
          <span className="status-sub">{state.autopilot.lastProposalId ?? "no proposal"}</span>
          <span className="status-meta">{formatAge(toTimestampMs(state.freshness.autopilot), nowMs)}</span>
        </article>

        <article className={`status-badge ${toneClass(boolTone(state.autopilot.lastVerificationOk))}`}>
          <span className="status-label">Verification</span>
          <strong className="status-value">{boolLabel(state.autopilot.lastVerificationOk)}</strong>
          <span className="status-sub">{boolLabel(state.autopilot.lastReplayOk, "replay ok", "replay fail")}</span>
          <span className="status-meta">{formatAge(toTimestampMs(state.freshness.autopilot), nowMs)}</span>
        </article>
      </section>

      <section className="section" id="risk">
        <div className="section-head">
          <h2>Risk</h2>
          <div className="staleness-row">
            {renderStalenessChip("risk snapshot", state.freshness.dashboard)}
            {renderStalenessChip("last run", state.freshness.latestRun)}
          </div>
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span className="label">Collateral (USD base 1e8)</span>
            <span className="value">{fmt(state.position.totalCollateralBase, 8, "USD")}</span>
          </article>
          <article className="metric-card">
            <span className="label">Debt (USD base 1e8)</span>
            <span className="value">{fmt(state.position.totalDebtBase, 8, "USD")}</span>
          </article>
          <article className="metric-card">
            <span className="label">Available Borrows (USD base 1e8)</span>
            <span className="value">{fmt(state.position.availableBorrowsBase, 8, "USD")}</span>
          </article>
          <article className={`metric-card ${toneClass(healthFactorTone(state.position.healthFactor))}`}>
            <span className="label">Health Factor</span>
            <span className="value">{fmtHf(state.position.healthFactor)}</span>
            <span className="meta">{healthFactorLabel(state.position.healthFactor)}</span>
          </article>
          <article className="metric-card">
            <span className="label">Liquidation Threshold</span>
            <span className="value">{formatBps(state.position.currentLiquidationThresholdBps)}</span>
          </article>
          <article className="metric-card">
            <span className="label">Loan-to-Value</span>
            <span className="value">{formatBps(state.position.ltvBps)}</span>
          </article>
          <article className="metric-card">
            <span className="label">Net Carry Estimate</span>
            <span className="value">{state.netCarryEstimateUsd == null ? "--" : fmt(state.netCarryEstimateUsd, 8, "USD")}</span>
          </article>
          <article className="metric-card">
            <span className="label">Borrow APR (ray)</span>
            <span className="value">{fmtPercentWad((state.rates.wethVariableBorrowRateRay * 10n ** 18n) / 10n ** 27n)}</span>
          </article>
          <article className="metric-card">
            <span className="label">wstETH stEthPerToken</span>
            <span className="value">{fmt(state.rates.wstEthPerToken, 18)}</span>
          </article>
          <article className="metric-card">
            <span className="label">WETH Price</span>
            <span className="value">{fmt(state.prices.wethUsd, 8, "USD")}</span>
          </article>
          <article className="metric-card">
            <span className="label">wstETH Price</span>
            <span className="value">{fmt(state.prices.wstEthUsd, 8, "USD")}</span>
          </article>
          <article className="metric-card">
            <span className="label">USDC Oracle Price</span>
            <span className="value">{fmt(state.prices.usdcUsd, 8, "USD")}</span>
          </article>
          <article className="metric-card span-2 trend-card">
            <span className="label">Health Factor Trend</span>
            <Sparkline points={healthFactorTrend} width={220} height={60} />
            <span className="meta">Latest {healthFactorTrend.length} runs</span>
          </article>
          <article className="metric-card span-2">
            <span className="label">Risk Engine Note</span>
            <span className="value">{state.riskNote ?? "risk engine unavailable"}</span>
          </article>
        </div>
      </section>

      <section className="section" id="runway">
        <div className="section-head">
          <h2>Runway</h2>
          <div className="staleness-row">
            {renderStalenessChip("runway snapshot", state.freshness.dashboard)}
            {renderStalenessChip(
              isConwayCredits ? "latest topup" : "latest payment",
              isConwayCredits ? latestTopupTimestamp : state.escrowPayments[0]?.timestamp ?? null
            )}
          </div>
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span className="label">Funding Source</span>
            <span className="value">{activeFundingSource}</span>
          </article>
          <article className="metric-card">
            <span className="label">Runway</span>
            <span className="value">{runwayDays === "--" ? "--" : `${runwayDays} days`}</span>
          </article>
          <article className={`metric-card ${toneClass(runwayTone(state.liveRunwayUrgency))}`}>
            <span className="label">Compute Urgency</span>
            <span className="value">{state.liveRunwayUrgency ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Per-Tick Cost</span>
            <span className="value">{state.perTickCostUsdc == null ? "--" : fmt(state.perTickCostUsdc, state.usdcDecimals, "USDC")}</span>
          </article>
          <article className="metric-card">
            <span className="label">{sourceBalanceLabel}</span>
            <span className="value">{fmt(sourceBalanceUsdc, state.usdcDecimals, "USDC")}</span>
          </article>
          <article className="metric-card">
            <span className="label">Escrow Paid (total)</span>
            <span className="value">{fmt(state.totalEscrowPaidUsdc, state.usdcDecimals, "USDC")}</span>
          </article>
          <article className="metric-card">
            <span className="label">Gas Paid in USDC (total)</span>
            <span className="value">{state.totalGasPaymentUsdc > 0n ? fmt(state.totalGasPaymentUsdc, state.usdcDecimals, "USDC") : "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Last Gas Payment</span>
            <span className="value">{state.latestGasPaymentUsdc != null ? fmt(state.latestGasPaymentUsdc, state.usdcDecimals, "USDC") : "ETH"}</span>
          </article>
          <article className="metric-card">
            <span className="label">USDC Balance</span>
            <span className="value">{fmt(state.balances.usdc, state.usdcDecimals, "USDC")}</span>
          </article>
          <article className="metric-card">
            <span className="label">WETH Balance</span>
            <span className="value">{fmt(state.balances.weth, 18, "WETH")}</span>
          </article>
          <article className="metric-card">
            <span className="label">wstETH Balance</span>
            <span className="value">{fmt(state.balances.wstEth, 18, "wstETH")}</span>
          </article>
          <article className="metric-card">
            <span className="label">ETH Balance</span>
            <span className="value">{fmt(state.balances.eth, 18, "ETH")}</span>
          </article>
          <article className="metric-card trend-card span-2">
            <span className="label">Runway Trend (days)</span>
            <Sparkline points={runwayTrend} width={220} height={60} />
            <span className="meta">Latest {runwayTrend.length} runs</span>
          </article>
          <article className="metric-card trend-card span-2">
            <span className="label">Net Carry Trend (USD)</span>
            <Sparkline points={netCarryTrend} width={220} height={60} />
            <span className="meta">Latest {netCarryTrend.length} runs</span>
          </article>
        </div>
      </section>

      <section className="section" id="execution">
        <div className="section-head">
          <h2>Execution</h2>
          <div className="staleness-row">
            {renderStalenessChip("execution feed", latestExecutionTimestamp)}
            {renderStalenessChip("latest run", state.freshness.latestRun)}
          </div>
        </div>

        <div className="metric-grid">
          <article className={`metric-card ${toneClass(lastRunTone(state.lastRunStatus))}`}>
            <span className="label">Last Run Status</span>
            <span className="value">{state.lastRunStatus ?? "No runs yet"}</span>
          </article>
          <article className="metric-card span-2">
            <span className="label">Last Run Reason</span>
            <span className="value">{state.lastRunReason ?? "No runs yet"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Funding Source</span>
            <span className="value">{activeFundingSource}</span>
          </article>
          <article className={`metric-card ${toneClass(topupTone(state.topupStatus))}`}>
            <span className="label">Top-up Status</span>
            <span className="value">{state.topupStatus ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Top-up Amount</span>
            <span className="value">{state.topupAmountUsdc == null ? "--" : fmt(state.topupAmountUsdc, state.usdcDecimals, "USDC")}</span>
          </article>
          <article className={`metric-card ${toneClass(state.fallbackWarning ? "warn" : "neutral")}`}>
            <span className="label">Fallback Warning</span>
            <span className="value">{state.fallbackWarning ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Autopilot Stage</span>
            <span className="value">{state.autopilot.stage ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Autopilot Phase</span>
            <span className="value">{state.autopilot.phase ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Last Deployment Action</span>
            <span className="value">{state.autopilot.lastDeploymentAction ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Autopilot Last Proposal</span>
            <span className="value">{state.autopilot.lastProposalId ?? "none"}</span>
          </article>
          <article className={`metric-card ${toneClass(boolTone(state.autopilot.lastPolicyGateOk))}`}>
            <span className="label">Policy Gate</span>
            <span className="value">{boolLabel(state.autopilot.lastPolicyGateOk)}</span>
          </article>
          <article className={`metric-card ${toneClass(boolTone(state.autopilot.lastVerificationOk))}`}>
            <span className="label">Verification</span>
            <span className="value">{boolLabel(state.autopilot.lastVerificationOk)}</span>
          </article>
          <article className={`metric-card ${toneClass(boolTone(state.autopilot.lastReplayOk))}`}>
            <span className="label">Replay Check</span>
            <span className="value">{boolLabel(state.autopilot.lastReplayOk)}</span>
          </article>
          <article className={`metric-card ${toneClass(state.autopilot.emergencyStop ? "err" : "ok")}`}>
            <span className="label">Emergency Stop</span>
            <span className="value">{state.autopilot.emergencyStop ? "on" : "off"}</span>
          </article>
          <article className={`metric-card ${toneClass(state.autopilot.requireHumanApproval ? "warn" : "ok")}`}>
            <span className="label">Require Human Approval</span>
            <span className="value">{state.autopilot.requireHumanApproval ? "yes" : "no"}</span>
          </article>
          <article className={`metric-card ${toneClass(state.autopilot.requiresTimelock ? "warn" : "ok")}`}>
            <span className="label">Requires Timelock</span>
            <span className="value">{state.autopilot.requiresTimelock ? "yes" : "no"}</span>
          </article>
          <article className="metric-card">
            <span className="label">UserOps (20 max)</span>
            <span className="value">{state.recentUserOps.length}</span>
          </article>
          <article className="metric-card">
            <span className="label">Escrow Payments (50 max)</span>
            <span className="value">{state.escrowPayments.length}</span>
          </article>
          <article className="metric-card">
            <span className="label">Run Receipts + Topups</span>
            <span className="value">{runs.runs.length}</span>
          </article>
        </div>

        <div className="subsection">
          <h3>Unified Activity Timeline</h3>
          <p className="subtle">Merged UserOps, escrow payments, run receipts, and credit topup events with in-place filters.</p>

          {activityRows.length === 0 ? (
            <p className="empty">No activity yet</p>
          ) : (
            <ActivityTimeline rows={activityRows} />
          )}

          {runs.hasRuns && runs.runs.length === 0 ? (
            <p className="empty">Runs exist but no verified onchain receipts or topup events yet</p>
          ) : null}
        </div>
      </section>

      <section className="section" id="governance">
        <div className="section-head">
          <h2>Governance</h2>
          <div className="staleness-row">
            {renderStalenessChip("autopilot state", state.freshness.autopilot)}
            {renderStalenessChip("lineage", governanceTimestamp)}
          </div>
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span className="label">Champion Current ID</span>
            <span className="value">{state.champion.currentChampionId ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Champion Gate Status</span>
            <span className="value">{state.champion.gateStatus}</span>
          </article>
          <article className="metric-card">
            <span className="label">Registry</span>
            <span className="value">{state.champion.registryAddress ? fmtShortHash(state.champion.registryAddress) : "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Artifact Digest</span>
            <span className="value">{state.champion.artifactDigest ? fmtShortHash(state.champion.artifactDigest) : "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Provenance Digest</span>
            <span className="value">{state.champion.provenanceDigest ? fmtShortHash(state.champion.provenanceDigest) : "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Agent Commit</span>
            <span className="value">{state.provenance?.commitSha ? state.provenance.commitSha.slice(0, 12) : "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Agent Version</span>
            <span className="value">{state.provenance?.agentVersion ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Autopilot Version</span>
            <span className="value">{state.provenance?.autopilotVersion ?? "--"}</span>
          </article>
          <article className="metric-card">
            <span className="label">Policy Version</span>
            <span className="value">{state.provenance?.policyVersion ?? "--"}</span>
          </article>
          <article className="metric-card span-2">
            <span className="label">Model ID</span>
            <span className="value">{state.provenance?.modelId ?? "--"}</span>
          </article>
        </div>

        <div className="subsection">
          <h3>Provenance and Trust</h3>
          <div className="identity-row">
            <div className="identity-item">
              <span className="identity-label">Commit</span>
              {state.provenance?.commitSha ? (
                <CopyableText fullValue={state.provenance.commitSha} shortLabel={state.provenance.commitSha.slice(0, 12)} />
              ) : (
                <span className="identity-fallback">--</span>
              )}
            </div>
            <div className="identity-item">
              <span className="identity-label">Policy Gate</span>
              <span className={`status-pill ${toneClass(boolTone(state.autopilot.lastPolicyGateOk))}`}>
                {boolLabel(state.autopilot.lastPolicyGateOk)}
              </span>
            </div>
            <div className="identity-item">
              <span className="identity-label">Verification</span>
              <span className={`status-pill ${toneClass(boolTone(state.autopilot.lastVerificationOk))}`}>
                {boolLabel(state.autopilot.lastVerificationOk)}
              </span>
            </div>
            <div className="identity-item">
              <span className="identity-label">Replay</span>
              <span className={`status-pill ${toneClass(boolTone(state.autopilot.lastReplayOk))}`}>
                {boolLabel(state.autopilot.lastReplayOk)}
              </span>
            </div>
          </div>
        </div>

        <div className="subsection">
          <h3>Champion Snapshot</h3>
          <div className="list">
            <div className="list-item">
              <strong>Registry</strong>:{" "}
              {state.champion.registryAddress ? (
                <CopyableText
                  fullValue={state.champion.registryAddress}
                  shortLabel={fmtShortHash(state.champion.registryAddress)}
                />
              ) : (
                "--"
              )}
            </div>
            <div className="list-item">
              <strong>Current Champion</strong>: {state.champion.currentChampionId ?? "--"}
            </div>
            <div className="list-item">
              <strong>Gate Status</strong>: {state.champion.gateStatus}
            </div>
            <div className="list-item">
              <strong>Current Submitter</strong>:{" "}
              {championSubmitter ? (
                <CopyableText fullValue={championSubmitter} shortLabel={championSubmitterLabel ?? fmtShortHash(championSubmitter)} />
              ) : (
                "--"
              )}
            </div>
            <div className="list-item">
              <strong>Artifact Hash</strong>:{" "}
              {state.champion.artifactDigest ? (
                <CopyableText fullValue={state.champion.artifactDigest} shortLabel={fmtShortHash(state.champion.artifactDigest)} />
              ) : (
                "--"
              )}
            </div>
            <div className="list-item">
              <strong>Provenance Hash</strong>:{" "}
              {state.champion.provenanceDigest ? (
                <CopyableText fullValue={state.champion.provenanceDigest} shortLabel={fmtShortHash(state.champion.provenanceDigest)} />
              ) : (
                "--"
              )}
            </div>
          </div>
        </div>

        <div className="subsection">
          <h3>Autopilot Trust Model</h3>
          {state.autopilot.trustModel.length === 0 ? (
            <p className="empty">No trust model policy loaded</p>
          ) : (
            <ul className="list">
              {state.autopilot.trustModel.map((line) => (
                <li className="list-item" key={line}>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="subsection">
          <h3>Champion Lineage</h3>
          {state.champion.lineage.length === 0 ? (
            <p className="empty">No champion lineage entries yet</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Champion ID</th>
                    <th>Parent</th>
                    <th>Gate</th>
                    <th>Candidate Hash</th>
                    <th>Provenance Hash</th>
                    <th>Submitter</th>
                    <th>Proposal</th>
                    <th>Promoted</th>
                  </tr>
                </thead>
                <tbody>
                  {state.champion.lineage
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <tr key={`${entry.candidateId}-${entry.createdAt ?? "na"}`}>
                        <td>{entry.createdAt ? formatTimestamp(entry.createdAt) : "--"}</td>
                        <td>{entry.championId ?? "--"}</td>
                        <td>{entry.parentChampionId ?? "--"}</td>
                        <td>{entry.gateStatus}</td>
                        <td>
                          <CopyableText fullValue={entry.candidateHash} shortLabel={fmtShortHash(entry.candidateHash)} />
                        </td>
                        <td>
                          <CopyableText fullValue={entry.provenanceHash} shortLabel={fmtShortHash(entry.provenanceHash)} />
                        </td>
                        <td>
                          {entry.submitterAddress ? (
                            <CopyableText fullValue={entry.submitterAddress} shortLabel={fmtShortHash(entry.submitterAddress)} />
                          ) : (
                            "--"
                          )}
                        </td>
                        <td>{entry.proposalId ?? "--"}</td>
                        <td>{entry.promoted ? "yes" : "no"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
