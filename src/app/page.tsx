"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { speak, primeVoices, type SpeakHandle } from "@/lib/voice";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type ConnStatus = "disconnected" | "connecting" | "checkpoint" | "connected" | "error" | "unknown";
type AgentState = "idle" | "listening" | "thinking" | "speaking";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

interface FeedItem {
  id: number;
  kind: "tool_call" | "tool_result" | "tool_error" | "user" | "assistant" | "error" | "info";
  title: string;
  detail?: string;
  time: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } };
}

const TOOL_LABELS: Record<string, string> = {
  scroll: "Scrolling",
  read_visible_posts: "Reading posts",
  like_post: "Liking post",
  unlike_post: "Removing reaction",
  expand_post: "Expanding post",
  summarize_post: "Summarizing post",
  save_post: "Saving post",
  repost: "Reposting",
  open_my_recent_posts: "Opening your posts",
  delete_post: "Deleting post",
  delete_comment: "Deleting comment",
  follow_person: "Following",
  read_profile: "Reading profile",
  view_profile_photo: "Opening profile photo",
  comment_on_post: "Commenting",
  open_post_comments: "Opening comments",
  create_post: "Publishing post",
  search: "Searching",
  open_profile: "Opening profile",
  connect_with_person: "Sending connection request",
  open_notifications: "Checking notifications",
  read_messages: "Reading messages",
  send_message: "Sending message",
  go_home: "Going home",
  describe_screen: "Looking at the screen",
  click_element: "Clicking",
  go_back: "Going back",
  open_my_activity: "Opening your activity",
  open_saved_posts: "Opening saved posts",
  edit_message: "Editing message",
  delete_message: "Deleting message",
};

