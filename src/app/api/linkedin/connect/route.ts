import { NextRequest } from "next/server";
import { connect, probeStatus, isRemote, isServerless, finishRequest } from "@/lib/session";

export const runtime = "nodejs";
// Vercel Hobby caps functions at 60s. Remote connect is written to finish well
// inside one invocation: it navigates and fills the form, then the client polls
// /status while the user finishes any 2FA or CAPTCHA in the live view.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { email, password, liAt } = await req.json().catch(() => ({}));

  if (isServerless()) {
    try {
      await connect(email, password, liAt);
      // finishRequest writes the LinkedIn auth cookie — MUST happen before we
      // build the response, or the login is lost the moment Chromium closes.
      await finishRequest();
      return Response.json(await probeStatus());
    } catch (e) {
      await finishRequest();
      return Response.json({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (isRemote()) {
    try {
      await connect(email, password);
      return Response.json(await probeStatus());
    } catch (e) {
      return Response.json({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        remote: true,
      });
    }
  }

  // Local: fire and forget — login can take minutes if LinkedIn asks for a code
  // in the visible window, and the dev server process lives on between requests.
  connect(email, password);
  await new Promise((r) => setTimeout(r, 1500));
  return Response.json(await probeStatus());
}
