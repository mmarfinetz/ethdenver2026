import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUTOPILOT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(AUTOPILOT_DIR, "../../../..");

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readText(path);
  return JSON.parse(raw) as T;
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureParent(path);
  await writeFile(
    path,
    `${JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested), 2)}\n`,
    "utf8"
  );
}

export function toShellTuple(command: string): [string, string[]] {
  if (process.platform === "win32") {
    return ["cmd.exe", ["/d", "/s", "/c", command]];
  }
  const shell = process.env.SHELL?.trim() || "sh";
  return [shell, ["-lc", command]];
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortRecursively(nested)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function formatPct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return (numerator / denominator) * 100;
}

export function repoPath(relativePath: string): string {
  return resolve(REPO_ROOT, relativePath);
}
