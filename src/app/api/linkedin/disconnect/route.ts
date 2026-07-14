import { disconnect, getStatus } from "@/lib/session";

export const runtime = "nodejs";

export async function POST() {
  await disconnect();
  return Response.json(getStatus());
}
