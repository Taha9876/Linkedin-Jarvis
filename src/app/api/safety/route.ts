import { usage } from "@/lib/safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(usage());
}
