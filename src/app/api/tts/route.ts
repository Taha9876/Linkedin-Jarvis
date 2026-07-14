import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Text-to-speech: Gemini TTS first (free tier), then Groq PlayAI, and if
 * neither works we return 422 so the client falls back to browser speech.
 */
/**
 * Once a neural provider fails (quota exhausted, terms not accepted), it will
 * keep failing. Remember that and answer 422 instantly instead of burning a
 * 1-2s round trip per sentence — that latency was the whole reason speech
 * started late. Re-probe occasionally in case quota resets.
 */
const g = globalThis as unknown as { __ttsDeadUntil?: number };
const DEAD_FOR_MS = 10 * 60 * 1000;

function neuralDead(): boolean {
  return !!g.__ttsDeadUntil && Date.now() < g.__ttsDeadUntil;
}
function markNeuralDead() {
  g.__ttsDeadUntil = Date.now() + DEAD_FOR_MS;
}

export async function POST(req: NextRequest) {
  const { text } = await req.json().catch(() => ({}));
  if (!text || typeof text !== "string") {
    return new Response("text required", { status: 400 });
  }
  if (neuralDead()) return new Response("tts unavailable", { status: 422 });

  const input = text.slice(0, 900);

  const gemini = await geminiTts(input);
  if (gemini) return wavResponse(gemini);

  const groq = await groqTts(input);
  if (groq) return groq;

  markNeuralDead();
  return new Response("tts unavailable", { status: 422 });
}

/** Cheap check the client makes once on load to pick its voice path. */
export async function GET() {
  return Response.json({ neural: !neuralDead() });
}

/** Gemini TTS is multilingual — nudge the delivery when the text is Urdu. */
function styleFor(text: string): string {
  const urdu = /[؀-ۿݐ-ݿ]/.test(text);
  return urdu
    ? `اردو میں گرم جوشی اور فطری انداز میں کہیں، جیسے ایک مددگار دوست بات کر رہا ہو: ${text}`
    : `Say this warmly and naturally, like a sharp, friendly assistant talking to a colleague — relaxed pace, light intonation, not announcer-like: ${text}`;
}

async function geminiTts(text: string): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          // The style prompt shapes delivery — this is what stops it sounding
          // like a text-to-speech robot reading a label.
          contents: [{ parts: [{ text: styleFor(text) }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              // Aoede: warm, natural female voice
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
            },
          },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) return null;
    // Gemini returns raw 16-bit PCM at 24 kHz — wrap it in a WAV header
    return pcmToWav(Buffer.from(b64, "base64"), 24000);
  } catch {
    return null;
  }
}

async function groqTts(text: string): Promise<Response | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "playai-tts",
      voice: "Fritz-PlayAI",
      input: text,
      response_format: "wav",
    }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return new Response(res.body, {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
  });
}

function wavResponse(buf: Buffer): Response {
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
  });
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // mono, 16-bit
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
