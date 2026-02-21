import { put, list, head } from "@vercel/blob";

/**
 * Write text content to a Vercel Blob key, overwriting any existing content.
 */
export async function writeBlobText(key: string, content: string): Promise<void> {
  await put(key, content, { access: "public", addRandomSuffix: false });
}

/**
 * Read text content from a Vercel Blob key.
 * Returns null if the blob does not exist.
 */
export async function readBlobText(key: string): Promise<string | null> {
  try {
    const info = await head(key);
    const response = await fetch(info.url);
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
