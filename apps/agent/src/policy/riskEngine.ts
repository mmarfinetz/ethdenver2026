import type { RiskOutput } from "@ssa/shared/types";
import { RAY, WAD } from "@ssa/shared/constants";

export type RiskSnapshot = {
  healthFactorWad: bigint;
  collateralBaseUsd: bigint;
  debtBaseUsd: bigint;
  borrowRateRay: bigint;
  wstEthAprWad: bigint | null;
};

export interface MonteCarloRiskEngine {
  computeRisk(snapshot: RiskSnapshot): Promise<RiskOutput>;
}

export type AaveWstEthRiskEngineOptions = {
  nSimulations: number;
  horizonDays: number;
  shortHorizonDays: number;
  seed?: number;
  baseBorrowRate: number;
  slope1: number;
  slope2: number;
  optimalUtilization: number;
  utilizationMeanReversion: number;
  utilizationVol: number;
  utilizationMin: number;
  utilizationMax: number;
  governanceShockProbAnnual: number;
  governanceBorrowSpread: number;
  governanceLtHaircut: number;
  slashingProbAnnual: number;
  slashingSeverity: number;
  capoMaxGrowthAnnual: number;
  defaultLiquidationThreshold: number;
};

const DAYS_PER_YEAR = 365;
const DEFAULT_OPTIONS: AaveWstEthRiskEngineOptions = {
  nSimulations: 10_000,
  horizonDays: 30,
  shortHorizonDays: 7,
  seed: undefined,
  baseBorrowRate: 0,
  slope1: 0.027,
  slope2: 0.8,
  optimalUtilization: 0.9,
  utilizationMeanReversion: 10,
  utilizationVol: 0.08,
  utilizationMin: 0.4,
  utilizationMax: 0.99,
  governanceShockProbAnnual: 0.2,
  governanceBorrowSpread: 0.04,
  governanceLtHaircut: 0.02,
  slashingProbAnnual: 0.02,
  slashingSeverity: 0.08,
  capoMaxGrowthAnnual: 0.0968,
  defaultLiquidationThreshold: 0.95
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function bigIntToNumber(value: bigint): number {
  const out = Number(value);
  return Number.isFinite(out) ? out : Number.POSITIVE_INFINITY;
}

function wadToDecimal(value: bigint): number {
  return Number(value) / Number(WAD);
}

function rayToDecimal(value: bigint): number {
  return Number(value) / Number(RAY);
}

function inferCurrentUtilization(
  borrowRate: number,
  options: Pick<AaveWstEthRiskEngineOptions, "baseBorrowRate" | "slope1" | "slope2" | "optimalUtilization" | "utilizationMin" | "utilizationMax">
): number {
  const { baseBorrowRate, slope1, slope2, optimalUtilization, utilizationMin, utilizationMax } = options;
  if (borrowRate <= baseBorrowRate || slope1 <= 0 || slope2 <= 0) return clamp(optimalUtilization, utilizationMin, utilizationMax);

  const kinkRate = baseBorrowRate + slope1;
  let utilization: number;
  if (borrowRate <= kinkRate) {
    utilization = ((borrowRate - baseBorrowRate) / slope1) * optimalUtilization;
  } else {
    utilization = optimalUtilization + ((borrowRate - baseBorrowRate - slope1) / slope2) * (1 - optimalUtilization);
  }
  return clamp(utilization, utilizationMin, utilizationMax);
}

function borrowRateFromUtilization(
  utilization: number,
  options: Pick<AaveWstEthRiskEngineOptions, "baseBorrowRate" | "slope1" | "slope2" | "optimalUtilization">
): number {
  const { baseBorrowRate, slope1, slope2, optimalUtilization } = options;
  if (utilization <= optimalUtilization) {
    return baseBorrowRate + slope1 * (utilization / optimalUtilization);
  }
  return baseBorrowRate + slope1 + slope2 * ((utilization - optimalUtilization) / (1 - optimalUtilization));
}

function inferLiquidationThreshold(snapshot: RiskSnapshot, collateralBaseUsd: number, debtBaseUsd: number, fallbackLt: number): number {
  const hf = wadToDecimal(snapshot.healthFactorWad);
  if (!Number.isFinite(hf) || hf <= 0 || collateralBaseUsd <= 0 || debtBaseUsd <= 0) return fallbackLt;

  const inferred = (hf * debtBaseUsd) / collateralBaseUsd;
  if (!Number.isFinite(inferred) || inferred <= 0) return fallbackLt;
  return clamp(inferred, 0.3, 0.99);
}

type RandomSource = {
  uniform: () => number;
  normal: () => number;
};

class XorShift32Random implements RandomSource {
  private state: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    // xorshift32 must not start from 0.
    this.state = seed === 0 ? 0x6d2b79f5 : seed >>> 0;
  }

  uniform(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 2 ** 32;
  }

  normal(): number {
    if (this.spareNormal != null) {
      const out = this.spareNormal;
      this.spareNormal = null;
      return out;
    }

    let u1 = this.uniform();
    let u2 = this.uniform();

    if (u1 <= 1e-12) u1 = 1e-12;
    if (u2 <= 1e-12) u2 = 1e-12;

    const radius = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;

    this.spareNormal = radius * Math.sin(theta);
    return radius * Math.cos(theta);
  }
}

