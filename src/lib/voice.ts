/**
 * Voice output with barge-in support.
 *
 * Realism comes from three things:
 *  1. A real neural female voice (Gemini TTS) instead of the robotic default.
 *  2. Speaking sentence by sentence with small natural gaps, longer after
 *     sentence-ending punctuation — people don't deliver a paragraph in one breath.
 *  3. Starting playback of sentence 1 while sentence 2 is still being generated,
 *     so the reply begins almost immediately.
 *
 * Everything is cancellable: `stop()` kills in-flight audio, queued sentences,
 * and pending fetches, which is what makes interrupting Jarvis feel instant.
 */

export type SpeakHandle = { stop: () => void; done: Promise<void> };

function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // merge very short fragments into the previous sentence ("Sure." + "Done.")
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && (p.length < 15 || out[out.length - 1].length < 15)) {
      out[out.length - 1] += " " + p;
    } else {
      out.push(p);
    }
  }
  return out.length ? out : [text];
}

/** Pause after a sentence, scaled by its ending — commas breathe, periods land. */
function gapAfter(sentence: string): number {
  if (/[?!]$/.test(sentence)) return 260;
  if (/\.$/.test(sentence)) return 220;
  return 120;
}

/** Urdu/Arabic script detection — decides which voice and locale to speak with. */
export function isUrdu(text: string): boolean {
  return /[؀-ۿݐ-ݿ]/.test(text);
}

function pickVoice(urdu: boolean): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (!voices.length) return null;

  if (urdu) {
    // Urdu voices are rare; Hindi is the closest widely-installed fallback and
    // is intelligible for Urdu text, so try ur → hi → anything.
    const ur = voices.find((v) => /^ur(-|_|$)/i.test(v.lang));
    if (ur) return ur;
    const hi = voices.find((v) => /^hi(-|_|$)/i.test(v.lang));
    if (hi) return hi;
  }

  const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const named = (re: RegExp) => en.find((v) => re.test(v.name));
  return (
    named(/Google US English/i) || // female by default, most natural on Chrome
    named(/Zira|Aria|Jenny|Michelle|Samantha|Sonia|Libby|Natasha/i) ||
    named(/female/i) ||
    en[0] ||
    voices[0] ||
    null
  );
}

function speakBrowser(sentence: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const urdu = isUrdu(sentence);
    const u = new SpeechSynthesisUtterance(sentence);
    const v = pickVoice(urdu);
    if (v) u.voice = v;
    u.lang = urdu ? (v?.lang ?? "ur-PK") : "en-US";
    u.rate = urdu ? 0.98 : 1.08;
    u.pitch = 1.05;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    signal.addEventListener("abort", () => {
      window.speechSynthesis.cancel();
      resolve();
    });
    window.speechSynthesis.speak(u);
  });
}

/**
 * Neural TTS is a network hop. If it's unavailable (quota gone, terms not
 * accepted) we must NOT pay that hop per sentence and then fall back — that
 * delay is exactly what made Jarvis start speaking late. One failure disables
 * it for the session and we go straight to the instant browser voice.
 */
let neuralDead = false;

export function neuralAvailable(): boolean {
  return !neuralDead;
}

async function fetchTts(sentence: string, signal: AbortSignal): Promise<Blob | null> {
  if (neuralDead) return null;
  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sentence }),
      signal,
    });
    if (r.status === 422) {
      neuralDead = true; // don't try again this session
      return null;
    }
    if (!r.ok) return null;
    return await r.blob();
  } catch {
    return null;
  }
}

function playBlob(blob: Blob, signal: AbortSignal, onAudio: (a: HTMLAudioElement) => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    onAudio(audio);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    signal.addEventListener("abort", () => {
      audio.pause();
      audio.src = "";
      cleanup();
    });
    audio.play().catch(cleanup);
  });
}

/**
 * Speak `text`. Returns immediately with a handle — `done` resolves when the
 * whole reply has been spoken, `stop()` cuts it off mid-word (barge-in).
 */
export function speak(text: string, useNeural: boolean): SpeakHandle {
  const controller = new AbortController();
  const { signal } = controller;
  let current: HTMLAudioElement | null = null;

  const done = (async () => {
    const sentences = splitSentences(text);
    if (!useNeural || neuralDead) {
      for (const s of sentences) {
        if (signal.aborted) return;
        await speakBrowser(s, signal);
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, gapAfter(s)));
      }
      return;
    }

    // Pipeline: fetch sentence N+1 while sentence N plays
    let pending: Promise<Blob | null> | null = fetchTts(sentences[0], signal);
    for (let i = 0; i < sentences.length; i++) {
      if (signal.aborted) return;
      const blob = await pending;
      pending = i + 1 < sentences.length ? fetchTts(sentences[i + 1], signal) : null;
      if (signal.aborted) return;

      if (blob) {
        await playBlob(blob, signal, (a) => (current = a));
      } else {
        await speakBrowser(sentences[i], signal); // neural failed for this chunk
      }
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, gapAfter(sentences[i])));
    }
  })();

  return {
    stop: () => {
      controller.abort();
      current?.pause();
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* not supported */
      }
    },
    done,
  };
}

/** Warm up the browser voice list (Chrome loads it lazily). */
/**
 * Chrome's FIRST utterance is always laggy — the engine boots on demand. Firing
 * a silent one on the user's first gesture (the orb click) pays that cost up
 * front, so the first real reply speaks immediately instead of hanging.
 */
export function warmUpSpeech() {
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    const v = pickVoice(false);
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  } catch {
    /* unsupported */
  }
}

export function primeVoices() {
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => pickVoice(false);
  } catch {
    /* unsupported */
  }
  // Ask up front whether neural TTS actually works, so the very first reply
  // doesn't waste a round trip discovering that it doesn't.
  fetch("/api/tts")
    .then((r) => r.json())
    .then((j) => {
      if (j && j.neural === false) neuralDead = true;
    })
    .catch(() => {});
}