let feedId = 0;
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Filler words the mic picks up that shouldn't count as a real interruption. */
const NOISE = /^(uh|um|hmm+|ah|oh|mm+|yeah|ok|okay|yes|no|hm)?[.,!?\s]*$/i;

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [conn, setConn] = useState<ConnStatus>("unknown");
  const [connError, setConnError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [micOn, setMicOn] = useState(false);
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [textInput, setTextInput] = useState("");
  const [speechSupported, setSpeechSupported] = useState(true);
  const [neuralVoice, setNeuralVoice] = useState(true);
  // Web Speech recognition needs an explicit locale — it can't auto-detect.
  const [lang, setLang] = useState<"en-US" | "ur-PK">("en-US");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const micOnRef = useRef(false);
  const messagesRef = useRef<ChatMsg[]>([]);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const everConnectedRef = useRef(false);
  const neuralRef = useRef(true);
  const langRef = useRef<"en-US" | "ur-PK">("en-US");

  // Barge-in machinery: the live speech handle + the in-flight agent request,
  // both cancellable the instant the user starts a new command.
  const speakRef = useRef<SpeakHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const spokenTextRef = useRef(""); // what Jarvis is currently saying (echo filter)
  const runIdRef = useRef(0); // guards against a cancelled run updating state

  micOnRef.current = micOn;
  messagesRef.current = messages;
  neuralRef.current = neuralVoice;
  langRef.current = lang;

  const pushFeed = useCallback((item: Omit<FeedItem, "id" | "time">) => {
    setFeed((f) => [...f.slice(-80), { ...item, id: ++feedId, time: now() }]);
  }, []);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [feed]);

  useEffect(() => {
    primeVoices();
    // sync with whatever the pre-paint script in layout.tsx already applied
    const applied = document.documentElement.getAttribute("data-theme");
    if (applied === "light" || applied === "dark") setTheme(applied);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("jarvis-theme", next);
    } catch {
      /* storage blocked — theme just won't persist */
    }
  };

  /* ---------------- connection status ---------------- */

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/linkedin/status");
      const j = await r.json();
      if (j.status === "connected") everConnectedRef.current = true;
      setConn(j.status);
      setConnError(j.error ?? null);
    } catch {
      setConn("unknown");
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 3000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const handleConnect = async () => {
    setConn("connecting");
    setConnError(null);
    pushFeed({ kind: "info", title: "Opening LinkedIn in a Chrome window…" });
    await fetch("/api/linkedin/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    refreshStatus();
  };

  const handleDisconnect = async () => {
    await fetch("/api/linkedin/disconnect", { method: "POST" });
    refreshStatus();
  };

  /* ---------------- barge-in ---------------- */

  /** Cut off whatever Jarvis is doing right now: speech + in-flight request. */
  const interrupt = useCallback(() => {
    runIdRef.current++; // invalidate the running turn
    speakRef.current?.stop();
    speakRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    spokenTextRef.current = "";
    // also stop the BROWSER mid-action (e.g. a slow scroll in progress)
    fetch("/api/cancel", { method: "POST" }).catch(() => {});
  }, []);

  /* ---------------- agent turn ---------------- */

  const sendCommand = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      // A new command always wins over whatever is currently happening.
      interrupt();

      // "stop" must be instant — never make the user wait on a model round-trip.
      if (/^(stop|stop it|wait|hold on|cancel|ruko|rok do|bas|بس|رکو|روک دو)[.!]?$/i.test(text)) {
        pushFeed({ kind: "user", title: `“${text}”` });
        pushFeed({ kind: "info", title: "Stopped." });
        setAgentState(micOnRef.current ? "listening" : "idle");
        return;
      }
      const runId = runIdRef.current;
      const alive = () => runId === runIdRef.current;

      setInterim("");
      setAgentState("thinking");
      const history = [...messagesRef.current, { role: "user" as const, content: text }];
      setMessages(history);
      pushFeed({ kind: "user", title: `“${text}”` });

      const controller = new AbortController();
      abortRef.current = controller;

      let finalReply = "";
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Agent request failed (${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || !alive()) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            let ev;
            try {
              ev = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (ev.type === "tool_call") {
              pushFeed({
                kind: "tool_call",
                title: TOOL_LABELS[ev.name] ?? ev.name,
                detail: ev.args && Object.keys(ev.args).length ? JSON.stringify(ev.args) : undefined,
              });
            } else if (ev.type === "tool_result") {
              pushFeed({ kind: "tool_result", title: "Done", detail: String(ev.content).slice(0, 400) });
            } else if (ev.type === "tool_error") {
              pushFeed({ kind: "tool_error", title: "Action failed", detail: ev.content });
            } else if (ev.type === "assistant") {
              finalReply = ev.content || "";
            } else if (ev.type === "error") {
              pushFeed({ kind: "error", title: "Error", detail: ev.content });
              finalReply = finalReply || "Something went wrong on my side — check the activity panel.";
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // user barged in; a new turn owns the UI
        pushFeed({ kind: "error", title: "Request failed", detail: (e as Error).message });
        finalReply = "I couldn't reach my brain just then. Is the server still running?";
      }

      if (!alive()) return;
      abortRef.current = null;

      if (finalReply) {
        setMessages((m) => [...m, { role: "assistant", content: finalReply }]);
        pushFeed({ kind: "assistant", title: finalReply });
        setAgentState("speaking");
        spokenTextRef.current = finalReply.toLowerCase();
        const handle = speak(finalReply, neuralRef.current);
        speakRef.current = handle;
        await handle.done;
        if (!alive()) return;
        speakRef.current = null;
        spokenTextRef.current = "";
      }
      setAgentState(micOnRef.current ? "listening" : "idle");
    },
    [interrupt, pushFeed]
  );

  /* ---------------- speech recognition (always on while mic is on) ---------------- */

  const startRecognition = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setSpeechSupported(false);
      return;
    }
    recRef.current?.abort();

    const rec = new Ctor();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interimText = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (interimText) setInterim(interimText);
      const spoken = finalText.trim();
      if (!spoken || NOISE.test(spoken)) return;

      // Echo guard: while Jarvis is talking, the mic can hear her own voice.
      // Drop transcripts that are just a fragment of what she's saying.
      const echo = spokenTextRef.current;
      if (echo && spoken.length > 3) {
        const words = spoken.toLowerCase().split(/\s+/);
        const overlap = words.filter((w2) => w2.length > 3 && echo.includes(w2)).length;
        if (overlap >= Math.max(2, Math.ceil(words.length * 0.6))) return;
      }

      // Recognition keeps running — this IS the barge-in.
      sendCommand(spoken);
    };

    rec.onend = () => {
      // Chrome cuts recognition on silence; restart as long as the mic is on.
      if (micOnRef.current && recRef.current === rec) {
        try {
          rec.start();
        } catch {
          /* already running */
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") {
        setSpeechSupported(false);
        setMicOn(false);
        setAgentState("idle");
      }
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      /* ignore double-start */
    }
  }, [sendCommand]);

  const toggleMic = () => {
    if (micOn) {
      setMicOn(false);
      micOnRef.current = false;
      recRef.current?.abort();
      recRef.current = null;
      interrupt();
      setInterim("");
      setAgentState("idle");
    } else {
      setMicOn(true);
      micOnRef.current = true;
      setAgentState("listening");
      startRecognition();
    }
  };

  /* ---------------- render ---------------- */

  const stateLabel: Record<AgentState, string> = {
    idle: micOn ? "Paused" : "Tap the orb to talk",
    listening: "Listening…",
    thinking: "On it…",
    speaking: "Speaking — just talk to interrupt",
  };

  const connPill = {
    connected: { text: "LinkedIn connected", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    connecting: { text: "Connecting…", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
    checkpoint: { text: "Security check needed", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
    disconnected: { text: "Not connected", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
    error: { text: "Connection error", cls: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
    unknown: { text: "…", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  }[conn];

  const showDashboard = conn === "connected" || (conn === "checkpoint" && everConnectedRef.current);

  return (
    <main className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 pb-8">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[140px] light:bg-indigo-400/20" />
        <div className="absolute bottom-[-30%] right-[-10%] h-[500px] w-[600px] rounded-full bg-fuchsia-600/8 blur-[140px] light:bg-fuchsia-400/15" />
      </div>

      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-sm font-bold text-white shadow-lg shadow-indigo-500/25">
            J
          </div>
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-white light:text-zinc-900">Jarvis for LinkedIn</h1>
            <p className="text-[11px] text-zinc-500 light:text-zinc-500">voice-controlled assistant</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 light:border-zinc-300 light:text-zinc-600 light:hover:border-zinc-400 light:hover:text-zinc-900"
            title="Switch theme"
          >
            {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
          </button>
          {showDashboard && (
            <button
              onClick={() => {
                const next = lang === "en-US" ? "ur-PK" : "en-US";
                setLang(next);
                langRef.current = next;
                if (micOnRef.current) startRecognition(); // re-listen in the new locale
              }}
              className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 light:border-zinc-300 light:text-zinc-600 light:hover:border-zinc-400 light:hover:text-zinc-900"
              title="Speech recognition can't auto-detect language — pick the one you'll speak."
            >
              {lang === "en-US" ? "🇬🇧 English" : "🇵🇰 اردو"}
            </button>
          )}
          {showDashboard && (
            <button
              onClick={() => setNeuralVoice((v) => !v)}
              className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 light:border-zinc-300 light:text-zinc-600 light:hover:border-zinc-400 light:hover:text-zinc-900"
              title="Neural voice sounds human but takes a moment; system voice is instant."
            >
              Voice: {neuralVoice ? "Neural" : "System"}
            </button>
          )}
          <span className={`rounded-full border px-3 py-1 text-[11px] font-medium ${connPill.cls}`}>
            {connPill.text}
          </span>
          {conn === "connected" && (
            <button
              onClick={handleDisconnect}
              className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 light:border-zinc-300 light:text-zinc-600 light:hover:border-zinc-400 light:hover:text-zinc-900"
            >
              Disconnect
            </button>
          )}
        </div>
      </header>

      {conn === "checkpoint" && (
        <div className="fade-in mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
          <strong className="font-semibold">LinkedIn security check.</strong> Solve the CAPTCHA or
          verification in the open Chrome window, then carry on here — I&apos;ll pick it up automatically.
        </div>
      )}

      {!showDashboard ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="fade-in w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-2xl backdrop-blur light:border-zinc-200 light:bg-white/80">
            <h2 className="text-lg font-semibold text-white light:text-zinc-900">Connect your LinkedIn</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-500 light:text-zinc-600">
              A real Chrome window opens and signs in. Your credentials go only to LinkedIn — the
              session is saved locally, so next time you won&apos;t need them at all.
            </p>
            <div className="mt-6 space-y-3">
              <input
                type="email"
                placeholder="LinkedIn email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950/70 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition focus:border-indigo-500 light:border-zinc-300 light:bg-white light:text-zinc-900 light:placeholder-zinc-400"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950/70 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition focus:border-indigo-500 light:border-zinc-300 light:bg-white light:text-zinc-900 light:placeholder-zinc-400"
              />
              <button
                onClick={handleConnect}
                disabled={conn === "connecting"}
                className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 disabled:opacity-50"
              >
                {conn === "connecting" ? "Opening Chrome & signing in…" : "Connect & launch"}
              </button>
              {connError && <p className="text-[12px] text-rose-400">{connError}</p>}
              <p className="pt-1 text-center text-[11px] text-zinc-600 light:text-zinc-500">
                Signed in before? Leave the fields empty and hit Connect.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
          <section className="flex flex-col items-center justify-center rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-8 backdrop-blur light:border-zinc-200 light:bg-white/70">
            <div className={`orb ${agentState}`} onClick={toggleMic} title={micOn ? "Stop listening" : "Start listening"}>
              <div className="orb-glow" />
              <div className="orb-ring" />
              <div className="orb-core">
                <div className="orb-blob orb-blob-1" />
                <div className="orb-blob orb-blob-2" />
                <div className="orb-blob orb-blob-3" />
                <div className="orb-swirl" />
              </div>
              <div className="orb-gloss" />
            </div>
            <p className="mt-8 text-sm font-medium text-zinc-300 light:text-zinc-700">{stateLabel[agentState]}</p>
            <p className="mt-1 min-h-[22px] max-w-md text-center text-[13px] italic text-zinc-500 light:text-zinc-500">
              {interim ||
                (agentState === "listening"
                  ? "Try: “summarize this post”, “like it”, “open my profile photo”"
                  : "")}
            </p>
            {agentState !== "idle" && agentState !== "listening" && (
              <button
                onClick={() => {
                  interrupt();
                  setAgentState(micOnRef.current ? "listening" : "idle");
                }}
                className="mt-3 rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 transition hover:border-rose-500/50 hover:text-rose-300 light:border-zinc-300 light:text-zinc-600"
              >
                Stop
              </button>
            )}
            {!speechSupported && (
              <p className="mt-2 max-w-sm text-center text-[12px] text-amber-400">
                Voice input needs Chrome or Edge with microphone permission. You can still type below.
              </p>
            )}

            <div className="mt-8 w-full max-w-lg space-y-3">
              {messages.slice(-2).map((m, i) => (
                <div
                  key={i}
                  className={`fade-in rounded-2xl px-4 py-3 text-[13px] leading-relaxed ${
                    m.role === "user"
                      ? "ml-10 bg-indigo-500/15 text-indigo-100 light:bg-indigo-100 light:text-indigo-900"
                      : "mr-10 border border-zinc-800 bg-zinc-950/60 text-zinc-300 light:border-zinc-200 light:bg-white light:text-zinc-700"
                  }`}
                >
                  {m.content}
                </div>
              ))}
            </div>

            <form
              className="mt-6 flex w-full max-w-lg gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                sendCommand(textInput);
                setTextInput("");
              }}
            >
              <input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="…or type a command"
                className="flex-1 rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-2.5 text-sm text-white placeholder-zinc-600 outline-none transition focus:border-indigo-500 light:border-zinc-300 light:bg-white light:text-zinc-900 light:placeholder-zinc-400"
              />
              <button
                type="submit"
                className="rounded-xl bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 transition hover:bg-zinc-700 light:bg-zinc-200 light:text-zinc-800 light:hover:bg-zinc-300"
              >
                Send
              </button>
            </form>
          </section>

          <aside className="flex max-h-[calc(100vh-140px)] flex-col rounded-2xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur light:border-zinc-200 light:bg-white/70">
            <div className="border-b border-zinc-800 px-5 py-4 light:border-zinc-200">
              <h3 className="text-sm font-semibold text-white light:text-zinc-900">Activity</h3>
              <p className="text-[11px] text-zinc-500 light:text-zinc-500">everything Jarvis does, live</p>
            </div>
            <div className="panel-scroll flex-1 space-y-2 overflow-y-auto p-4">
              {feed.length === 0 && (
                <p className="pt-8 text-center text-[12px] text-zinc-600 light:text-zinc-500">
                  Actions show up here once you start talking.
                </p>
              )}
              {feed.map((f) => (
                <div
                  key={f.id}
                  className={`fade-in rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed ${
                    f.kind === "user"
                      ? "border-indigo-500/25 bg-indigo-500/10 text-indigo-200"
                      : f.kind === "assistant"
                        ? "border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-100"
                        : f.kind === "tool_error" || f.kind === "error"
                          ? "border-rose-500/25 bg-rose-500/10 text-rose-200"
                          : f.kind === "tool_result"
                            ? "border-emerald-500/20 bg-emerald-500/5 text-zinc-400"
                            : "border-zinc-800 bg-zinc-950/50 text-zinc-300 light:border-zinc-200 light:bg-white light:text-zinc-700"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{f.title}</span>
                    <span className="shrink-0 text-[10px] text-zinc-600 light:text-zinc-400">{f.time}</span>
                  </div>
                  {f.detail && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-zinc-500 light:text-zinc-500">{f.detail}</p>
                  )}
                </div>
              ))}
              <div ref={feedEndRef} />
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
