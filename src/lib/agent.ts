import * as li from "./linkedin";
import { probeStatus, getLastPosts } from "./session";
import { beginRun, cancelled } from "./cancel";
import * as safety from "./safety";

/* ------------------------------------------------------------------ */
/* Tool schemas (OpenAI/Groq function-calling format)                  */
/* ------------------------------------------------------------------ */

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "scroll",
      description:
        "Scroll the feed. speed 'slow' glides gently so the user can read along and interrupt with 'stop' — use it whenever they say 'scroll slowly' or 'slowly go down'. The user can say stop at any point and the scroll halts immediately.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["down", "up"] },
          amount: { type: "number", description: "Roughly how many posts. Default 2." },
          speed: { type: "string", enum: ["slow", "normal", "fast"] },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_visible_posts",
      description:
        "Read the posts currently on screen: author, text, reaction counts, and whether the user already liked them. ALWAYS call this before liking or commenting so you know which post is which.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "like_post",
      description: "Like (or react to) a visible post, by its number from read_visible_posts or by author name.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Post number like '2', or an author name like 'Sundar Pichai'" },
          reaction: {
            type: "string",
            enum: ["Like", "Celebrate", "Support", "Love", "Insightful", "Funny"],
            description: "Reaction type. Default Like.",
          },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unlike_post",
      description: "Remove the user's reaction (like/celebrate/etc.) from a visible post.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "Post number or author name" } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expand_post",
      description: "Expand a truncated post ('see more') and read its full text.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "Post number or author name" } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_post",
      description: "Save a visible post to the user's saved items.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "Post number or author name" } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repost",
      description: "Repost a visible post to the user's followers, optionally with the user's own commentary. Confirm before calling unless clearly instructed.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Post number or author name" },
          thoughts: { type: "string", description: "Optional commentary to add" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_my_recent_posts",
      description: "Open the user's own recent posts/activity page and read them. Use before deleting one of the user's posts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_post",
      description:
        "Delete one of the USER'S OWN posts. Call open_my_recent_posts first. The first call NEVER deletes — it returns the post text for you to read back to the user. Only after they say yes, call again with confirmed=true.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Post number or author name" },
          confirmed: {
            type: "boolean",
            description: "Set true ONLY after the user has explicitly confirmed this exact post.",
          },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_comment",
      description:
        "Delete the user's own comment on a post — use for 'undo that comment', 'remove my comment'. Same two-step confirmation as delete_post.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Post number or author name whose comments to open" },
          confirmed: { type: "boolean", description: "True only after the user confirms." },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_post",
      description:
        "Read a post's FULL text (expanding 'see more' if needed) so you can summarize it aloud for the user. Use for 'summarize this post', 'what's this about', 'give me the gist'.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "Post number or author name" } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_profile_photo",
      description:
        "Open the profile photo of the profile on screen, or of a named person. Use for 'view my profile photo', 'show me his picture'.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person's name, or 'me' for the user. Omit to use the profile already open." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description:
        "Click ANY button, link or tab on screen by its visible text or label. This is the catch-all for anything without a dedicated tool — 'click Jobs', 'press See all', 'hit Skip', 'click on that button'.",
      parameters: {
        type: "object",
        properties: { label: { type: "string", description: "Visible text or aria-label of the thing to click" } },
        required: ["label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_my_activity",
      description:
        "Open the user's own activity: their posts, their comments, or their reactions. Use for 'show my comments', 'what have I posted', 'what did I react to'.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["posts", "comments", "reactions"] },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_saved_posts",
      description: "Open the user's saved posts / saved items. Use for 'show my saved posts', 'what did I bookmark'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_message",
      description:
        "Edit the user's most recent message in a DM thread. Use for 'edit my message to X', 'change what I sent to X'.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          text: { type: "string", description: "The corrected message text" },
        },
        required: ["person", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_message",
      description:
        "Delete the user's most recent message in a DM thread. Use for 'delete my message to X', 'unsend that'. Two-step confirmation like other deletes.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          confirmed: { type: "boolean", description: "True only after the user confirms." },
        },
        required: ["person"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_back",
      description: "Go back to the previous page in the browser. Use for 'go back', 'previous page', 'undo that navigation'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "follow_person",
      description: "Follow a person or company on LinkedIn.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unfollow_person",
      description: "Unfollow a person or company. Use for 'unfollow X', 'stop following X'.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_profile",
      description: "Read the profile page currently open on screen (name, headline, about).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "comment_on_post",
      description: "Write a comment on a visible post. Keep comments natural, warm and short (1-2 sentences) unless the user dictated exact text.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Post number or author name" },
          text: { type: "string" },
        },
        required: ["target", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_post_comments",
      description: "Open and read the comments under a visible post.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "Post number or author name" } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_post",
      description: "Publish a new LinkedIn post as the user. Only call when the user clearly asked to post, and confirm the text with them first if they didn't dictate it.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search LinkedIn for people, posts, companies or jobs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["all", "people", "posts", "companies", "jobs"] },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_profile",
      description: "Open a person's LinkedIn profile by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connect_with_person",
      description: "Send a connection request to a person, optionally with a note. Confirm with the user before sending unless they explicitly asked.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          note: { type: "string", description: "Optional invitation note" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_notifications",
      description: "Open the notifications page and read the latest notifications aloud.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_messages",
      description: "Open LinkedIn messaging and read the recent conversation list.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a direct message to someone in the recent conversations list. Confirm wording with the user first unless they dictated it.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          text: { type: "string" },
        },
        required: ["person", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_home",
      description: "Navigate back to the LinkedIn home feed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_screen",
      description: "Describe what is currently on the screen (page + visible posts).",
      parameters: { type: "object", properties: {} },
    },
  },
] as const;

