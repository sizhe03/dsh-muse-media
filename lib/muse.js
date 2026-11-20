/**
 * Muse page automation.
 *
 * Everything here runs against a live muse.ai page over CDP; nothing in this
 * file knows about accounts, queues or DSH. The rule that shapes it: **one send
 * action per task**. `sendOnce` fires exactly one click *or* one Enter and then
 * reports which one it used — it never retries, never presses Enter after a
 * click, and never clicks again later. The reference implementation's
 * "click again if the composer still holds text" fallback is deliberately gone:
 * a task that cannot prove it was delivered has to surface that, not gamble a
 * second request against someone's quota.
 *
 * The page-side functions are written as real JavaScript functions and shipped
 * with `fn.toString()`, so the file is syntax-checked at import time and the
 * selectors stay readable instead of living inside escaped strings.
 */

import { CdpError } from "./cdp.js";
import {
  MuseFailure,
  FAILURE,
  looksLikeQuotaText,
  looksLikeRateLimit,
  looksLikeSignInWall,
  parseRetryInstant,
  looksLikeContentRefusal,
  looksLikeRegionRefusal,
} from "./pool.js";

/** The thread a generation or probe runs in. */
export const THREAD_URL = "https://muse.ai/thread/new";

/** Sampling interval for the delivery and media polls, in ms. */
const SAMPLE_MS = 700;

/**
 * How many times one media source may be fetched before it is written off.
 *
 * An attachment node that exists but cannot be read yet is the *normal* state for
 * a moment after it appears (poster loading, video metadata, a re-issued blob
 * URL). One attempt is not enough — a result was lost that way. Three covers the
 * transient cases while still letting a genuinely unrelated node be excluded
 * within a few seconds at `SAMPLE_MS`.
 */
const MAX_FETCH_ATTEMPTS = 3;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the Stop control is actually showing — the rule, stated once.
 *
 * Every page helper here is shipped into the browser through `fn.toString()` on
 * its own, so a page-side function cannot call a sibling: the callee's name is
 * simply not defined in that evaluation. The check is therefore inlined at each
 * use site (`pageSnapshot`, `pageBubbles`), and `_check-pagefns` asserts no page
 * function references another.
 *
 * The rule itself: `querySelector` is not enough. The composer keeps the Stop
 * node mounted and toggles its visibility, so a presence check reports "still
 * generating" forever; in the probe that is fatal, because no baseline could
 * ever be taken and every test would time out. A zero-sized node in a collapsed
 * toolbar and a hidden overlay are the same trap, so geometry, visibility and
 * opacity are all required.
 */

/* ------------------------------------------------------------------ */
/* Page-side helpers (shipped into the page as source)                 */
/* ------------------------------------------------------------------ */

/**
 * Report whether the shell is ready, and why not.
 *
 * Mirrors the reference implementation's hydration gate: `readyState`,
 * the textarea, the shell's hydration marker, and the gateway banner each mean
 * a different failure, and the caller reports the specific one.
 */
export function pageReady() {
  if (document.readyState !== "complete") return "loading";
  const textarea = document.querySelector("textarea");
  if (!textarea) return "no-composer";
  const shell = document.querySelector("[data-hatch-shell-hydration-state]");
  if (shell && shell.getAttribute("data-hatch-shell-hydration-state") !== "hydrated") return "hydrating";
  /**
   * "Connecting..." only counts where a status notice can live.
   *
   * Scanning `document.body.innerText` matched the chat transcript too, so a message that merely mentions
   * the phrase — a user quoting it, or an earlier reply containing it — pinned the account at "connecting"
   * for the rest of the session. The status line is not in the transcript; it is chrome around it.
   *
   * Without a way to verify the exact element from here, the scan is limited to nodes that are not part of a
   * message bubble. A miss leaves the state as it was, which is the safe direction: readiness falls back to
   * the composer and hydration checks rather than to a string match.
   */
  const statusText = (() => {
    if (!document.body) return "";
    const scopes = [...document.querySelectorAll('[role="status"],[aria-live],[class*="status"],[class*="notice"]')];
    return scopes
      .filter((node) => !node.closest('[class*="groupable-bubble"],[class*="chat-user-bubble"],[class*="agent-bubble"]'))
      .map((node) => node.innerText || "")
      .join(" ");
  })();
  if (statusText.indexOf("Connecting...") !== -1) return "connecting";
  if (textarea.disabled) return "input-disabled";
  return "ready";
}

/**
 * Run the page's own authenticated session check.
 *
 * This is the only thing that marks an account usable. It is a same-origin
 * `fetch` with the browser's cookies, so it proves the *browser profile* is
 * signed in — a credential the plugin never reads. A 401 means the session is
 * genuinely gone; anything else (network error, 5xx) is reported as an
 * unknown state and must not mark the account as signed out.
 */
async function pageSessionCheck() {
  try {
    const response = await fetch("/api/session", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const status = body && typeof body.status === "string" ? body.status : undefined;
    return {
      ok: response.ok,
      httpStatus: response.status,
      status,
      hasWorkspace: Boolean(body && (body.workspace_id || body.workspace || body.vm_id)),
      text: text.slice(0, 300),
    };
  } catch (error) {
    return { ok: false, httpStatus: 0, status: undefined, hasWorkspace: false, text: String(error) };
  }
}

/** Snapshot the parts of the page the polls need. */
export function pageSnapshot() {
  const textarea = document.querySelector("textarea");
  // Inlined, not delegated: this function is shipped into the page as its own
  // source, so it can only use what it declares itself.
  const stopCandidates = [
    document.querySelector('[data-testid="hatch-composer-stop-button"]'),
    ...document.querySelectorAll('button[aria-label*="Stop" i],button[aria-label*="停止"]'),
  ].filter(Boolean);
  let stop = false;
  for (const node of stopCandidates) {
    if (node.getClientRects().length === 0) continue;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (Number(style.opacity) === 0) continue;
    stop = true;
    break;
  }
  const scope =
    document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') || document.body;
  const bubbles = scope
    ? [...scope.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]')]
    : [];
  const kinds = bubbles.map((bubble) => {
    const className = bubble.className || "";
    if (/hatch-agent-bubble-bg/.test(className)) return "agent";
    if (/chat-user-bubble/.test(className)) return "user";
    return "other";
  });
  const agents = [];
  const users = [];
  for (let index = 0; index < bubbles.length; index += 1) {
    const text = (bubbles[index].innerText || "").trim();
    const entry = { index, text };
    if (kinds[index] === "agent") agents.push(entry);
    else if (kinds[index] === "user") users.push(entry);
  }
  const attachments = [...document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]')].map(
    (node) => {
      const video = node.querySelector("video");
      const image = node.querySelector("img");
      const testId = node.getAttribute("data-testid") || "";
      return {
        testId,
        video: video ? video.currentSrc || video.src || "" : "",
        image: image ? image.currentSrc || image.src || "" : "",
        width: (video || image || {}).videoWidth || (image || {}).naturalWidth || 0,
        height: (video || image || {}).videoHeight || (image || {}).naturalHeight || 0,
        /**
         * True when the node lives inside a *user* bubble. Those are this
         * task's own uploaded references, not the model's output, so they must
         * never be picked as a result — the reference implementation had to
         * hash uploaded bytes for the same reason, and this is the cheaper
         * structural form of that check.
         */
        inUser: Boolean(node.closest('div[class*="chat-user-bubble"]')),
      };
    },
  );
  return {
    stop,
    kinds,
    agents,
    users,
    attachments,
    composer: {
      text: textarea ? textarea.value || "" : "",
      attachments: (() => {
        // Count the composer's own remove buttons: a thumbnail in the composer
        // has one, and a sent message's bubble is explicitly excluded.
        const rx = /remove\s*attachment|移除附件|刪除附件|删除附件/i;
        const bubble = '[class*=chat-user-bubble], div[class*="hatch-chat-groupable-bubble"]';
        for (let node = textarea; node && node !== document.body; node = node.parentElement) {
          const count = [...node.querySelectorAll("button[aria-label]")].filter(
            (button) => rx.test(button.getAttribute("aria-label") || "") && !button.closest(bubble),
          ).length;
          if (count) return count;
        }
        return 0;
      })(),
    },
    tail: document.body ? (document.body.innerText || "").slice(-1200) : "",
    path: location.pathname || "",
  };
}

