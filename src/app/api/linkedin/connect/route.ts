import { NextRequest } from "next/server";
import { connect, getStatus } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}));
  // Fire and forget — the client polls /api/linkedin/status. Login can take
  // minutes if LinkedIn asks for a verification code in the visible window.
  connect(email, password);
  await new Promise((r) => setTimeout(r, 1500));
  return Response.json(getStatus());
}
