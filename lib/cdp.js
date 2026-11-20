/**
 * Minimal Chrome DevTools Protocol client on the Node runtime alone.
 *
 * Node 22+ ships a global `WebSocket`, so the plugin needs no `ws`, no
 * puppeteer and no `devtools-protocol` package. Everything here is the subset
 * the Muse page automation actually uses:
 *
 *   - `debugEndpoint()`  poll `http://127.0.0.1:<port>/json/version` until the
 *                        browser answers, then hand back its webSocketDebugger
 *                        URL (this is how a freshly spawned Chrome announces
 *                        that it is listening).
 *   - `connect()`        open the browser-level socket and turn it into a
 *                        request/response coroutine with a per-call timeout.
 *   - `attach()`         `Target.attachToTarget` with `flatten: true`, so page
 *                        commands travel as `sessionId`-tagged frames over the
 *                        one browser socket. One socket, N pages, no second
 *                        endpoint to leak.
 *
 * A page is then a thin object with `send`/`js`/`navigate`, plus the two event
 * helpers page automation needs (`once` for load, `on` for console noise).
 */

/** Request names that are never sent to the browser (kept for clarity). */
const BROWSER_LEVEL = new Set([
  "Target.createTarget",
  "Target.closeTarget",
  "Target.getTargets",
  "Target.attachToTarget",
  "Browser.close",
  "Browser.getVersion",
]);

class CdpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CdpError";
    this.code = code;
  }
}

/** Resolve after `ms`, used for CDP's own small settle delays. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read `http://127.0.0.1:<port>/json/version` once.
 *
 * Returns the parsed document, or `undefined` when the port is not listening
 * yet. A non-200 answer and a body that is not JSON both count as "not up":
 * Chrome prints a banner on stdout long before it opens the debug port, and a
 * half-started browser sometimes answers with an HTML error page.
 */
