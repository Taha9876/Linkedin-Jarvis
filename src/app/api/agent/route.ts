import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent";
import { finishRequest, isServerless } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby caps at 60s

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages required" }), { status: 400 });
  }

  const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

  // Serverless: the LinkedIn session lives in cookies, and cookies CANNOT be set
  // once a streamed response has begun — the headers are already gone. So we
  // buffer the whole turn, tear the browser down (which writes the cookies), and
  // send it in one shot. The client parses it identically; it just can't show
  // tool progress live in this mode.
  if (isServerless()) {
    let body = "";
    try {
      for await (const event of runAgent(messages)) body += line(event);
    } catch (e) {
      body += line({ type: "error", content: e instanceof Error ? e.message : String(e) });
    } finally {
      await finishRequest(); // persists auth + scroll position, closes Chromium
    }
    body += line({ type: "done" });
    return new Response(body, { headers: SSE_HEADERS });
  }

  // Local / remote-browser: stream events as they happen.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(line(obj)));
      try {
        for await (const event of runAgent(messages)) send(event);
      } catch (e) {
        send({ type: "error", content: e instanceof Error ? e.message : String(e) });
      }
      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
