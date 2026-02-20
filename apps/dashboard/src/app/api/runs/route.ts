import { queryRecentRuns } from "../../../lib/queries";

export const dynamic = "force-dynamic";

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

export async function GET() {
  try {
    const runs = await queryRecentRuns();
    return new Response(JSON.stringify(runs, jsonReplacer), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }
}