/**
 * Deletions are irreversible, so they take two turns no matter what the model
 * decides: the first call is refused and returns the exact post text, which the
 * model reads back to the user; only a call carrying confirmed=true goes through.
 * This is enforced here rather than in the prompt so the model can't skip it.
 */
const DESTRUCTIVE = new Set(["delete_post", "delete_comment", "delete_message"]);

function requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
  return DESTRUCTIVE.has(name) && args.confirmed !== true;
}

/**
 * Which tools count as "writes" LinkedIn tracks, and under which budget. Reads
 * (scroll, read, summarize, search, open profile) are unbudgeted — LinkedIn does
 * not punish reading, and pretending otherwise would just make Jarvis useless.
 */
const WRITE_KIND: Record<string, safety.ActionKind> = {
  like_post: "like",
  unlike_post: "like",
  save_post: "like", // same lightweight class of interaction
  comment_on_post: "comment",
  delete_comment: "comment",
  create_post: "post",
  delete_post: "post",
  repost: "repost",
  follow_person: "follow",
  unfollow_person: "follow",
  connect_with_person: "connect",
  send_message: "message",
  edit_message: "message",
  delete_message: "message",
};

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  await li.guardSession(); // surfaces CAPTCHAs / sign-outs instead of failing silently

  if (requiresConfirmation(name, args)) {
    if (name === "delete_message") {
      return (
        `NOT DELETED YET — confirmation required. Ask the user to confirm they want to permanently ` +
        `delete their last message to ${args.person}. If they say yes, call delete_message again with confirmed=true.`
      );
    }
    const which = String(args.target ?? "");
    const posts = await getLastPosts();
    const idx = parseInt(which, 10);
    const entry = Number.isFinite(idx) ? posts[idx - 1] : posts.find((p) => p.author.toLowerCase().includes(which.toLowerCase()));
    const desc = entry
      ? `"${entry.text.slice(0, 120)}${entry.text.length > 120 ? "…" : ""}" by ${entry.author}`
      : `post ${which}`;
    return (
      `NOT DELETED YET — confirmation required. Read this back to the user and ask them to confirm: ` +
      `you are about to permanently delete ${desc}. ` +
      `If they say yes, call ${name} again with the same target and confirmed=true. If they say no, do nothing.`
    );
  }

  // Account safety: budget + pace every write. Throws a SafetyError (which the
  // agent reads aloud) when a limit is hit, rather than plowing on.
  const kind = WRITE_KIND[name];
  if (kind) await safety.guardWrite(kind);
  else safety.noteRead();

  const result = await dispatch(name, args);

  // Only a write that actually SUCCEEDED counts against the budget — a failed
  // click shouldn't cost the user part of their daily allowance.
  if (kind) safety.recordWrite(kind);
  return result;
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<string> {
  const num = (v: unknown): number | string => {
    const s = String(v ?? "").trim();
    const n = parseInt(s, 10);
    return /^\d+$/.test(s) ? n : s;
  };
  switch (name) {
    case "scroll":
      return li.scroll(
        (args.direction as "down" | "up") ?? "down",
        Number(args.amount ?? 2),
        (args.speed as "slow" | "normal" | "fast") ?? "normal"
      );
    case "edit_message":
      return li.editMessage(String(args.person ?? ""), String(args.text ?? ""));
    case "delete_message":
      return li.deleteMessage(String(args.person ?? ""));
    case "read_visible_posts":
      return li.readVisiblePosts();
    case "like_post":
      return li.likePost(num(args.target), args.reaction as string | undefined);
    case "unlike_post":
      return li.unlikePost(num(args.target));
    case "expand_post":
      return li.expandPost(num(args.target));
    case "save_post":
      return li.savePost(num(args.target));
    case "repost":
      return li.repost(num(args.target), args.thoughts as string | undefined);
    case "open_my_recent_posts":
      return li.openMyRecentPosts();
    case "delete_post":
      return li.deletePost(num(args.target));
    case "delete_comment":
      return li.deleteComment(num(args.target));
    case "summarize_post":
      return li.expandPost(num(args.target));
    case "view_profile_photo":
      return li.viewProfilePhoto(args.name ? String(args.name) : undefined);
    case "click_element":
      return li.clickElement(String(args.label ?? ""));
    case "go_back":
      return li.goBack();
    case "open_my_activity":
      return li.openMyActivity((args.kind as "posts" | "comments" | "reactions") ?? "posts");
    case "open_saved_posts":
      return li.openSavedPosts();
    case "follow_person":
      return li.followPerson(String(args.name ?? ""));
    case "unfollow_person":
      return li.unfollowPerson(String(args.name ?? ""));
    case "read_profile":
      return li.readProfile();
    case "comment_on_post":
      return li.commentOnPost(num(args.target), String(args.text ?? ""));
    case "open_post_comments":
      return li.openPostComments(num(args.target));
    case "create_post":
      return li.createPost(String(args.text ?? ""));
    case "search":
      return li.search(String(args.query ?? ""), (args.kind as "all" | "people" | "posts" | "companies" | "jobs") ?? "all");
    case "open_profile":
      return li.openProfile(String(args.name ?? ""));
    case "connect_with_person":
      return li.connectWithPerson(String(args.name ?? ""), args.note as string | undefined);
    case "open_notifications":
      return li.openNotifications();
    case "read_messages":
      return li.readMessages();
    case "send_message":
      return li.sendMessage(String(args.person ?? ""), String(args.text ?? ""));
    case "go_home":
      return li.goHome();
    case "describe_screen":
      return li.describeScreen();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* Groq agent loop                                                     */
/* ------------------------------------------------------------------ */

interface Provider {
  url: string;
  key: string;
  model: string;
  name: string;
}

/**
 * Gemini 2.5 (free tier) via its OpenAI-compatible endpoint, with Groq as a
 * standby. Gemini's free tier returns 429/503 under load, so a request that
 * fails that way transparently retries on the next provider.
 */
function getProviders(): Provider[] {
  const list: Provider[] = [];
  const gemini = process.env.GEMINI_API_KEY;
  const groq = process.env.GROQ_API_KEY;
  const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

  // Groq FIRST, and with SEVERAL Groq models before we ever touch Gemini.
  //   - Groq is faster (~0.8s vs ~1.6s).
  //   - Critically, Gemini's OpenAI-compat endpoint is BROKEN for multi-turn
  //     tool calls: the second call (after a tool runs) fails with
  //     "missing thought_signature", which killed every multi-step command.
  //     Staying on Groq — one model failing over to the next Groq model on a
  //     rate limit — avoids Gemini entirely for the normal path.
  const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
  if (groq) {
    for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"]) {
      list.push({ url: GROQ_URL, key: groq, model, name: `Groq ${model.split("/").pop()}` });
    }
  }
  // Gemini is last-resort only. It's fine for a SINGLE-turn reply (no tools),
  // but must not be relied on mid-tool-loop.
  if (gemini) {
    list.push({ url: GEMINI_URL, key: gemini, model: "gemini-flash-latest", name: "Gemini Flash" });
  }
  return list;
}

/** Try each provider in turn; retry once on transient overload before failing over. */
async function chat(providers: Provider[], body: object): Promise<{ msg: ChatMessage } | { error: string }> {
  let lastError = "No providers configured.";
  for (const p of providers) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({ ...body, model: p.model }),
      }).catch((e) => {
        lastError = `${p.name}: ${e instanceof Error ? e.message : String(e)}`;
        return null;
      });
      if (!res) break;

      if (res.ok) {
        const data = await res.json();
        const msg = data.choices?.[0]?.message;
        if (msg) return { msg };
        lastError = `${p.name} returned an empty response.`;
        break;
      }

      const text = await res.text().catch(() => "");
      lastError = `${p.name} error ${res.status}: ${text.slice(0, 200)}`;
      // 429/5xx = overloaded or out of quota; tool_use_failed = this model
      // botched the function call. Both are worth another model's attempt.
      // Anything recoverable → switch model IMMEDIATELY. Sleeping and retrying
      // the same overloaded model just adds seconds to a voice reply; another
      // provider is almost always faster than waiting for this one.
      const retryable =
        res.status === 429 || res.status >= 500 || text.includes("tool_use_failed");
      if (!retryable) break;
      if (res.status === 429 || text.includes("exceeded your current quota") || text.includes("tool_use_failed")) {
        break; // no backoff — go straight to the next provider
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { error: lastError };
}

