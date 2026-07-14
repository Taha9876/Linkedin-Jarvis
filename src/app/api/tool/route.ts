import { NextRequest } from "next/server";
import { executeTool } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Direct tool execution — used for debugging actions without the LLM. */
export async function POST(req: NextRequest) {
  const { name, args } = await req.json().catch(() => ({}));
  if (!name) return Response.json({ error: "name required" }, { status: 400 });
  try {
    const result = await executeTool(name, args ?? {});
    return Response.json({ ok: true, result });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 200 }
    );
  }
}
