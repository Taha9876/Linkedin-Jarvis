import { cancelRun } from "@/lib/cancel";

export const runtime = "nodejs";

/**
 * Stop whatever the browser is doing right now. The client hits this the moment
 * the user says "stop" or barges in with a new command, so a slow scroll (or any
 * multi-step action) halts mid-flight instead of running to completion.
 */
export async function POST() {
  cancelRun();
  return Response.json({ ok: true });
}