/**
 * Count the attachments inside the user bubble that carries `prompt`.
 *
 * Exactly one match is required; two bubbles with the same text (a user who
 * sent the same prompt twice) make the round ambiguous, and an ambiguous round
 * must not be reported as evidence.
 */
export function pageRoundAttachments(prompt) {
  const scope =
    document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') || document.body;
  if (!scope) return null;

  /**
   * Read a user bubble's own words, ignoring whatever its media contributes.
   *
   * Two decorations have to go, and both were live bugs:
   *
   * 1. **The speaker label.** The shell renders `你：\n\n<message>`, so an exact
   *    comparison never matched and every A18/A19 evidence line came back
   *    undefined.
   * 2. **The attachments' text.** `innerText` of a bubble that carries an image
   *    includes that image's file name (or its alt text), so even after the label
   *    was handled the text still did not equal the prompt. Only the descendant
   *    text nodes that are *not* inside an attachment presentation node count.
   *
   * Inlined rather than shared because this function is shipped into the page as
   * its own source: a reference to a module-level helper would arrive in the
   * browser undefined. `_check-pagefns` asserts no page function calls another.
   */
  const ownText = (bubble) => {
    const parts = [];
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Skip anything inside a rendered attachment: that text is the file's,
        // not the user's.
        if (node.parentElement?.closest('[data-testid^="hatch-chat-attachment-presentation-"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      parts.push(node.nodeValue || "");
    }
    // Collapse whitespace FIRST, then strip the label: after `join(" ")` the
    // text starts with the indentation of the bubble's markup, so an anchored
    // `^你：` never matched and every evidence lookup returned undefined.
    return parts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:你|您|我|You|you)\s*[:：]\s*/, "")
      .trim();
  };

  const nodes = [...scope.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]')];
  const users = nodes.filter((node) => /chat-user-bubble/.test(node.className || ""));
  const wanted = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (wanted === "") return null;
  const matches = users.filter((node) => ownText(node) === wanted);
  if (matches.length === 0) return null;

  /**
   * The last match, not "the only one".
   *
   * This used to require exactly one, which meant a second message with the same prompt — a retry, or a
   * deliberate resend — made the lookup return nothing, so the attachment evidence for that round was never
   * found and the task could not confirm its own upload. The last match is the most recent round, which is
   * the one the current task just created; earlier identical prompts belong to earlier tasks.
   */
  const bubble = matches[matches.length - 1];

  /**
   * Count attachments in the bubble **and in its message container**.
   *
   * Measured on the live shell: for a two-image message the thumbnails live in
   * the outer `group/msg … flex-col ms-auto items-end` wrapper, *beside* the
   * bubble — the bubble itself contains none. Counting only inside the bubble
   * therefore reported `attachmentCount: 0` for a message that visibly carried
   * two named images (`red-square.png`, `blue-circle.png`), which is precisely the
   * evidence A18/A19 is supposed to provide.
   *
   * So the walk goes outward to the nearest message container and counts there.
   * A container is recognised structurally (the `group/msg` marker the shell
   * uses) rather than by a fixed depth, because the nesting differs between
   * message kinds. The count stays attributed: it comes from *this round's*
   * container, found by the prompt match, never from the thread at large.
   */
  const containerOf = (node) => {
    for (let parent = node.parentElement; parent !== null && parent !== scope; parent = parent.parentElement) {
      if (/group\/msg/.test(parent.className || "")) return parent;
    }
    return node;
  };
  const container = containerOf(bubble);

  const collect = (root) => {
    const found = [...root.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]')];
    // Named thumbnails the shell renders without a presentation testid: an `img`
    // inside the message container whose `alt` is a file name is an upload, not
    // the model's output (`output` nodes carry no alt and live elsewhere).
    const namedImages = [...root.querySelectorAll("img[alt]")].filter((img) => {
      const alt = (img.getAttribute("alt") || "").trim();
      return alt !== "" && /\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(alt);
    });
    return { nodes: found, namedImages };
  };

  const inBubble = collect(bubble);
  const inContainer = container === bubble ? { nodes: [], namedImages: [] } : collect(container);

  /**
   * Count each node once.
   *
   * The container encloses the bubble, so a thumbnail rendered *inside* the bubble is found by
   * both `collect` calls. Merging the two lists without deduplication therefore reported one
   * image as two, and the attachment check then cited evidence that did not exist — a single
   * reference image would look like two confirmed uploads.
   *
   * `Set` identity is enough: these are live DOM nodes, and the same element reached by two
   * different `querySelectorAll` calls is the same object.
   */
  const unique = (list) => [...new Set(list)];

  // Prefer the presentation nodes when present; otherwise fall back to the named
  // thumbnails, which is the shape the live double-image message actually has.
  const attachments =
    inBubble.nodes.length + inContainer.nodes.length > 0
      ? unique([...inBubble.nodes, ...inContainer.nodes])
      : inContainer.namedImages.length > 0
        ? unique(inContainer.namedImages)
        : unique(inBubble.namedImages);

  const kinds = attachments.map((node) => {
    const testId = (node.getAttribute("data-testid") || "").toLowerCase();
    const alt = (node.getAttribute("alt") || "").toLowerCase();
    if (node.querySelector?.("video") || testId.includes("video") || /\.(mp4|mov|webm)$/.test(alt)) {
      return "video";
    }
    if (node.querySelector?.("img") || node.tagName === "IMG" || testId.includes("image")) return "image";
    return "other";
  });
  return {
    count: attachments.length,
    kinds,
    /** True when the count came from named thumbnails rather than presentation nodes. */
    viaNamedThumbnails: attachments.length > 0 && inBubble.nodes.length + inContainer.nodes.length === 0,
    containerFound: container !== bubble,
  };
}