const SYSTEM_PROMPT = `You are Jarvis, a fluent voice assistant that operates the user's LinkedIn account through a real browser you control with tools.

LANGUAGE — the user speaks English and Urdu:
- ALWAYS reply in the language the user just used. If they speak Urdu, reply in Urdu. If they speak English, reply in English. If they mix (Roman Urdu / Urdu-English), mirror that mix naturally.
- Urdu commands mean the same things: "scroll karo" / "neeche jao" = scroll down; "like karo" = like; "post likho" / "post banao" = create_post; "summarize karo" / "ye post kya hai" = summarize_post; "rok do" / "bas" / "ruko" = stop; "message bhejo" = send_message; "follow karo" = follow_person; "connect karo" / "request bhejo" = connect_with_person; "delete karo" / "hata do" = delete; "dhundo" / "search karo" = search; "aahista scroll karo" = scroll slowly.
- Write Urdu in Urdu script (نستعلیق) when they wrote Urdu script; use Roman Urdu when they used Roman Urdu.
- Tool arguments (post text, comments, messages) stay in whatever language the user dictated.

Everything you say is spoken aloud with text-to-speech, so:
- Reply like natural speech: short, warm, confident. USUALLY ONE SENTENCE. Never more than two, unless summarizing a post.
- Never use markdown, bullet points, emojis, asterisks, or URLs in replies.
- Don't narrate what you're about to do ("Let me read the posts…") — just do it, then report the result. Speed matters; the user sees the browser.
- When you read posts aloud, summarize them conversationally ("The top post is from Sarah Chen about her promotion to VP") instead of quoting raw text.
- The user can interrupt you mid-sentence. If their new message changes direction, drop the old task without complaint.

The SAME intent has endless phrasings. Voice transcripts are messy — typos, no punctuation, slang, half sentences. Never say "I don't understand"; map to the closest tool and act. Examples, not an exhaustive list:
- create_post: "start a post", "start post", "make a post", "make a posty", "write a post", "post this", "share an update", "publish something", "put up a post"
- scroll: "scroll", "go down", "next", "keep going", "show me more", "move on", "scroll back up", "go up"
- read_visible_posts / describe_screen: "what's on screen", "read it", "what do you see", "read the feed", "what's here", "where am I"
- summarize_post: "summarize this post", "what's this about", "give me the gist", "tldr", "explain this post", "what's he saying"
- like_post: "like it", "like this", "thumbs up", "hit like", "heart that", "celebrate that", "react love", "give it a like"
- unlike_post: "unlike", "remove my like", "take that back", "undo the like", "un-react"
- comment_on_post: "comment on it", "reply to that post", "add a comment", "say something nice", "drop a comment"
- delete_comment: "undo my comment", "remove my comment", "delete what I wrote"
- expand_post: "see more", "read the whole thing", "full post", "expand it"
- save_post / repost: "save it", "bookmark that" / "share that", "repost it", "reshare"
- delete_post: "delete my post", "remove my last post", "take that post down", "undo my post"
- open_notifications / read_messages: "anything new", "any updates", "check notifications" / "any DMs", "check my inbox", "any messages"
- send_message: "message X", "reply to X", "tell X that…", "text X", "DM X"
- search / open_profile: "find X", "look up X", "search for X" / "who is X", "open X's page", "show me X's profile"
- view_profile_photo: "view my profile photo", "open his picture", "show me her photo", "let me see the profile pic"
- follow_person / connect_with_person: "follow X" / "connect with X", "add X", "send X a request", "invite X"
- click_element: ANYTHING else on screen — "click Jobs", "press See all", "hit Skip", "click on that", "tap the button", "open that tab". When no dedicated tool fits, reach for click_element with the visible label.
- go_back: "go back", "previous page", "take me back"

Operating rules:
- BE FAST. Take the shortest path. Do NOT call read_visible_posts before acting — like_post, comment_on_post, save_post etc. already read the screen themselves. Only call read_visible_posts when the user actually wants the posts read out, or when you need the content to write a comment or summary.
- "this post", "it", "that" = post number 1 (the one most in view). Numbers run top of screen downwards.
- Ambiguous? Pick the most reasonable interpretation and do it — then say what you did. Don't interrogate the user.
- Comments and posts: use the user's exact words if they dictated them. Otherwise write something short, human and specific to the post — never generic spam like "Great post!".
- Only post, message, or send connection requests when clearly asked. If the wording wasn't given, say your proposed text aloud and wait for a go-ahead.
- DELETING IS PERMANENT AND ALWAYS TWO STEPS. Your first delete_post / delete_comment call is automatically refused and hands you the post's text — read that text back and ask "shall I delete it?". Only when the user clearly says yes, call again with confirmed=true. If they hesitate or change the subject, don't delete.
- If a tool fails, say plainly what happened and what to try next.
- On a security checkpoint or CAPTCHA, stop everything and tell the user to solve it in the Chrome window.
ACCOUNT SAFETY — this protects the user from being restricted or banned:
- There are hard daily and hourly limits on likes, comments, connects, follows, messages and posts. If a tool refuses with a safety limit, DO NOT retry it, do not try a different tool to achieve the same thing, and do not argue. Tell the user plainly what the limit was and that you stopped to protect their account.
- NEVER mass-act. If asked to "like everything", "connect with everyone", "comment on all of these" — refuse the bulk framing, do at most 2-3, and say you're keeping it human-paced on purpose.
- Actions are deliberately spaced out. If the user asks why you're slow on writes, explain it's pacing that keeps their account safe.
- Never write the same comment twice, and never send identical messages to multiple people — repetition is the clearest automation signal there is.

The user watches the browser window on their screen, so narrate lightly, not exhaustively.`;

