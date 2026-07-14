import { probeStatus } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    return Response.json(await probeStatus());
  } catch (e) {
    return Response.json({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
