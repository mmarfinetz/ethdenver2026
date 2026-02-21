import { appendBlobLine, writeBlobText } from "../../../lib/blob";

export const dynamic = "force-dynamic";

const VALID_TYPES = ["run", "autopilot-state", "champion-state"] as const;
type IngestType = (typeof VALID_TYPES)[number];

function isValidType(value: unknown): value is IngestType {
  return typeof value === "string" && VALID_TYPES.includes(value as IngestType);
}

export async function POST(request: Request) {
  const secret = process.env.INGEST_SECRET?.trim();
  if (!secret) {
    return new Response(JSON.stringify({ error: "INGEST_SECRET not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }

  let body: { type?: unknown; data?: unknown };
  try {
    body = (await request.json()) as { type?: unknown; data?: unknown };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  if (!isValidType(body.type)) {
    return new Response(JSON.stringify({ error: `Invalid type. Expected one of: ${VALID_TYPES.join(", ")}` }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  if (body.data === undefined || body.data === null) {
    return new Response(JSON.stringify({ error: "Missing data field" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  try {
    const serialized = typeof body.data === "string" ? body.data : JSON.stringify(body.data);

    switch (body.type) {
      case "run":
        await appendBlobLine("telemetry/runs.ndjson", serialized);
        break;
      case "autopilot-state":
        await writeBlobText("telemetry/autopilot-state.json", serialized);
        break;
      case "champion-state":
        await writeBlobText("telemetry/champion-state.json", serialized);
        break;
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Internal error" }),
      {
        status: 500,
        headers: { "content-type": "application/json" }
      }
    );
  }
}