async function probeDebugPort(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    const document = JSON.parse(text);
    if (typeof document?.webSocketDebuggerUrl !== "string") return undefined;
    return document;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for a Chrome debug port to answer.
 *
 * The poll interval starts fast (a warm browser answers on the first try) and
 * backs off to a quarter second, because a cold start on a spinning disk can
 * take many seconds and a tight loop would burn the whole wait on syscalls.
 */
export async function debugEndpoint(port, { timeoutMs = 30_000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new CdpError("已取消等待浏览器调试端口。", "ABORTED");
    const document = await probeDebugPort(port);
    if (document !== undefined) return document;
    if (Date.now() > deadline) {
      throw new CdpError(
        `等待浏览器调试端口 127.0.0.1:${port} 超时（${Math.round(timeoutMs / 1000)} 秒）。`,
        "CDP_TIMEOUT",
      );
    }
    attempt += 1;
    await delay(attempt < 8 ? 120 : 250);
  }
}

/** One pending CDP request, keyed by its numeric id. */
class Pending {
  constructor(method) {
    this.method = method;
    this.settle = undefined;
    this.promise = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }
}

/**
 * A connection to one browser's debug socket.
 *
 * Frames are `{id, method, params, sessionId}`. Responses carry `id`; events
 * carry `method` and optionally `sessionId`. Listeners are registered per
 * (sessionId, method) with `on`, and one-shot waits with `once`.
 */
export class CdpConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;
  #closeReason = undefined;

  constructor(socket, url) {
    this.url = url;
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#onFrame(event.data));
    socket.addEventListener("close", () => this.#onClose("浏览器调试连接已关闭。"));
    socket.addEventListener("error", () => this.#onClose("浏览器调试连接出错。"));
  }

  /** Open a connection to a `webSocketDebuggerUrl`. */
  static async connect(url, { timeoutMs = 15_000 } = {}) {
    if (typeof WebSocket !== "function") {
      throw new CdpError(
        "当前 Node 运行时没有全局 WebSocket，无法连接浏览器调试端口。请使用 Node 22.19 及以上。",
        "NO_WEBSOCKET",
      );
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new CdpError("连接浏览器调试端口超时。", "CDP_TIMEOUT"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError("连接浏览器调试端口失败。", "CDP_UNREACHABLE"));
      });
    });
    return new CdpConnection(socket, url);
  }

  get closed() {
    return this.#closed;
  }

  get closeReason() {
    return this.#closeReason;
  }

  #onClose(reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const pending of this.#pending.values()) {
      pending.settle.reject(new CdpError(`${reason}（${pending.method} 未完成）`, "CDP_CLOSED"));
    }
    this.#pending.clear();
    for (const listeners of this.#listeners.values()) {
      for (const listener of listeners) listener.close?.(reason);
    }
    this.#listeners.clear();
  }

  #onFrame(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (typeof frame.id === "number") {
      const pending = this.#pending.get(frame.id);
      if (pending === undefined) return;
      this.#pending.delete(frame.id);
      if (frame.error !== undefined) {
        const message = frame.error?.message ?? "CDP 请求失败";
        const data_ = frame.error?.data;
        pending.settle.reject(
          new CdpError(
            `${pending.method}: ${message}${typeof data_ === "string" && data_ !== "" ? ` (${data_})` : ""}`,
            "CDP_ERROR",
          ),
        );
        return;
      }
      pending.settle.resolve(frame.result ?? {});
      return;
    }
    if (typeof frame.method !== "string") return;
    const key = `${frame.sessionId ?? ""}\u0000${frame.method}`;
    const listeners = this.#listeners.get(key);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener.callback(frame.params ?? {});
      } catch {
        /* a listener must never break the socket */
      }
      if (listener.once) this.#off(key, listener);
    }
  }

  #off(key, listener) {
    const listeners = this.#listeners.get(key);
    if (listeners === undefined) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.#listeners.delete(key);
  }

  /**
   * Send one CDP command and await its result.
   *
   * `sessionId` routes the command to an attached page; omitting it targets
   * the browser itself.
   */
  async send(method, params = {}, { sessionId, timeoutMs = 30_000 } = {}) {
    if (this.#closed) {
      throw new CdpError(this.#closeReason ?? "浏览器调试连接已关闭。", "CDP_CLOSED");
    }
    const id = this.#nextId++;
    const pending = new Pending(method);
    this.#pending.set(id, pending);
    const frame = { id, method, params };
    if (sessionId !== undefined) frame.sessionId = sessionId;
    try {
      this.#socket.send(JSON.stringify(frame));
    } catch (error) {
      this.#pending.delete(id);
      throw new CdpError(
        `发送 ${method} 到浏览器失败：${error instanceof Error ? error.message : String(error)}`,
        "CDP_SEND",
      );
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CdpError(
            `CDP ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）。`,
            "CDP_TIMEOUT",
          ),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([pending.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Subscribe to one event name; resolves to an unsubscribe function. */
  on(method, callback, { sessionId } = {}) {
    const key = `${sessionId ?? ""}\u0000${method}`;
    const listener = { callback, once: false };
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => this.#off(key, listener);
  }

  /** Wait for the next occurrence of one event, or the timeout. */
  once(method, { sessionId, timeoutMs = 15_000 } = {}) {
    const key = `${sessionId ?? ""}\u0000${method}`;
    return new Promise((resolve, reject) => {
      const listener = {
        once: true,
        callback: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
        close: (reason) => {
          clearTimeout(timer);
          reject(new CdpError(reason, "CDP_CLOSED"));
        },
      };
      const timer = setTimeout(() => {
        this.#off(key, listener);
        reject(new CdpError(`等待事件 ${method} 超时。`, "CDP_TIMEOUT"));
      }, timeoutMs);
      const listeners = this.#listeners.get(key) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(key, listeners);
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* ignore */
    }
    this.#onClose("浏览器调试连接已关闭。");
  }
}

/**
 * One attached page.
 *
 * Page automation only ever needs evaluate, navigate and load-wait, so those
 * are the whole surface; anything else goes through `send` with the session id
 * already applied.
 */
export class CdpPage {
  #connection;
  #sessionId;
  #closed = false;

  constructor(connection, sessionId, targetId) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.targetId = targetId;
  }

  get closed() {
    return this.#closed || this.#connection.closed;
  }

  get closeReason() {
    return this.#connection.closeReason;
  }

  send(method, params = {}, options = {}) {
    return this.#connection.send(method, params, { ...options, sessionId: this.#sessionId });
  }

  on(method, callback) {
    return this.#connection.on(method, callback, { sessionId: this.#sessionId });
  }

  once(method, options = {}) {
    return this.#connection.once(method, { ...options, sessionId: this.#sessionId });
  }

  /**
   * Evaluate one expression in the page and return its value.
   *
   * `awaitPromise` is on by default because several automation steps are
   * async (a media `fetch`, a `scrollIntoView` followed by a settle). A thrown
   * page exception is converted into the caller's error with the page's own
   * message, which is what makes "the selector changed" debuggable later.
   */
  async js(expression, { awaitPromise = true, timeoutMs = 30_000 } = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      { timeoutMs },
    );
    if (result?.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      const message =
        detail?.exception?.description ?? detail?.text ?? "页面脚本抛出异常";
      throw new CdpError(message, "PAGE_SCRIPT");
    }
    return result?.result?.value;
  }

  /** Navigate and wait for the load event (or the timeout). */
  async navigate(url, { timeoutMs = 30_000 } = {}) {
    const loaded = this.once("Page.loadEventFired", { timeoutMs }).catch(() => undefined);
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Release the CDP session; the tab itself stays open. */
  async detach() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#connection.send("Target.detachFromTarget", { sessionId: this.#sessionId });
    } catch {
      /* a browser that already went away is the expected case here */
    }
  }
}

/**
 * Attach to a page target, creating one only when the browser has none.
 *
 * Flattened sessions are the only mode used: one socket, no per-page endpoint,
 * and closing the browser socket tears every page down with it.
 *
 * An existing page tab is **reused** rather than added to. The plugin launches
 * its browser with a single blank tab, so "the page tab" is unambiguous, and
 * creating one per task would leave a visible window with a tab per generation
 * — the kind of leak a user only notices after a long session. `targetId`
 * pins an already-attached page when the caller tracks one.
 */
export async function attachPage(connection, { targetId, url = "about:blank" } = {}) {
  const targets = await connection.send("Target.getTargets");
  const pages = (targets?.targetInfos ?? []).filter((info) => info.type === "page");
  let chosen = targetId === undefined ? undefined : pages.find((info) => info.targetId === targetId);
  if (chosen === undefined) {
    chosen = pages.find((info) => info.url === "about:blank" || info.url === "") ?? pages[0];
  }
  if (chosen === undefined) {
    const created = await connection.send("Target.createTarget", { url });
    chosen = { targetId: created.targetId };
  }
  const attached = await connection.send("Target.attachToTarget", {
    targetId: chosen.targetId,
    flatten: true,
  });
  const page = new CdpPage(connection, attached.sessionId, chosen.targetId);
  try {
    await page.send("Page.enable");
  } catch {
    /* a target that vanished between attach and enable is handled by the caller */
  }
  try {
    await page.send("Runtime.enable");
  } catch {
    /* ignore */
  }
  return page;
}

/** The debug-port document's browser line, used for the version record. */
export function browserLabel(document) {
  const product = typeof document?.Browser === "string" ? document.Browser : "";
  return product === "" ? "Chrome/Chromium" : product;
}

export { CdpError };
