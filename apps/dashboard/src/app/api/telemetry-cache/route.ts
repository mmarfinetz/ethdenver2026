export const runtime = "edge";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store"
};

const CACHE_BODY_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "public, max-age=31536000, s-maxage=31536000, immutable"
};

type WritePayload = {
  op: "write";
  key: string;
  content: string;
};

type AppendPayload = {
  op: "append";
  key: string;
  line: string;
  maxLines?: number;
};

type CachePayload = WritePayload | AppendPayload;

function authorized(request: Request): boolean {
  const secret = process.env.INGEST_SECRET?.trim();
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function isSafeKey(key: string): boolean {
  return key.startsWith("telemetry/") && !key.includes("..") && key.length <= 180;
}

function cacheKeyRequest(key: string): Request {
  return new Request(`https://ssa-telemetry-cache.local/${encodeURIComponent(key)}`, { method: "GET" });
}

async function telemetryCache(): Promise<Cache> {
  return caches.open("ssa-telemetry-v1");
}

async function readCachedText(key: string): Promise<string | null> {
  const cache = await telemetryCache();
  const match = await cache.match(cacheKeyRequest(key));
  if (!match) return null;
  return await match.text();
}

async function writeCachedText(key: string, content: string): Promise<void> {
  const cache = await telemetryCache();
  await cache.put(cacheKeyRequest(key), new Response(content, { headers: CACHE_BODY_HEADERS }));
}

function parsePayload(value: unknown): CachePayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (payload.op === "write" && typeof payload.key === "string" && typeof payload.content === "string") {
    return {
      op: "write",
      key: payload.key,
      content: payload.content
    };
  }
  if (payload.op === "append" && typeof payload.key === "string" && typeof payload.line === "string") {
    return {
      op: "append",
      key: payload.key,
      line: payload.line,
      maxLines: typeof payload.maxLines === "number" ? payload.maxLines : undefined
    };
  }
  return null;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key")?.trim() ?? "";
  if (!key || !isSafeKey(key)) {
    return new Response(JSON.stringify({ error: "Invalid key" }), { status: 400, headers: JSON_HEADERS });
  }

  const content = await readCachedText(key);
  return new Response(JSON.stringify({ content }), { status: 200, headers: JSON_HEADERS });
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: JSON_HEADERS });
  }

  const payload = parsePayload(raw);
  if (!payload) {
    return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400, headers: JSON_HEADERS });
  }

  if (!isSafeKey(payload.key)) {
    return new Response(JSON.stringify({ error: "Invalid key" }), { status: 400, headers: JSON_HEADERS });
  }

  if (payload.op === "write") {
    await writeCachedText(payload.key, payload.content);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
  }

  const maxLines = Number.isFinite(payload.maxLines) ? Math.max(1, Math.min(1000, payload.maxLines ?? 500)) : 500;
  const existing = await readCachedText(payload.key);
  const lines = existing ? existing.split("\n").filter(Boolean) : [];
  lines.push(payload.line);
  const next = lines.slice(-maxLines).join("\n") + "\n";
  await writeCachedText(payload.key, next);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
}
