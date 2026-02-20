import { fmt, fmtHf, fmtPercentWad, fmtShortHash } from "../lib/format";
import { queryDashboardState, queryRecentRuns } from "../lib/queries";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [state, runs] = await Promise.all([queryDashboardState(), queryRecentRuns()]);

  const lastRunClass = state.lastRunStatus === "ok" ? "ok" : state.lastRunStatus === "error" ? "err" : "warn";
  const runwayDays = state.liveRunwayDaysWad == null ? "--" : (Number(state.liveRunwayDaysWad) / 1e18).toFixed(2);
  const smartAccountLabel = state.champion.basenames.smartAccount?.basename ?? fmtShortHash(state.smartAccountAddress);
  const escrowLabel = state.champion.basenames.escrow?.basename ?? fmtShortHash(state.escrowAddress);
  const championSubmitterLabel =
    state.champion.basenames.currentChampionSubmitter?.basename ??
    (state.champion.currentChampion?.submitterAddress
      ? fmtShortHash(state.champion.currentChampion.submitterAddress)
      : "--");

  return (
    <main>
      <section className="hero">
        <h1>Self-Sustaining Onchain Agent on Base</h1>
        <p>ERC-4337 smart account, offchain policy engine, onchain settlement only.</p>
        <div className="badges">
          <span className="badge">chainId {state.chainId}</span>
          <span className="badge">smart account {smartAccountLabel}</span>
          <span className="badge">escrow {escrowLabel}</span>
          <span className={`badge ${lastRunClass}`}>last run {state.lastRunStatus ?? "No runs yet"}</span>
          <span className="badge">autopilot phase {state.autopilot.phase ?? "--"}</span>
          <span className="badge">champion gate {state.champion.gateStatus}</span>
          <span className={`badge ${state.autopilot.emergencyStop ? "err" : "ok"}`}>
            emergency stop {state.autopilot.emergencyStop ? "on" : "off"}
          </span>
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <span className="label">Collateral (USD base 1e8)</span>
          <span className="value">{fmt(state.position.totalCollateralBase, 8, "USD")}</span>
        </article>
        <article className="card">
          <span className="label">Debt (USD base 1e8)</span>
          <span className="value">{fmt(state.position.totalDebtBase, 8, "USD")}</span>
        </article>
        <article className="card">
          <span className="label">Health Factor</span>
          <span className="value">{fmtHf(state.position.healthFactor)}</span>
        </article>
        <article className="card">
          <span className="label">Net Carry Estimate</span>
          <span className="value">{state.netCarryEstimateUsd == null ? "--" : fmt(state.netCarryEstimateUsd, 8, "USD")}</span>
        </article>
        <article className="card">
          <span className="label">wstETH Balance</span>
          <span className="value">{fmt(state.balances.wstEth, 18, "wstETH")}</span>
        </article>
        <article className="card">
          <span className="label">WETH Balance</span>
          <span className="value">{fmt(state.balances.weth, 18, "WETH")}</span>
        </article>
        <article className="card">
          <span className="label">USDC Balance</span>
          <span className="value">{fmt(state.balances.usdc, state.usdcDecimals, "USDC")}</span>
        </article>
        <article className="card">
          <span className="label">Escrow Balance</span>
          <span className="value">{fmt(state.escrowBalanceUsdc, state.usdcDecimals, "USDC")}</span>
        </article>
        <article className="card">
          <span className="label">Runway</span>
          <span className="value">{runwayDays === "--" ? "--" : `${runwayDays} days`}</span>
        </article>
        <article className="card">
          <span className="label">Compute Urgency</span>
          <span className="value">{state.liveRunwayUrgency ?? "--"}</span>
        </article>
        <article className="card">
          <span className="label">Per-Tick Cost</span>
          <span className="value">{state.perTickCostUsdc == null ? "--" : fmt(state.perTickCostUsdc, state.usdcDecimals, "USDC")}</span>
        </article>
        <article className="card">
          <span className="label">Escrow Paid (total)</span>
          <span className="value">{fmt(state.totalEscrowPaidUsdc, state.usdcDecimals, "USDC")}</span>
        </article>
        <article className="card">
          <span className="label">Borrow APR (ray)</span>
          <span className="value">{fmtPercentWad((state.rates.wethVariableBorrowRateRay * 10n ** 18n) / 10n ** 27n)}</span>
        </article>
        <article className="card">
          <span className="label">wstETH stEthPerToken</span>
          <span className="value">{fmt(state.rates.wstEthPerToken, 18)}</span>
        </article>
        <article className="card">
          <span className="label">Last Run Reason</span>
          <span className="value">{state.lastRunReason ?? "No runs yet"}</span>
        </article>
        <article className="card">
          <span className="label">Risk Engine</span>
          <span className="value">{state.riskNote ?? "risk engine unavailable"}</span>
        </article>
        <article className="card">
          <span className="label">Autopilot Stage</span>
          <span className="value">{state.autopilot.stage ?? "--"}</span>
        </article>
        <article className="card">
          <span className="label">Autopilot Last Proposal</span>
          <span className="value">{state.autopilot.lastProposalId ?? "none"}</span>
        </article>
        <article className="card">
          <span className="label">Policy Gate</span>
          <span className="value">
            {state.autopilot.lastPolicyGateOk == null ? "--" : state.autopilot.lastPolicyGateOk ? "pass" : "fail"}
          </span>
        </article>
        <article className="card">
          <span className="label">Verification</span>
          <span className="value">
            {state.autopilot.lastVerificationOk == null
              ? "--"
              : state.autopilot.lastVerificationOk
                ? "pass"
                : "fail"}
          </span>
        </article>
        <article className="card">
          <span className="label">Agent Provenance</span>
          <span className="value">{state.provenance ? state.provenance.commitSha.slice(0, 12) : "--"}</span>
        </article>
        <article className="card">
          <span className="label">Champion Current ID</span>
          <span className="value">{state.champion.currentChampionId ?? "--"}</span>
        </article>
        <article className="card">
          <span className="label">Champion Gate Status</span>
          <span className="value">{state.champion.gateStatus}</span>
        </article>
        <article className="card">
          <span className="label">Champion Artifact Hash</span>
          <span className="value">{state.champion.artifactDigest ? fmtShortHash(state.champion.artifactDigest) : "--"}</span>
        </article>
        <article className="card">
          <span className="label">Champion Provenance Hash</span>
          <span className="value">{state.champion.provenanceDigest ? fmtShortHash(state.champion.provenanceDigest) : "--"}</span>
        </article>
      </section>

      <section className="section">
        <h2>Champion Snapshot</h2>
        <div className="list">
          <div className="list-item">
            <strong>Registry</strong>: {state.champion.registryAddress ? fmtShortHash(state.champion.registryAddress) : "--"}
          </div>
          <div className="list-item">
            <strong>Current Champion</strong>: {state.champion.currentChampionId ?? "--"}
          </div>
          <div className="list-item">
            <strong>Gate Status</strong>: {state.champion.gateStatus}
          </div>
          <div className="list-item">
            <strong>Current Submitter</strong>: {championSubmitterLabel}
          </div>
          <div className="list-item">
            <strong>Artifact Hash</strong>: {state.champion.artifactDigest ?? "--"}
          </div>
          <div className="list-item">
            <strong>Provenance Hash</strong>: {state.champion.provenanceDigest ?? "--"}
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Champion Lineage</h2>
        {state.champion.lineage.length === 0 ? (
          <p className="empty">No champion lineage entries yet</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Champion ID</th>
                <th>Parent</th>
                <th>Gate</th>
                <th>Candidate Hash</th>
                <th>Provenance Hash</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {state.champion.lineage
                .slice()
                .reverse()
                .map((entry) => (
                  <tr key={`${entry.candidateId}-${entry.createdAt ?? "na"}`}>
                    <td>{entry.championId ?? "--"}</td>
                    <td>{entry.parentChampionId ?? "--"}</td>
                    <td>{entry.gateStatus}</td>
                    <td>{fmtShortHash(entry.candidateHash)}</td>
                    <td>{fmtShortHash(entry.provenanceHash)}</td>
                    <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "--"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Autopilot Trust Model</h2>
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
      </section>

      <section className="section">
        <h2>Recent UserOperations / Transactions</h2>
        {state.recentUserOps.length === 0 ? (
          <p className="empty">No runs yet</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>UserOp</th>
                <th>Tx</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {state.recentUserOps.map((op) => (
                <tr key={`${op.userOpHash}-${op.txHash}`}>
                  <td>{new Date(op.timestamp).toLocaleString()}</td>
                  <td>{op.action}</td>
                  <td>{fmtShortHash(op.userOpHash)}</td>
                  <td>
                    <a href={`${state.explorerTxUrl}${op.txHash}`} target="_blank" rel="noreferrer">
                      {fmtShortHash(op.txHash)}
                    </a>
                  </td>
                  <td>{op.success ? "success" : "reverted"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Escrow Payments</h2>
        {state.escrowPayments.length === 0 ? (
          <p className="empty">No escrow payments yet</p>
        ) : (
          <div className="list">
            {state.escrowPayments.map((payment) => (
              <div className="list-item" key={`${payment.txHash}-${payment.blockNumber.toString()}`}>
                <div>
                  <strong>{fmt(payment.amount, state.usdcDecimals, "USDC")}</strong> to {fmtShortHash(payment.recipient)}
                </div>
                <div className="meta">
                  <a href={`${state.explorerTxUrl}${payment.txHash}`} target="_blank" rel="noreferrer">
                    {fmtShortHash(payment.txHash)}
                  </a>{" "}
                  at {new Date(payment.timestamp).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Verified Run Log Receipts</h2>
        {!runs.hasRuns ? (
          <p className="empty">No runs yet</p>
        ) : runs.runs.length === 0 ? (
          <p className="empty">Runs exist but no verified onchain receipts yet</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Decision</th>
                <th>Status</th>
                <th>UserOp</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {runs.runs.map((run) => (
                <tr key={`${run.userOpHash}-${run.txHash}`}>
                  <td>{new Date(run.timestamp).toLocaleString()}</td>
                  <td>{run.decision}</td>
                  <td>{run.receiptStatus}</td>
                  <td>{fmtShortHash(run.userOpHash)}</td>
                  <td>
                    <a href={`${state.explorerTxUrl}${run.txHash}`} target="_blank" rel="noreferrer">
                      {fmtShortHash(run.txHash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
