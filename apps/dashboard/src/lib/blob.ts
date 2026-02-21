import { put, head } from "@vercel/blob";

type BlobAccessMode = "public" | "private";

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

function blobAuthHeaders(): HeadersInit | undefined {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.BLOB_READ_TOKEN?.trim();
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}

/**
 * Write text content to a Vercel Blob key, overwriting any existing content.
 */
export async function writeBlobText(key: string, content: string): Promise<void> {
  await putWithFallbackAccess(key, content);
}

/**
 * Read text content from a Vercel Blob key.
 * Returns null if the blob does not exist.
 */
export async function readBlobText(key: string): Promise<string | null> {
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
    if (!response.ok) return null;
    return await response.text();
  } catch {
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