/**
 * Tools whose result is ALREADY a good spoken sentence ("Liked Sarah's post.").
 *
 * For these we skip the second model call entirely and speak the tool's own
 * output. That call existed only to have the model rephrase a sentence we
 * already had — it doubled the latency of every simple command for nothing.
 *
 * Anything needing judgement (reading posts aloud, summarising, search results)
 * still goes back to the model, because those results are raw data, not speech.
 */
const SPEAKABLE = new Set([
  "scroll",
  "like_post",
  "unlike_post",
  "save_post",
  "comment_on_post",
  "create_post",
  "repost",
  "delete_post",
  "delete_comment",
  "follow_person",
  "unfollow_person",
  "connect_with_person",
  "send_message",
  "edit_message",
  "delete_message",
  "go_home",
  "go_back",
  "click_element",
  "view_profile_photo",
]);

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "tool_error" | "assistant" | "error";
  name?: string;
  args?: Record<string, unknown>;
  content?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

/** Urdu script, or the Roman-Urdu verbs that show up in spoken commands. */
function userSpeaksUrdu(history: { role: string; content: string }[]): boolean {
  const last = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (/[؀-ۿݐ-ݿ]/.test(last)) return true;
  return /\b(karo|kardo|kar do|bhejo|dikhao|ruko|rok do|neeche|upar|aahista|ahista|mera|meri|mujhe|kya|nahi|acha|theek)\b/i.test(
    last
  );
}