/** Type the prompt into the composer so React sees it as user input. */
function pageSetPrompt(prompt) {
  const textarea = [...document.querySelectorAll("textarea")].find((node) => {
    return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  });
  if (!textarea) return { ok: false, reason: "no-composer" };
  textarea.scrollIntoView({ block: "center", inline: "nearest" });
  textarea.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, prompt);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, length: (textarea.value || "").length };
}

/**
 * Locate the composer's send button.
 *
 * Same reasoning as the reference: an empty composer may not render Send at
 * all, so its presence is evidence the React state actually took the text. The
 * search walks up from the textarea and stops at the form/main boundary, which
 * keeps a history row that happens to say "Send" from being clicked.
 */
function pageSendButton() {
  function visible(node) {
    return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  }
  const focused = document.activeElement;
  let textarea = focused && focused.matches && focused.matches("textarea") && visible(focused) ? focused : undefined;
  if (textarea === undefined) textarea = [...document.querySelectorAll("textarea")].find(visible);
  if (textarea === undefined) return { state: "no-composer" };
  const label = /^(?:send(?:\s+message)?|发送(?:消息)?|發送(?:訊息)?|傳送(?:訊息)?|送出)$/i;
  const testId = /^(?:hatch-composer-send-button|composer-send-button|send-button)$/i;
  function isSend(node) {
    if (!visible(node)) return false;
    if (
      node.closest(
        'aside,nav,[role="navigation"],div[class*="chat-user-bubble"],div[class*="hatch-chat-groupable-bubble"]',
      )
    ) {
      return false;
    }
    return (
      label.test((node.getAttribute("aria-label") || "").trim()) ||
      testId.test((node.getAttribute("data-testid") || "").trim()) ||
      label.test((node.innerText || "").trim())
    );
  }
  // Walk up to and INCLUDING the body: a composer that is a direct child of
  // body (a stripped-down page, an older shell) must still be searched, and the
  // `isSend` filter is what keeps unrelated "Send" text out, not the stopping
  // point of the walk.
  for (let root = textarea.parentElement; root; root = root.parentElement) {
    const button = [...root.querySelectorAll('button,[role="button"]')].find(isSend);
    if (button) {
      const disabled =
        button.disabled ||
        button.matches(":disabled") ||
        button.getAttribute("aria-disabled") === "true" ||
        Boolean(button.closest("[inert]"));
      return { state: disabled ? "disabled" : "ready" };
    }
    if (root === document.body) break;
    if (root.matches('form,main,[role="main"]')) {
      // A form/main boundary normally ends the composer; keep going only when
      // nothing was found there, so a page that nests the composer oddly still
      // resolves.
      continue;
    }
  }
  return { state: "no-button" };
}

/** Click the composer's send button (never types, never re-clicks). */
function pageClickSend() {
  function visible(node) {
    return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  }
  const textarea = [...document.querySelectorAll("textarea")].find(visible);
  if (textarea === undefined) return "no-composer";
  const label = /^(?:send(?:\s+message)?|发送(?:消息)?|發送(?:訊息)?|傳送(?:訊息)?|送出)$/i;
  const testId = /^(?:hatch-composer-send-button|composer-send-button|send-button)$/i;
  for (let root = textarea.parentElement; root; root = root.parentElement) {
    const button = [...root.querySelectorAll('button,[role="button"]')].find((node) => {
      if (!visible(node)) return false;
      if (
        node.closest(
          'aside,nav,[role="navigation"],div[class*="chat-user-bubble"],div[class*="hatch-chat-groupable-bubble"]',
        )
      ) {
        return false;
      }
      return (
        label.test((node.getAttribute("aria-label") || "").trim()) ||
        testId.test((node.getAttribute("data-testid") || "").trim()) ||
        label.test((node.innerText || "").trim())
      );
    });
    if (button) {
      const disabled =
        button.disabled ||
        button.matches(":disabled") ||
        button.getAttribute("aria-disabled") === "true" ||
        Boolean(button.closest("[inert]"));
      if (disabled) return "disabled";
      button.click();
      return "clicked";
    }
    if (root === document.body) break;
  }
  return "no-button";
}

/**
 * Find the composer's upload control.
 *
 * The reference implementation learned that the composer container is the
 * second ancestor of the textarea in the current shell, with a legacy
 * placeholder-overlay path for older builds. Both shapes are tried, and the
 * input is only accepted when it lives inside one of those roots.
 */
function pageFileInput() {
  const overlay = document.querySelector('[data-testid="hatch-composer-placeholder-overlay"]');
  const legacy = overlay ? overlay.closest("form") || overlay.parentElement?.parentElement?.parentElement : null;
  const roots = [];
  if (legacy) roots.push(legacy);
  else {
    const textarea = document.querySelector("textarea");
    if (!textarea) return null;
    const form = textarea.closest("form");
    if (form) roots.push(form);
    else {
      let node = textarea.parentElement;
      for (let depth = 0; depth < 4 && node && node !== document.body; depth += 1) {
        roots.push(node);
        node = node.parentElement;
      }
    }
  }
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  return inputs.find((input) => roots.some((root) => root.contains(input))) || null;
}

/** Clear composer attachments and reset any file input value. */
function pageClearAttachments() {
  const rx = /remove\s*attachment|移除附件|刪除附件|删除附件/i;
  const bubble = '[class*=chat-user-bubble], div[class*="hatch-chat-groupable-bubble"]';
  const buttons = [...document.querySelectorAll("button[aria-label]")].filter(
    (button) => rx.test(button.getAttribute("aria-label") || "") && !button.closest(bubble),
  );
  for (const button of buttons) button.click();
  for (const input of document.querySelectorAll('input[type="file"]')) input.value = "";
  return buttons.length;
}

/**
 * Open Settings → Settings and read the usage dialog.
 *
 * Muse renders the entry as a "more" dock button or a labelled button, the item
 * as a menuitem whose text may carry a keyboard-shortcut suffix, and the panel
 * as a dialog. All three are located by role/label rather than by class names,
 * because class names are what changed last time.
 */
function pageQuotaSteps(step) {
  function visible(node) {
    return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  }
  const labels = ["Settings", "設定", "设置", "設定"];
  const centre = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  };
  if (step === "entry") {
    const button =
      [...document.querySelectorAll('[data-testid="hatch-dock-more"]')].find(visible) ||
      [...document.querySelectorAll('button,[role="button"]')].find(
        (node) => visible(node) && labels.includes((node.getAttribute("aria-label") || "").trim()),
      );
    return button ? centre(button) : null;
  }
  if (step === "item") {
    const exact = (node) => labels.includes((node.textContent || "").trim());
    const item =
      [...document.querySelectorAll("[role=menuitem]")].find(
        (node) => visible(node) && (exact(node) || [...node.querySelectorAll("span,div")].some(exact)),
      ) ||
      [...document.querySelectorAll("[role=menu] button,[role=menu] span,[role=menu] div")].find(
        (node) => visible(node) && exact(node),
      );
    return item ? centre(item) : null;
  }
  if (step === "dialog") {
    const dialog = [...document.querySelectorAll("[role=dialog],[aria-modal=true]")].find(visible);
    return dialog ? dialog.innerText || "" : "";
  }
  return null;
}

