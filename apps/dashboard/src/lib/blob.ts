import { put, head } from "@vercel/blob";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type TelemetryStorageMode = "auto" | "blob" | "filesystem" | "edge-cache";

type BlobAccessMode = "public" | "private";

const TELEMETRY_FALLBACK_ROOT = join(tmpdir(), "ssa-telemetry");
const TELEMETRY_CACHE_PATH = "/api/telemetry-cache";
let loggedFallbackWarning = false;

function storageMode(): TelemetryStorageMode {
  const raw = process.env.TELEMETRY_STORAGE_MODE?.trim().toLowerCase();
  if (raw === "blob" || raw === "filesystem" || raw === "edge-cache") return raw;
  return "auto";
}

function fallbackMode(): Exclude<TelemetryStorageMode, "blob" | "auto"> {
  const mode = storageMode();
  if (mode === "filesystem" || mode === "edge-cache") return mode;
  return process.env.VERCEL ? "edge-cache" : "filesystem";
}

function configuredAccessMode(): BlobAccessMode {
  const raw = process.env.BLOB_ACCESS_MODE?.trim().toLowerCase();
  return raw === "private" ? "private" : "public";
}

function isAccessModeMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    message.includes("Cannot use public access on a private store") ||
    message.includes("Cannot use private access on a public store") ||
    message.includes('access must be "public"')
  );
}

async function putWithFallbackAccess(key: string, content: string): Promise<void> {
  const preferred = configuredAccessMode();
  const order: BlobAccessMode[] = preferred === "private" ? ["private", "public"] : ["public", "private"];
  let lastError: unknown = null;

  for (const access of order) {
    try {
      await put(key, content, {
        access,
        addRandomSuffix: false,
        allowOverwrite: true
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isAccessModeMismatch(error)) {
        throw error;
      }
    }
  }

  if (lastError) throw lastError;
}

function fallbackPath(key: string): string {
  return join(TELEMETRY_FALLBACK_ROOT, key);
}

async function readFilesystemFallbackText(key: string): Promise<string | null> {
  try {
    return await readFile(fallbackPath(key), "utf8");
  } catch {
    return null;
  }
}

async function writeFilesystemFallbackText(key: string, content: string): Promise<void> {
  const path = fallbackPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function logFallbackOnce(
  action: "read" | "write",
  key: string,
  target: "edge-config" | "edge-cache" | "filesystem",
  error: unknown
): void {
  if (loggedFallbackWarning) return;
  loggedFallbackWarning = true;
  const message = error instanceof Error ? error.message : String(error);
  const destination =
    target === "edge-config" ? "edge-config fallback" : target === "edge-cache" ? "edge cache fallback" : "/tmp fallback";
  console.warn(`[telemetry] blob ${action} failed for ${key}; using ${destination} (${message.slice(0, 180)})`);
}

type EdgeConfigSettings = {
  id: string;
  token: string;
};

function edgeConfigSettings(): EdgeConfigSettings | null {
  const id = process.env.TELEMETRY_EDGE_CONFIG_ID?.trim();
  const token = process.env.TELEMETRY_VERCEL_API_TOKEN?.trim();
  if (!id || !token) return null;
  return { id, token };
}

function edgeConfigItemKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function readEdgeConfigText(key: string): Promise<string | null> {
  const settings = edgeConfigSettings();
  if (!settings) return null;
  const itemKey = edgeConfigItemKey(key);

  const response = await fetch(`https://api.vercel.com/v1/edge-config/${settings.id}/item/${encodeURIComponent(itemKey)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${settings.token}`,
      "cache-control": "no-store"
    },
    cache: "no-store"
  });

  if (response.status === 404) return null;
  if (!response.ok) return null;

  const payload = (await response.json()) as { value?: unknown };
  return typeof payload.value === "string" ? payload.value : null;
}

async function writeEdgeConfigText(key: string, content: string): Promise<boolean> {
  const settings = edgeConfigSettings();
  if (!settings) return false;
  const itemKey = edgeConfigItemKey(key);

  const response = await fetch(`https://api.vercel.com/v1/edge-config/${settings.id}/items`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${settings.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      items: [
        {
          operation: "upsert",
          key: itemKey,
          value: content
        }
      ]
    }),
    cache: "no-store"
  });

  return response.ok;
}

async function appendEdgeConfigLine(key: string, line: string, maxLines: number): Promise<boolean> {
  const settings = edgeConfigSettings();
  if (!settings) return false;

  const existing = await readEdgeConfigText(key);
  const lines = existing ? existing.split("\n").filter(Boolean) : [];
  lines.push(line);
  const trimmed = lines.slice(-maxLines).join("\n") + "\n";
  return writeEdgeConfigText(key, trimmed);
}