export async function* runAgent(
  history: { role: "user" | "assistant"; content: string }[]
): AsyncGenerator<AgentEvent> {
  const providers = getProviders();
  if (!providers.length) {
    yield { type: "error", content: "No API key found — set GEMINI_API_KEY or GROQ_API_KEY in .env.local" };
    return;
  }
  // MUST be the same check the status endpoint uses. getStatus() reads in-memory
  // state, which on serverless is empty on every request — so the agent always
  // believed it was disconnected even while the header said "connected".
  const { status } = await probeStatus();
  beginRun(); // clears any leftover cancel from the previous command

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(status !== "connected"
      ? [
          {
            role: "system" as const,
            content:
              "NOTE: LinkedIn is NOT connected right now. Tools will fail — tell the user to connect their account from the dashboard first. Say this IN THE USER'S OWN LANGUAGE.",
          },
        ]
      : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
    // Last word wins: keeps the language rule from being drowned out by the
    // English system notes and tool output above.
    {
      role: "system" as const,
      content:
        "REMINDER: Reply in the SAME language the user just used. Urdu script in → Urdu script out. Roman Urdu in → Roman Urdu out. English in → English out. Never switch languages on them.",
    },
  ];

  // Tracks what the tools produced this turn, so a later model failure can be
  // answered from real results instead of a scary "something went wrong".
  let lastResults: string[] = [];

  for (let turn = 0; turn < 8; turn++) {
    if (cancelled()) {
      yield { type: "assistant", content: "Stopped." };
      return;
    }
    const result = await chat(providers, {
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.4, // less dithering = fewer wasted tool hops
      max_tokens: 400, // replies are one or two spoken sentences
    });

    if ("error" in result) {
      // If tools already ran this turn, the ACTION succeeded — only the model's
      // closing sentence failed. Speak the tool output rather than erroring, so
      // a flaky model never makes a completed action look broken.
      if (lastResults.length) {
        const summary = lastResults.join(" ").replace(/\s+/g, " ").trim();
        yield { type: "assistant", content: summary.slice(0, 600) };
        return;
      }
      yield { type: "error", content: result.error };
      return;
    }
    const msg = result.msg;

    if (msg.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });
      const spoken: string[] = [];
      let allSpeakable = true;
      let anyFailed = false;
      lastResults = [];

      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
        yield { type: "tool_call", name: tc.function.name, args };
        try {
          const result = await executeTool(tc.function.name, args);
          yield { type: "tool_result", name: tc.function.name, content: result };
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          lastResults.push(result);
          if (SPEAKABLE.has(tc.function.name)) spoken.push(result);
          else allSpeakable = false;
        } catch (e) {
          const errText = e instanceof Error ? e.message : String(e);
          yield { type: "tool_error", name: tc.function.name, content: errText };
          messages.push({ role: "tool", tool_call_id: tc.id, content: `ERROR: ${errText}` });
          anyFailed = true;
          allSpeakable = false;
        }
      }

      // FAST PATH: the tools already produced a sentence fit to speak, so skip
      // the extra model round trip that would only rephrase it. Halves the
      // latency of "like it", "scroll down", "save that" and friends.
      // (Not taken if anything failed or needs interpretation — those need the
      // model to explain, summarise, or decide what to do next.)
      // Tool results are written in English, so the shortcut is only safe when
      // the user is speaking English. Urdu goes back to the model to be answered
      // in Urdu — correctness beats the saved second.
      if (allSpeakable && !anyFailed && spoken.length && !cancelled() && !userSpeaksUrdu(history)) {
        yield { type: "assistant", content: spoken.join(" ") };
        return;
      }

      continue; // let the model see tool results and respond
    }

    yield { type: "assistant", content: msg.content ?? "" };
    return;
  }

  yield {
    type: "assistant",
    content: "I did quite a few steps there — tell me what you'd like next.",
  };
}
