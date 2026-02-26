import { put, head } from "@vercel/blob";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type TelemetryStorageMode = "auto" | "blob" | "filesystem";

type BlobAccessMode = "public" | "private";

const TELEMETRY_FALLBACK_ROOT = join(tmpdir(), "ssa-telemetry");
let loggedFallbackWarning = false;

function storageMode(): TelemetryStorageMode {
  const raw = process.env.TELEMETRY_STORAGE_MODE?.trim().toLowerCase();
  if (raw === "blob" || raw === "filesystem") return raw;
  return "auto";
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

async function readFallbackText(key: string): Promise<string | null> {
  try {
    return await readFile(fallbackPath(key), "utf8");
  } catch {
    return null;
  }
}

async function writeFallbackText(key: string, content: string): Promise<void> {
  const path = fallbackPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function logFallbackOnce(action: "read" | "write", key: string, error: unknown): void {
  if (loggedFallbackWarning) return;
  loggedFallbackWarning = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[telemetry] blob ${action} failed for ${key}; using /tmp fallback (${message.slice(0, 180)})`);
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
    await writeFallbackText(key, content);
    return;
  }

  try {
    await putWithFallbackAccess(key, content);
  } catch (error) {
    logFallbackOnce("write", key, error);
    await writeFallbackText(key, content);
  }
}

/**
 * Read text content from a Vercel Blob key.
 * Returns null if the blob does not exist.
 */
export async function readBlobText(key: string): Promise<string | null> {
  const fallback = await readFallbackText(key);
  if (storageMode() === "filesystem") return fallback;

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
      logFallbackOnce("read", key, error);
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
  const existing = await readBlobText(key);
  const lines = existing
    ? existing.split("\n").filter(Boolean)
    : [];

  lines.push(line);

  const trimmed = lines.slice(-maxLines);
  await writeBlobText(key, trimmed.join("\n") + "\n");
}