export class AaveWstEthRiskEngine implements MonteCarloRiskEngine {
  private readonly options: AaveWstEthRiskEngineOptions;
  private readonly random: RandomSource;

  constructor(options?: Partial<AaveWstEthRiskEngineOptions>) {
    const definedOptions = Object.fromEntries(
      Object.entries(options ?? {}).filter(([, value]) => value !== undefined)
    ) as Partial<AaveWstEthRiskEngineOptions>;
    this.options = { ...DEFAULT_OPTIONS, ...definedOptions };
    const seed = this.options.seed ?? (Date.now() >>> 0);
    this.random = new XorShift32Random(seed);
  }

  async computeRisk(snapshot: RiskSnapshot): Promise<RiskOutput> {
    const debtBaseUsd = bigIntToNumber(snapshot.debtBaseUsd);
    const collateralBaseUsd = bigIntToNumber(snapshot.collateralBaseUsd);

    if (!Number.isFinite(debtBaseUsd) || !Number.isFinite(collateralBaseUsd)) {
      return {
        status: "unavailable",
        notes: "risk engine unavailable: position snapshot overflow"
      };
    }

    if (debtBaseUsd <= 0) {
      return {
        status: "available",
        pLiq7d: 0,
        pLiq30d: 0,
        notes: "aave-wsteth-risk: no debt exposure"
      };
    }

    if (collateralBaseUsd <= 0) {
      return {
        status: "available",
        pLiq7d: 1,
        pLiq30d: 1,
        notes: "aave-wsteth-risk: debt with zero collateral"
      };
    }

    if (snapshot.wstEthAprWad == null) {
      return {
        status: "unavailable",
        notes: "risk engine unavailable: wstETH APR sample history insufficient"
      };
    }

    const currentHf = wadToDecimal(snapshot.healthFactorWad);
    if (Number.isFinite(currentHf) && currentHf < 1) {
      return {
        status: "available",
        pLiq7d: 1,
        pLiq30d: 1,
        notes: "aave-wsteth-risk: current health factor below liquidation threshold"
      };
    }

    const annualBorrowRate = Math.max(rayToDecimal(snapshot.borrowRateRay), 0);
    const annualWstEthApr = clamp(wadToDecimal(snapshot.wstEthAprWad), 0, 1);
    if (!Number.isFinite(annualBorrowRate) || !Number.isFinite(annualWstEthApr)) {
      return {
        status: "unavailable",
        notes: "risk engine unavailable: invalid borrow/APR input"
      };
    }

    const opts = this.options;
    const nSimulations = Math.max(1, Math.floor(opts.nSimulations));
    const horizonDays = Math.max(1, Math.floor(opts.horizonDays));
    const shortHorizonDays = clamp(Math.floor(opts.shortHorizonDays), 1, horizonDays);
    const dt = 1 / DAYS_PER_YEAR;
    const sqrtDt = Math.sqrt(dt);

    const currentUtilization = inferCurrentUtilization(annualBorrowRate, opts);
    const inferredLt = inferLiquidationThreshold(snapshot, collateralBaseUsd, debtBaseUsd, opts.defaultLiquidationThreshold);

    const governanceShockProbStep = 1 - Math.exp(-Math.max(opts.governanceShockProbAnnual, 0) * dt);
    const slashingProbStep = 1 - Math.exp(-Math.max(opts.slashingProbAnnual, 0) * dt);
    const slashingMultiplier = 1 - clamp(opts.slashingSeverity, 0, 0.95);
    const exchangeRateGrowthPerStep = Math.exp(Math.min(annualWstEthApr, opts.capoMaxGrowthAnnual) * dt);

    let liquidation7dCount = 0;
    let liquidation30dCount = 0;

    for (let path = 0; path < nSimulations; path += 1) {
      let debt = debtBaseUsd;
      let collateralScale = 1;
      let liquidationThreshold = inferredLt;
      let utilization = currentUtilization;
      let governanceEventActive = false;

      for (let day = 1; day <= horizonDays; day += 1) {
        if (!governanceEventActive && this.random.uniform() < governanceShockProbStep) {
          governanceEventActive = true;
          liquidationThreshold *= 1 - clamp(opts.governanceLtHaircut, 0, 0.5);
        }

        collateralScale *= exchangeRateGrowthPerStep;
        if (slashingProbStep > 0 && this.random.uniform() < slashingProbStep) {
          collateralScale *= slashingMultiplier;
        }

        utilization =
          utilization +
          opts.utilizationMeanReversion * (currentUtilization - utilization) * dt +
          opts.utilizationVol * sqrtDt * this.random.normal();
        utilization = clamp(utilization, opts.utilizationMin, opts.utilizationMax);

        let borrowRate = borrowRateFromUtilization(utilization, opts);
        if (governanceEventActive) {
          borrowRate += Math.max(opts.governanceBorrowSpread, 0);
        }
        borrowRate = Math.max(borrowRate, 0);

        debt *= 1 + borrowRate * dt;
        const collateral = collateralBaseUsd * collateralScale;
        const hf = (collateral * liquidationThreshold) / debt;

        if (hf < 1) {
          liquidation30dCount += 1;
          if (day <= shortHorizonDays) liquidation7dCount += 1;
          break;
        }
      }
    }

    const pLiq7d = liquidation7dCount / nSimulations;
    const pLiq30d = liquidation30dCount / nSimulations;

    return {
      status: "available",
      pLiq7d,
      pLiq30d,
      notes: `aave-wsteth-risk Monte Carlo (${nSimulations} paths, horizon ${horizonDays}d)`
    };
  }
}