function telemetryCacheBaseUrl(): string | null {
  const explicit = process.env.TELEMETRY_CACHE_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  return null;
}

function telemetryCacheHeaders(): HeadersInit | null {
  const secret = process.env.INGEST_SECRET?.trim();
  if (!secret) return null;
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${secret}`
  };
}

function telemetryCacheUrl(key: string): string | null {
  const base = telemetryCacheBaseUrl();
  if (!base) return null;
  return `${base}${TELEMETRY_CACHE_PATH}?key=${encodeURIComponent(key)}`;
}

async function readEdgeCacheText(key: string): Promise<string | null> {
  const url = telemetryCacheUrl(key);
  const headers = telemetryCacheHeaders();
  if (!url || !headers) return null;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      ...headers,
      "cache-control": "no-store"
    },
    cache: "no-store"
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as { content?: unknown };
  return typeof payload.content === "string" ? payload.content : null;
}

async function writeEdgeCacheText(key: string, content: string): Promise<boolean> {
  const url = telemetryCacheUrl(key);
  const headers = telemetryCacheHeaders();
  if (!url || !headers) return false;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ op: "write", key, content }),
    cache: "no-store"
  });

  return response.ok;
}

async function appendEdgeCacheLine(key: string, line: string, maxLines: number): Promise<boolean> {
  const url = telemetryCacheUrl(key);
  const headers = telemetryCacheHeaders();
  if (!url || !headers) return false;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ op: "append", key, line, maxLines }),
    cache: "no-store"
  });

  return response.ok;
}

async function readPreferredFallbackText(key: string): Promise<string | null> {
  const edgeConfig = await readEdgeConfigText(key);
  if (edgeConfig !== null) return edgeConfig;

  if (fallbackMode() === "edge-cache") {
    const cached = await readEdgeCacheText(key);
    if (cached !== null) return cached;
  }
  return readFilesystemFallbackText(key);
}

async function writePreferredFallbackText(key: string, content: string): Promise<void> {
  if (await writeEdgeConfigText(key, content)) return;
  if (fallbackMode() === "edge-cache" && (await writeEdgeCacheText(key, content))) return;
  await writeFilesystemFallbackText(key, content);
}

async function appendPreferredFallbackLine(key: string, line: string, maxLines: number): Promise<boolean> {
  if (await appendEdgeConfigLine(key, line, maxLines)) return true;
  if (fallbackMode() === "edge-cache") {
    return appendEdgeCacheLine(key, line, maxLines);
  }
  return false;
}

function blobAuthHeaders(): HeadersInit | undefined {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.BLOB_READ_TOKEN?.trim();
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}

/**
 * Write text content to a Vercel Blob key, overwriting any existing content.
 */
export async function writeBlobText(key: string, content: string): Promise<void> {
  if (storageMode() === "filesystem") {
    await writeFilesystemFallbackText(key, content);
    return;
  }

  if (storageMode() === "edge-cache") {
    await writePreferredFallbackText(key, content);
    return;
  }

  try {
    await putWithFallbackAccess(key, content);
  } catch (error) {
    logFallbackOnce("write", key, edgeConfigSettings() ? "edge-config" : fallbackMode(), error);
    await writePreferredFallbackText(key, content);
  }
}

/**
 * Read text content from a Vercel Blob key.
 * Returns null if the blob does not exist.
 */
export async function readBlobText(key: string): Promise<string | null> {
  const fallback = await readPreferredFallbackText(key);
  if (storageMode() === "filesystem") return fallback;
  if (storageMode() === "edge-cache") return fallback;

  try {
    const info = await head(key);
    const readUrl = info.downloadUrl ?? info.url;
    let response = await fetch(readUrl);
    if (!response.ok) {
      const headers = blobAuthHeaders();
      if (headers) {
        response = await fetch(readUrl, { headers });
      }
    }
    if (!response.ok) {
      if (fallback !== null) return fallback;
      return null;
    }
    return await response.text();
  } catch (error) {
    if (fallback !== null) {
      logFallbackOnce("read", key, edgeConfigSettings() ? "edge-config" : fallbackMode(), error);
      return fallback;
    }
    return null;
  }
}

/**
 * Append a line to a newline-delimited blob, trimming to maxLines.
 * Creates the blob if it doesn't exist.
 */
export async function appendBlobLine(key: string, line: string, maxLines = 500): Promise<void> {
  if (storageMode() === "edge-cache") {
    const appended = await appendPreferredFallbackLine(key, line, maxLines);
    if (appended) return;
  }

  const existing = await readBlobText(key);
  const lines = existing
    ? existing.split("\n").filter(Boolean)
    : [];

  lines.push(line);

  const trimmed = lines.slice(-maxLines);
  await writeBlobText(key, trimmed.join("\n") + "\n");
}