/**
 * Fetch one media source inside the page and cache it for chunked reads.
 *
 * The page already has the bytes: the attachment's `src` is a same-origin URL
 * or a `blob:` handle the renderer owns. Fetching there avoids re-playing the
 * signed-in session from Node, and chunking avoids one multi-megabyte CDP frame
 * for a video.
 */
async function pageMediaFetch(src) {
  try {
    if (!src) return { ok: false, error: "no-src" };
    const response = await fetch(src);
    if (!response.ok) return { ok: false, error: `http-${response.status}` };
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    const cache = (window.__museMediaCache = window.__museMediaCache || {});
    cache.current = btoa(binary);
    return { ok: true, mime: blob.type || "", size: blob.size, url: src, length: cache.current.length };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Read one chunk of the cached media base64. */
function pageMediaChunk(offset, length) {
  const cache = window.__museMediaCache;
  if (!cache || typeof cache.current !== "string") return null;
  return cache.current.slice(offset, offset + length);
}

/** Drop the cache once the bytes are out of the page. */
function pageMediaClear() {
  try {
    delete window.__museMediaCache;
  } catch {
    window.__museMediaCache = undefined;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Node-side API                                                       */
/* ------------------------------------------------------------------ */

/**
 * Thin wrapper over one attached page.
 *
 * Constructed per task; holds no cross-task state so a crashed browser cannot
 * leave a half-configured automation object behind.
 */
export class MusePage {
  #page;
  #log;

  constructor(page, log = () => {}) {
    this.#page = page;
    this.#log = log;
  }

  get raw() {
    return this.#page;
  }

  get closed() {
    return this.#page.closed;
  }

  /** Why the page stopped answering, when the transport knows. */
  get closeReason() {
    return this.#page.closeReason;
  }

  /** Run one page function with JSON arguments and get its value back. */
  async call(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    try {
      return await this.#page.js(expression);
    } catch (error) {
      if (error instanceof CdpError && (error.code === "CDP_CLOSED" || error.code === "CDP_TIMEOUT")) {
        throw new MuseFailure(
          `页面已不可用（${error.message}）。`,
          { code: error.code, kind: FAILURE.SHARED, stage: "page" },
        );
      }
      throw new MuseFailure(
        `页面脚本出错：${error instanceof Error ? error.message : String(error)}`,
        { code: "PAGE_SCRIPT", kind: FAILURE.SHARED, stage: "page" },
      );
    }
  }

  /** Navigate to the fresh thread and wait for the shell to be ready. */
  async openThread({ timeoutMs = 45_000 } = {}) {
    try {
      await this.#page.navigate(THREAD_URL, { timeoutMs: 20_000 });
    } catch (error) {
      if (error instanceof CdpError && error.code === "CDP_CLOSED") {
        throw new MuseFailure("浏览器在打开页面时关闭了。", {
          code: "CDP_CLOSED",
          kind: FAILURE.SHARED,
          stage: "navigate",
        });
      }
      // A load event that never arrives is not fatal on its own: a slow shell
      // still advertises readiness through the composer, so the ready loop is
      // the authority below.
    }
    const state = await this.waitReady({ timeoutMs });
    if (state === "ready") return;
    throw new MuseFailure(describeReadyState(state), {
      code: `PAGE_${state.toUpperCase()}`,
      kind: state === "signed-out" ? FAILURE.SIGNED_OUT : FAILURE.SHARED,
      stage: "navigate",
    });
  }

  /** Poll until the shell reports ready, reporting the last observed state. */
  async waitReady({ timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = "unknown";
    for (;;) {
      last = await this.call(pageReady);
      if (last === "ready") return "ready";
      if (last === "no-composer") {
        // A sign-in wall has no composer either; tell them apart before blaming
        // the page, because the two need different handling (A7).
        const snapshot = await this.call(pageSnapshot);
        if (looksLikeSignInWall(snapshot.tail)) return "signed-out";
      }
      if (Date.now() > deadline) return last;
      await delay(250);
    }
  }

  /** The authenticated session check. See `pageSessionCheck`. */
  async checkSession() {
    const result = await this.call(pageSessionCheck);
    return {
      ...result,
      verdict:
        result.httpStatus === 401
          ? "signed-out"
          : result.ok && result.httpStatus >= 200 && result.httpStatus < 300
            ? "signed-in"
            : "unknown",
    };
  }

  snapshot() {
    return this.call(pageSnapshot);
  }

  /** Replace the composer text. Returns the length React accepted. */
  async setPrompt(prompt) {
    const result = await this.call(pageSetPrompt, prompt);
    if (!result?.ok) {
      throw new MuseFailure(`找不到聊天输入框（${result?.reason ?? "unknown"}）。`, {
        code: "NO_COMPOSER",
        kind: FAILURE.SHARED,
        stage: "composer",
      });
    }
    // The send button only renders once React holds text; that is the proof the
    // setter took, not the DOM property we just wrote ourselves.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const button = await this.call(pageSendButton);
      if (button?.state === "ready" || button?.state === "disabled") {
        return { length: result.length, button: button.state };
      }
      if (Date.now() > deadline) return { length: result.length, button: button?.state ?? "unknown" };
      await delay(120);
    }
  }

  /** Clear composer attachments, optionally after navigating to a fresh thread. */
  async clearComposer({ fresh = false } = {}) {
    if (fresh) {
      try {
        await this.#page.navigate(THREAD_URL, { timeoutMs: 20_000 });
        await this.waitReady({ timeoutMs: 25_000 });
      } catch {
        /* a failed reset is reported by the attach step that follows */
      }
    }
    return this.call(pageClearAttachments);
  }

  /**
   * Attach local files and prove they landed.
   *
   * `DOM.setFileInputFiles` is used because it hands Chrome a real file from
   * disk — no base64 round-trip through the page for a large image. The
   * remove-button count is the readiness signal; it proves the attachment
   * reached the composer, and the caller must treat "fewer than expected" as a
   * hard stop rather than sending with a partial reference set (A18).
   */
  async attachFiles(paths, { timeoutMs = 90_000, expected = paths.length } = {}) {
    if (paths.length === 0) return { attached: 0 };
    await this.call(pageClearAttachments);
    await delay(300);

    for (const path of paths) {
      const handle = await this.#page.send("Runtime.evaluate", {
        expression: `(${pageFileInput.toString()})()`,
        returnByValue: false,
      });
      const objectId = handle?.result?.objectId;
      if (objectId === undefined) {
        throw new MuseFailure("找不到上传控件，已停止（不会在没有参考图的情况下提交）。", {
          code: "NO_UPLOAD_INPUT",
          kind: FAILURE.ATTACHMENT_INCOMPLETE,
          stage: "attach",
        });
      }
      try {
        await this.#page.send(
          "DOM.setFileInputFiles",
          { files: [path], objectId },
          { timeoutMs: 60_000 },
        );
      } catch (error) {
        throw new MuseFailure(
          `把文件交给上传控件失败：${error instanceof Error ? error.message : String(error)}`,
          { code: "UPLOAD_FAILED", kind: FAILURE.ATTACHMENT_INCOMPLETE, stage: "attach" },
        );
      }
      // One file per input assignment: the shell replaces the input's file list
      // on each change, so assigning a batch would upload only the last entry.
      await delay(400);
    }

    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      const snapshot = await this.snapshot();
      seen = snapshot.composer.attachments;
      if (seen >= expected) return { attached: seen };
      if (Date.now() > deadline) break;
      await delay(300);
    }
    throw new MuseFailure(
      `参考素材上传未确认（${seen}/${expected}），已停止（没有提交）。`,
      { code: "ATTACHMENT_INCOMPLETE", kind: FAILURE.ATTACHMENT_INCOMPLETE, stage: "attach" },
    );
  }

  /**
   * Fire the one send action this account gets.
   *
   * A click is preferred; Enter is used only when no usable button exists, and
   * never after a click already went out. `action` in the result is what the
   * journal records, so "one action" is auditable after the fact.
   *
   * **A lost reply is not a lost action.** The click is dispatched over CDP and
   * then its result has to come back; if the connection dies in between, the
   * click may already have reached the page and the composer may already have
   * submitted. Throwing there let the caller journal `failed`, and a user who
   * reads "failed" resubmits — while upstream may have taken the request. So a
   * transport failure during the click is reported as `fired: true` with
   * `unconfirmed: true`, and the caller lands on `unknown`, which is exactly what
   * G5 and A16 ask for.
   *
   * A failure *before* any action was dispatched stays a hard stop: nothing was
   * sent, so there is nothing to be uncertain about.
   */
  async sendOnce({ deadlineAt } = {}) {
    let clicked;
    try {
      clicked = await this.call(pageClickSend);
    } catch (error) {
      // The evaluate may or may not have reached the page. Treat it as fired and
      // let the delivery window decide; refusing to report it would claim
      // knowledge the plugin does not have.
      return {
        action: "click",
        fired: true,
        unconfirmed: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (clicked === "clicked") return { action: "click", fired: true };
    if (clicked === "disabled") {
      /**
       * Wait for the button to enable — but never past the caller's deadline.
       *
       * A disabled button means React has not accepted the text yet, and pressing Enter on a
       * not-yet-committed composer would lose the send, so waiting is right. Waiting *blindly*
       * for two seconds is not: a probe that reached this point at t=59.95s could click at
       * t=60.10s and then report a timeout for a message it had already sent.
       *
       * `deadlineAt` is the caller's own stop instant on the same clock. When the budget runs
       * out here, the answer is "did not fire" — the caller wanted no send after that instant.
       */
      const ownDeadline = Date.now() + 2_000;
      const latest = typeof deadlineAt === "number" ? Math.min(ownDeadline, deadlineAt) : ownDeadline;
      while (Date.now() < latest) {
        await delay(150);
        if (Date.now() >= latest) break;
        let retry;
        try {
          retry = await this.call(pageClickSend);
        } catch {
          // Same reasoning as above: a click attempt was already in flight.
          return { action: "click", fired: true, unconfirmed: true, reason: "click-reply-lost" };
        }
        if (retry === "clicked") {
          // A click that lands after the deadline still sent something; report it, because
          // denying it would be the wrong fact.
          if (typeof deadlineAt === "number" && Date.now() >= deadlineAt) {
            return { action: "click", fired: true, waited: true, late: true };
          }
          return { action: "click", fired: true, waited: true };
        }
      }
      return { action: "none", fired: false, reason: "send-disabled" };
    }
    /**
     * No button at all: dispatch exactly one Enter.
     *
     * The keydown **is** the send. Once that frame has been written to the socket
     * the page may have submitted, and a missing reply proves nothing about
     * whether it did. The earlier version treated a failed keydown as
     * `fired: false`, which the caller journaled as `failed / SEND_NOT_FIRED` — a
     * claim the plugin is not entitled to make, and the one outcome a user must
     * never see when a request may be upstream (A16).
     *
     * So the keydown is reported as `fired: true` unconditionally, with
     * `unconfirmed: true` when its reply did not arrive. The remaining keys
     * (char, keyUp) are best-effort: their absence cannot un-send anything.
     */
    let unconfirmedEnter = false;
    let enterReason;
    try {
      await this.#page.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } catch (error) {
      // The frame may have reached the page before the transport died.
      unconfirmedEnter = true;
      enterReason = error instanceof Error ? error.message : String(error);
    }
    try {
      await this.#page.send("Input.dispatchKeyEvent", {
        type: "char",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      });
      await this.#page.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } catch (error) {
      // The keydown already landed, so the submit may already have happened.
      unconfirmedEnter = true;
      enterReason ??= error instanceof Error ? error.message : String(error);
    }
    return unconfirmedEnter
      ? { action: "enter", fired: true, unconfirmed: true, reason: enterReason ?? "enter-reply-lost" }
      : { action: "enter", fired: true, reason: clicked };
  }

  /**
   * Wait for evidence that this round reached upstream.
   *
   * Evidence is any of: a new assistant bubble, changed assistant text, a new
   * attachment, or the Stop control appearing. Nothing weaker counts — the
   * composer still holding text and an empty composer are both consistent with
   * "sent" and "not sent", which is exactly why the goal forbids using either
   * one alone as proof.
   *
   * **A browser that dies here is not a failure.** Once the send action has
   * fired, the request may already be upstream; the honest report is "结果未知"
   * with the task and account named, which is what G5 asks for and what A16
   * checks. Throwing a shared fault instead would let the caller journal
   * `FAILED`, and a user reading "failed" would submit again — the exact
   * duplicate-charge the goal is built to prevent. So a closed page returns the
   * same shape as the timeout branch, tagged with where it happened.
   */
  async waitDelivery(baseline, { warnMs = 25_000, unknownMs = 60_000 } = {}) {
    const startedAt = Date.now();
    let warned = false;
    let last;
    for (;;) {
      if (this.closed) {
        return {
          evidence: undefined,
          at: Date.now() - startedAt,
          warned,
          snapshot: last,
          residue: last === undefined ? "" : residueOf(last),
          unknown: true,
          reason: `浏览器在等待送达时关闭（${this.closeReason ?? "连接中断"}）`,
        };
      }
      let snapshot;
      try {
        snapshot = await this.snapshot();
      } catch (error) {
        // A page that stops answering is the same situation as one that closed:
        // the request may have gone out, so this is an unknown outcome, not a
        // failure the caller may retry.
        return {
          evidence: undefined,
          at: Date.now() - startedAt,
          warned,
          snapshot: last,
          residue: last === undefined ? "" : residueOf(last),
          unknown: true,
          reason: `等待送达时页面读取失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      last = snapshot;
      const evidence = deliveryEvidence(baseline, last);
      if (evidence !== undefined) return { evidence, at: Date.now() - startedAt, snapshot: last };
      const elapsed = Date.now() - startedAt;
      if (elapsed >= unknownMs) {
        return {
          evidence: undefined,
          at: elapsed,
          warned,
          snapshot: last,
          residue: residueOf(last),
          unknown: true,
        };
      }
      if (!warned && elapsed >= warnMs) {
        warned = true;
        this.#log(
          `发送后 ${Math.round(elapsed / 1000)} 秒仍无本轮送达证据；输入框残留：${residueOf(last) || "无"}`,
        );
      }
      await delay(SAMPLE_MS);
    }
  }

  /**
   * Wait for this task's own media.
   *
   * A source counted before the send is a baseline; anything already present is
   * ignored, and an attachment whose bytes hash to one of the uploaded
   * references is skipped (Muse renders the upload as a preview, which is easy
   * to mistake for the result).
   *
   * **Quota attribution.** G5 is explicit that a quota verdict must come from
   * *this round's* assistant output: "用户提示词、历史消息或含义不明的 token
   * limit 只作诊断". So the scan runs over the assistant bubbles that appeared
   * after the baseline (`roundText`), never over the page tail — a prompt that
   * happens to contain the words "weekly limit", or a months-old thread message
   * still rendered above, would otherwise cool a perfectly healthy account and
   * send the next request to somebody else's quota.
   *
   * The page tail is still collected, but only as `diagnosticTail` on a failure,
   * which is what the goal asks for: it is evidence to show a human, not a
   * trigger.
   */
  async waitMedia(baseline, { kind, deadline, uploadHashes = new Set(), referenceSources = new Set() }) {
    const baselineSources = new Set([
      ...baseline.attachments.map((entry) => entry.video || entry.image).filter(Boolean),
      ...referenceSources,
    ]);
    const baselineAgentCount = baseline.agents.length;
    /**
     * How many times each source has been fetched.
     *
     * A source that exists but cannot be read yet is retried up to
     * `MAX_FETCH_ATTEMPTS` times before being written off. The count is per
     * source, so a genuinely unrelated node cannot monopolise the budget.
     */
    const fetchAttempts = new Map();
    let lastError;
    for (;;) {
      if (this.closed) {
        throw new MuseFailure("浏览器在等待生成结果时关闭了。", {
          code: "CDP_CLOSED",
          kind: FAILURE.SHARED,
          stage: "media",
        });
      }
      const snapshot = await this.snapshot();

      // Only this round's assistant output may attribute a quota stop.
      const roundText = snapshot.agents
        .slice(baselineAgentCount)
        .map((entry) => entry.text)
        .filter((entry) => entry !== "")
        .join("\n");
            /**
       * A refusal produces no media, so it must be recognised here rather than waited out.
       *
       * Muse accepts the prompt and then declines it in prose. Two causes are known:
       the content was refused on policy grounds (rephrasing can work), or the account's
       region has no video generation (nothing the user does to the prompt will help).
       Both used to surface as a timeout telling the user the task might still be running,
       which is the opposite of true.
       */
      const refusal = looksLikeRegionRefusal(roundText) ?? looksLikeContentRefusal(roundText);
      if (refusal !== undefined) {
        const isRegion = looksLikeRegionRefusal(roundText) !== undefined;
        throw new MuseFailure(
          isRegion
            ? `Muse 拒绝了这个任务：视频生成在你这个账号所在的地区不可用（后台返回 403）。` +
        `这个限制绑定在账号上，**换 IP、重试、改写提示词都不会恢复**——实测有账号因此两个月仍无法生成视频。` +
        `同一个账号的图片生成不受影响。要生视频需要换一个在支持地区（美国、加拿大、日本、新加坡）注册且使用时出口也在该地区的账号。` +
        `页面原文：${refusal}`
            : `Muse 拒绝了这个任务：提示词内容不符合它的内容政策（性暗示、暴力等）。改写描述后可以再试，重试原提示词不会成功。页面原文：${refusal}`,
          {
            code: isRegion ? "REGION_UNAVAILABLE" : "CONTENT_REFUSED",
            // Neither is a stop condition for the account: it may still work for other prompts,
            // so this must not mark the account unhealthy or trigger a switch.
            kind: FAILURE.INVALID,
            stage: "media",
            diagnosticTail: snapshot.tail.slice(-400),
          },
        );
      }
if (looksLikeQuotaText(roundText)) {
        const line = quotaLine(roundText);
        const rateLimited = looksLikeRateLimit(line ?? "");
        throw new MuseFailure(line ?? "本轮助手回复里出现了额度/限流提示。", {
          code: rateLimited ? "RATE_LIMITED" : "QUOTA_EXHAUSTED",
          kind: rateLimited ? FAILURE.RATE_LIMITED : FAILURE.QUOTA_EXHAUSTED,
          stage: "media",
          diagnosticTail: snapshot.tail.slice(-400),
          /**
           * A rate limit usually names its own recovery moment, and that moment
           * is not the weekly reset. Carrying it here is what lets the caller
           * schedule a re-check against the *limit that fired* instead of reading
           * the weekly panel later and mistaking a healthy percentage for a
           * recovery (A17).
           */
          retryAt: rateLimited ? parseRetryInstant(line ?? "") : undefined,
        });
      }
      const candidate = pickCandidate(snapshot, { kind, baselineSources });
      if (candidate !== undefined) {
        try {
          const media = await this.fetchMedia(candidate.source);
          if (media !== undefined) {
            const mediaKind = mediaKindOf(media.mime, candidate.source);
            if (mediaKind !== kind) {
              throw new MuseFailure(
                `期望${kind === "video" ? "视频" : "图片"}，但取回的是 ${mediaKind}（${media.mime || "未知类型"}）。`,
                { code: "WRONG_MEDIA_KIND", kind: FAILURE.SHARED, stage: "media" },
              );
            }
            if (mediaKind === "image" && uploadHashes.size > 0) {
              // Compare by size first (cheap) then by digest; a match means the
              // node is this task's own upload echoing back, not the result.
              if (uploadHashes.has(`size:${media.bytes.length}`)) {
                baselineSources.add(candidate.source);
                await delay(SAMPLE_MS);
                continue;
              }
            }
            return { ...media, kind: mediaKind, source: candidate.source, width: candidate.width, height: candidate.height };
          }
        } catch (error) {
          lastError = error;
          if (error instanceof MuseFailure && error.kind !== FAILURE.SHARED) throw error;
        }
        /**
         * A node that exists but is not readable *yet* must be retried.
         *
         * This is the normal state right after an attachment appears: the poster
         * still loads, the video's metadata is not parsed, the blob URL is
         * re-issued. The earlier code added the source to `baselineSources`, which
         * permanently excluded it — so a result whose first fetch failed was never
         * looked at again, even though a second attempt would have read it
         * (reproduced with a stub: four polls, one fetch attempt, then
         * MEDIA_TIMEOUT).
         *
         * Now each source gets a bounded number of attempts. Only after those are
         * exhausted is it treated as "not this task's result" and excluded, which
         * keeps the upload-echo guard intact without discarding a real result.
         */
        const attempts = (fetchAttempts.get(candidate.source) ?? 0) + 1;
        fetchAttempts.set(candidate.source, attempts);
        if (attempts >= MAX_FETCH_ATTEMPTS) baselineSources.add(candidate.source);
      }
      if (Date.now() > deadline) {
        /**
         * Quote the tail of the page.
         *
         * When every known recogniser misses, the user is still left with a timeout and no reason.
         * The last 200 characters of the page are the cheapest evidence: a region notice or a policy
         * sentence that this build does not yet match becomes visible instead of being swallowed.
         */
        const tail = (snapshot.tail || "").replace(/\s+/g, " ").trim().slice(-200);
        throw new MuseFailure(
          `等待生成结果超时（${lastError === undefined ? "没有出现新的成品" : lastError.message}）。` +
            `任务可能仍在上游运行，不要重复提交。` +
            (tail === "" ? "" : `页面末尾显示：${tail}`),
          { code: "MEDIA_TIMEOUT", kind: FAILURE.TIMEOUT, stage: "media", diagnosticTail: tail },
        );
      }
      await delay(SAMPLE_MS);
    }
  }

  /**
   * Read one media source out of the page, chunk by chunk.
   *
   * Returns `undefined` when the source cannot be fetched yet (a `blob:` URL
   * replaced by the renderer, a poster still loading) so the caller can retry
   * without treating it as a failure.
   */
  async fetchMedia(source, { timeoutMs = 120_000 } = {}) {
    const head = await this.call(pageMediaFetch, source);
    if (!head?.ok) {
      if (head?.error === "no-src") return undefined;
      return undefined;
    }
    const chunks = [];
    const CHUNK = 1 << 20;
    for (let offset = 0; offset < head.length; offset += CHUNK) {
      const piece = await this.call(pageMediaChunk, offset, CHUNK);
      if (typeof piece !== "string") {
        await this.call(pageMediaClear);
        return undefined;
      }
      chunks.push(piece);
    }
    await this.call(pageMediaClear);
    const bytes = Buffer.from(chunks.join(""), "base64");
    return { bytes, mime: head.mime || "", size: head.size };
  }

  /**
   * Count the attachments in this round's own user message (A18/A19 evidence).
   *
   * The round is located the same way the probe does it — by the exact user
   * bubble text — and only that bubble's attachment nodes are counted. A19
   * requires the *submitted* image to be visible in the round's message, not
   * merely "an upload happened", so this is the number to record and compare
   * against the number of files handed to the composer.
   */
  async roundUserAttachments(prompt) {
    const result = await this.call(pageRoundAttachments, prompt);
    return result ?? undefined;
  }

  /**
   * Read one account's usage panel.
   *
   * The panel is opened, read, and dismissed with Escape so a failed read
   * cannot leave a menu covering the composer for the next task. A plan label
   * without a percentage is not a successful read: the caller keeps the
   * previous value and greys it out (G2).
   */
  async readQuota({ timeoutMs = 45_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const clickAt = async (step, label) => {
      for (;;) {
        const point = await this.call(pageQuotaSteps, step);
        if (point !== null && point !== undefined && point !== "") return point;
        if (Date.now() > deadline) {
          throw new MuseFailure(`额度面板没打开：${label}。`, {
            code: "QUOTA_UI",
            kind: FAILURE.SHARED,
            stage: "quota",
          });
        }
        await delay(150);
      }
    };

    try {
      const entry = await clickAt("entry", "找不到设置入口");
      await this.#page.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: entry.x,
        y: entry.y,
        button: "left",
        clickCount: 1,
      });
      await this.#page.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: entry.x,
        y: entry.y,
        button: "left",
        clickCount: 1,
      });
      const item = await clickAt("item", "设置菜单没有出现可识别的条目");
      await this.#page.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: item.x,
        y: item.y,
        button: "left",
        clickCount: 1,
      });
      await this.#page.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: item.x,
        y: item.y,
        button: "left",
        clickCount: 1,
      });

      const readDeadline = Date.now() + 12_000;
      let parsed = { found: false };
      for (;;) {
        const text = await this.call(pageQuotaSteps, "dialog");
        parsed = parseQuota(text);
        if (parsed.found) return parsed;
        if (Date.now() >= readDeadline) {
          throw new MuseFailure("额度面板没有读到有效的已用百分比。", {
            code: "QUOTA_UNREADABLE",
            kind: FAILURE.SHARED,
            stage: "quota",
          });
        }
        await delay(250);
      }
    } finally {
      await dismissOverlays(this.#page).catch(() => {});
    }
  }
}

/** Close menus/dialogs a failed quota read may have left open. */
async function dismissOverlays(page) {
  for (let round = 0; round < 2; round += 1) {
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    await delay(120);
  }
}

/** Human-readable reason for a shell state that is not `ready`. */
export function describeReadyState(state) {
  switch (state) {
    case "loading":
      return "页面还在加载。";
    case "no-composer":
      return "页面没有渲染聊天输入框。";
    case "hydrating":
      return "页面还在初始化（hydrating）。";
    case "connecting":
      return "页面显示正在连接上游（Connecting...）。";
    case "input-disabled":
      return "聊天输入框处于禁用状态。";
    case "signed-out":
      return "页面显示登录入口，这个账号的会话已失效（证书由浏览器持有，请重新登录）。";
    default:
      return `页面没有进入就绪状态（${state}）。`;
  }
}

/** Detect evidence this round reached upstream, or `undefined`. */
function deliveryEvidence(baseline, current) {
  if (baseline.stop === false && current.stop === true) return "stop-visible";
  if (current.agents.length > baseline.agents.length) return "new-agent-bubble";
  const lastBaseline = baseline.agents.at(-1)?.text ?? "";
  const lastCurrent = current.agents.at(-1)?.text ?? "";
  if (lastCurrent !== lastBaseline && lastCurrent !== "") return "agent-text-changed";
  if (current.attachments.length > baseline.attachments.length) return "new-attachment";
  if (current.users.length > baseline.users.length) return "user-bubble";
  return undefined;
}

/** What the composer still holds, for the "尚未确认送达" diagnostic. */
function residueOf(snapshot) {
  const parts = [];
  if (snapshot.composer.attachments > 0) parts.push(`${snapshot.composer.attachments} 个附件`);
  if (snapshot.composer.text.length > 0) parts.push(`${snapshot.composer.text.length} 字提示词`);
  return parts.join("、");
}

/** Pick the attachment node that could be this task's result. */
function pickCandidate(snapshot, { kind, baselineSources }) {
  const candidates = [];
  for (const entry of snapshot.attachments) {
    // An attachment inside a user bubble is an uploaded reference, never this
    // task's output, so it is excluded structurally rather than by hashing.
    if (entry.inUser === true) continue;
    const testId = entry.testId.toLowerCase();
    const looksVideo = entry.video !== "" || testId.includes("video");
    const source =
      kind === "video" ? entry.video || (isVideoFile(entry.image) ? entry.image : "") : entry.image || entry.video;
    if (source === "" || source === undefined) continue;
    if (baselineSources.has(source)) continue;
    const kindMatches = kind === "video" ? entry.video !== "" || isVideoFile(source) : !looksVideo || entry.image !== "";
    if (!kindMatches) continue;
    candidates.push({ source, width: entry.width, height: entry.height, testId });
  }
  return candidates.at(-1);
}

function isVideoFile(source) {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(source);
}

/** Classify fetched bytes. */
function mediaKindOf(mime, source) {
  const type = (mime || "").toLowerCase();
  if (type.startsWith("video/") || isVideoFile(source)) return "video";
  if (type.startsWith("image/")) return "image";
  return isVideoFile(source) ? "video" : "image";
}

/** The one line of page text that mentions quota or a limit. */
function quotaLine(text) {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (looksLikeQuotaText(line) && line.length <= 300) return line;
  }
  return undefined;
}

/**
 * Parse Muse's usage panel.
 *
 * Ported from the reference implementation, which already handled the English,
 * traditional and simplified Chinese spellings: the panel prints a plan line, a
 * "Weekly limit resets on <date>" line, and a "<n>% used" line, followed by an
 * "Additional tokens" block. Only the section between "Usage" and "Language" is
 * considered, so account/profile text above it cannot be mistaken for usage.
 */
/**
 * Parse Muse's usage panel.
 *
 * The panel has **two separate budgets**, and this function keeps them apart:
 *
 *   - the **free weekly allowance** — the percentage the composer readout shows;
 *   - an **extra allowance** ("额外的使用额度"), which never expires and has its own
 *     percentage and remaining-tokens line.
 *
 * The user-facing question "is 已用 the weekly figure or the total?" has one
 * answer: it is the weekly figure. `scope` states that in the returned value so
 * no caller has to remember it.
 *
 * Wording measured on the live panel (simplified Chinese):
 *
 *   使用情况 / 免费版 / 周限额重置时间:11月22日 / 已使用 24%
 *   额外的使用额度 / 从不过期 / 已使用 0%(剩余 10 亿个口令) / 升级
 *
 * The previous patterns were written from the English wording plus a guess:
 * `免费版` does not end in 计划/plan, `周限额` is not 上限/額度, and
 * `额外的使用额度` carries no tokens/代币 suffix. Only the percentage survived.
 */
export function parseQuota(rawText) {
  const text = String(rawText ?? "").normalize("NFKC");
  const all = text.split("\n").map((line) => line.trim()).filter(Boolean);

  // The panel is a settings dialog: start after the usage heading, stop before
  // whatever follows, so account text above cannot be read as usage.
  const start = all.findIndex((line) => /^(?:usage|用量|使用量|使用情况|使用情況)$/i.test(line));
  let lines = start >= 0 ? all.slice(start + 1) : all;
  const end = lines.findIndex((line) =>
    /^(?:language|语言|語言|升级|升級|退出|upgrade)$/i.test(line),
  );
  if (end >= 0) lines = lines.slice(0, end);

  const out = { found: false, raw: lines.slice(0, 40).join("\n") };

  /**
   * The plan name.
   *
   * English ends with "Plan" ("Free plan"); the Chinese panel prints a bare
   * `免费版` — no 计划 suffix, which is why the old pattern matched nothing.
   */
  for (const line of lines) {
    if (/^.{1,60}?(?:\s+plan|計劃|计划|方案)$/i.test(line)) {
      out.plan = line;
      break;
    }
    if (
      /^(?:免费版|免費版|免费计划|免費計劃|专业版|專業版|标准版|標準版|团队版|團隊版|企业版|企業版|free|pro|plus|team)$/i.test(
        line,
      )
    ) {
      out.plan = line;
      break;
    }
  }

  const joined = lines.join("\n");

  /**
   * The weekly reset.
   *
   * English: "Weekly limit resets on Nov 22".
   * Chinese (measured): `周限额重置时间:11月22日` — note 限额, not 上限/額度, and the
   * moment follows a colon rather than a preposition.
   */
  const reset =
    /Weekly limit resets? on\s*([^\n]+)/i.exec(joined) ??
    /(?:每(?:週|周|星期)|週|周)(?:限额|限額|上限|額度|额度)(?:重置|重設|恢复|恢復)(?:时间|時間|日期)?\s*[:：]?\s*([^\n]+)/.exec(
      joined,
    ) ??
    /(?:限额|限額|上限|額度|额度)(?:重置|重設)(?:时间|時間|日期)?\s*[:：]\s*([^\n]+)/.exec(joined);
  if (reset !== null) out.reset = reset[1].trim();

  /**
   * Where the extra allowance begins.
   *
   * Measured header: `额外的使用额度` — no tokens/代币 suffix. If this is not found,
   * the split fails and the extra allowance's percentage can be read as the
   * weekly one, which is exactly the confusion this function exists to prevent.
   */
  const extraAt = lines.findIndex((line) =>
    /^(?:(?:Additional|Extra)\s+(?:tokens|usage|allowance|credits)|(?:額外|额外)(?:的)?[^\n]{0,12}(?:使用額度|使用额度|額度|额度|符元|符記|代幣|代币|令牌|憑證|凭证|tokens))/i.test(
      line,
    ),
  );

  /** Read `<n>% used` in either word order. */
  const percentage = (line) => {
    let match = /(\d+(?:\.\d+)?)\s*%\s*(?:used\b|已(?:使)?用)/i.exec(line);
    if (match === null) match = /已(?:使)?用\s*(\d+(?:\.\d+)?)\s*%/.exec(line);
    if (match === null) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
    return value;
  };

  // The weekly percentage is the first one *before* the extra section — or the
  // first overall when the panel shows no extra allowance at all.
  const weeklyLines = extraAt >= 0 ? lines.slice(0, extraAt) : lines;
  for (const line of weeklyLines) {
    const value = percentage(line);
    if (value !== undefined) {
      out.usedPct = value;
      break;
    }
  }

  if (extraAt >= 0) {
    for (const line of lines.slice(extraAt)) {
      const value = percentage(line);
      if (value !== undefined) {
        out.extraUsedPct = value;
        const left = /[（(]([^）)]+)[）)]/.exec(line);
        if (left !== null) out.extraLeft = left[1].trim();
        break;
      }
    }
  }
  out.extraExpires = /Never expires|永不過期|永不过期|从不过期|從不過期/i.test(joined)
    ? "never"
    : undefined;

  out.found = out.usedPct !== undefined;
  /**
   * What `usedPct` measures, stated in the value itself.
   *
   * It is the **free weekly allowance**, not the two budgets combined; the extra
   * allowance is reported separately as `extraUsedPct` / `extraLeft`. Carrying the
   * label keeps that distinction visible to every consumer instead of relying on
   * a comment that a later edit can contradict.
   */
  out.scope = "weekly";
  return out;
}