export class UnavailableRiskEngine implements MonteCarloRiskEngine {
  async computeRisk(_snapshot: RiskSnapshot): Promise<RiskOutput> {
    return {
      status: "unavailable",
      notes: "risk engine unavailable; policy fallback uses HF-only guardrails"
    };
  }
}

function parseOptionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set`);
  }
  return parsed;
}

function parseOptionalSeed(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer when set`);
  }
  return parsed >>> 0;
}

export function createRiskEngineFromEnv(): MonteCarloRiskEngine {
  const mode = process.env.RISK_ENGINE_MODE?.trim().toLowerCase() || "aave-wsteth";
  if (mode === "off" || mode === "disabled" || mode === "unavailable") {
    return new UnavailableRiskEngine();
  }

  const nSimulations = parseOptionalPositiveInteger("RISK_MONTE_CARLO_PATHS");
  const horizonDays = parseOptionalPositiveInteger("RISK_MONTE_CARLO_HORIZON_DAYS");
  const seed = parseOptionalSeed("RISK_MONTE_CARLO_SEED");

  return new AaveWstEthRiskEngine({
    nSimulations,
    horizonDays,
    seed
  });
}

export function isRiskAccepted(result: RiskOutput): boolean {
  if (result.status === "unavailable") return true;

  const p7 = result.pLiq7d ?? 1;
  const p30 = result.pLiq30d ?? 1;

  return p7 <= 0.02 && p30 <= 0.05;
}
