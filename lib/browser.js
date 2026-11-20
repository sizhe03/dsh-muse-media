/**
 * Browser lifecycle: where the profiles live, how Chrome is found, how one
 * account's browser is started, reused and reaped.
 *
 * Three rules decide the shape of this file.
 *
 * 1. **The plugin only ever launches its own browser.** It never attaches to a
 *    browser the user opened, and it never touches the daily profile: each
 *    account gets `<DSH_HOME>/muse-media/profiles/<accountId>/` and Chrome is
 *    pointed at it with `--user-data-dir`. Sign-in therefore persists per
 *    account without the plugin ever reading a cookie.
 *
 * 2. **The debug port stays on loopback.** `--remote-debugging-address` is
 *    pinned to 127.0.0.1, so no LAN peer can drive the automation socket.
 *
 * 3. **Exit cleanup is scoped.** Only PIDs this module spawned are killed;
 *    a browser that answers on a port yet was not spawned here is treated as
 *    foreign, and the launcher reports that instead of killing it.
 *
 * The module owns no policy beyond that: timeouts arrive from config, and the
 * caller decides when a browser may be headless.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { CdpConnection, attachPage, debugEndpoint, delay, browserLabel } from "./cdp.js";

/** Where the plugin keeps everything it owns under DSH_HOME. */
export const STATE_DIR_NAME = "muse-media";

/**
 * How long a profile-size reading is reused.
 *
 * The figure only drives a settings line; ten minutes is far more often than it
 * needs to be accurate, and the walk it replaces blocks the main thread.
 */
const PROFILE_SIZE_TTL_MS = 10 * 60_000;

/** Extra flags that make an automation window behave like a fresh, quiet one. */
const BASE_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--disable-sync",
  "--disable-extensions",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=1440,1600",
  "--remote-debugging-address=127.0.0.1",
];

/**
 * Flags that only make sense where the sandbox cannot work.
 *
 * GitHub's Linux runners execute jobs inside a container whose seccomp policy blocks the user namespaces
 * Chrome's sandbox needs; without `--no-sandbox` Chrome exits before opening the debugging port. Keeping the
 * sandbox everywhere else is deliberate — it is the main thing protecting a user's machine from a compromised
 * page, and this plugin points a browser at a third-party site.
 *
 * Detected from the environment rather than from `platform`, because a Linux desktop needs the sandbox too.
 */
const isContainer = (() => {
  if (process.platform !== "linux") return false;
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" || process.env.CONTAINER === "true") {
    return true;
  }
  /**
   * A plain Docker container sets none of those variables.
   *
   * `/.dockerenv` is created by Docker itself and exists in no other environment, so it identifies the case
   * without a hint from the caller. The alternative — requiring the user to set CONTAINER=true — means a Chrome
   * that dies at launch with no error, which is how this was discovered in the first place.
   */
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
})();

const CONTAINER_FLAGS = isContainer ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];


/** Candidate Chrome/Chromium/Edge locations, most preferred first. */
const CHROME_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
  ],
};

/**
 * Find a usable browser executable.
 *
 * An explicit `chromePath` wins and is validated, so a typo is reported
 * instead of silently falling back to a different install. Otherwise the
 * platform's well-known locations are tried in order.
 */
export function locateChrome(configured, platform = process.platform) {
  const explicit = typeof configured === "string" ? configured.trim() : "";
  if (explicit !== "") {
    if (existsSync(explicit)) return { path: explicit, source: "config" };
    return { path: undefined, source: "config", error: `配置里的 chromePath 不存在：${explicit}` };
  }
  const candidates = CHROME_CANDIDATES[platform] ?? CHROME_CANDIDATES.linux;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, source: "detected" };
  }
  return {
    path: undefined,
    source: "detected",
    error:
      "没有找到 Chrome / Chromium / Edge。装一个基于 Chromium 的浏览器，或在插件配置里写明 chromePath。",
  };
}

/** Whether a TCP port is free on loopback. */
function portFree(port) {
  return new Promise((resolveFree) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveFree(free);
    };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    socket.setTimeout(600, () => done(true));
  });
}

/**
 * Pick a loopback port for the debug socket.
 *
 * A fixed base plus a small scan keeps the number predictable in logs while
 * still surviving a leftover browser from a previous run. The chosen port is
 * recorded per account, so a second task for the same account finds the
 * browser it already started.
 */
async function pickPort(preferred) {
  const start = Number.isInteger(preferred) && preferred > 1024 ? preferred : 19_220;
  for (let offset = 0; offset < 40; offset += 1) {
    const port = start + offset;
    if (await portFree(port)) return port;
  }
  throw new Error("找不到可用的本机调试端口（已尝试 40 个）。");
}

/** Per-account directories and the bookkeeping file that lives beside them. */
export class MusePaths {
  constructor(home, stateDirName = STATE_DIR_NAME) {
    this.home = home;
    this.root = join(home, stateDirName);
    this.profiles = join(this.root, "profiles");
    this.stateFile = join(this.root, "state.json");
    this.tasksFile = join(this.root, "tasks.json");
    this.browserLog = join(this.root, "browser.log");
  }

  ensure() {
    mkdirSync(this.profiles, { recursive: true });
    return this;
  }

  /** One account's browser data directory. `accountId` is validated by the store. */
  profileDir(accountId) {
    return join(this.profiles, accountId);
  }

  /** Remove an account's whole browser data directory (sign-out + cleanup). */
  removeProfile(accountId) {
    const dir = this.profileDir(accountId);
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }


  /** Profile directory sizes (synchronous; kept for one-shot callers). */
  profileSizes() {
    const out = {};
    if (!existsSync(this.profiles)) return out;
    for (const entry of readdirSync(this.profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let total = 0;
      try {
        const stack = [join(this.profiles, entry.name)];
        while (stack.length > 0) {
          const current = stack.pop();
          for (const child of readdirSync(current, { withFileTypes: true })) {
            const childPath = join(current, child.name);
            if (child.isDirectory()) stack.push(childPath);
            else {
              try {
                total += statSync(childPath).size;
              } catch {
                /* a file that vanished mid-walk is not an error here */
              }
            }
          }
        }
      } catch {
        continue;
      }
      out[entry.name] = total;
    }
    return out;
  }
}

/** One running browser, as this module tracks it. */
class BrowserInstance {
  constructor({ accountId, pid, port, connection, profileDir, visible }) {
    this.accountId = accountId;
    this.pid = pid;
    this.port = port;
    this.connection = connection;
    this.profileDir = profileDir;
    this.visible = visible;
    this.startedAt = Date.now();
    this.lastUsedAt = Date.now();
    this.closing = false;
  }

  touch() {
    this.lastUsedAt = Date.now();
  }
}

/**
 * Owns every browser the plugin started.
 *
 * One browser per account, because the profile directory is the account. That
 * also gives the "one page operation at a time" rule from the goal a natural
 * home: `withPage` is the only way to reach a page, and the caller (the task
 * queue in `index.js`) already serialises access.
 */
export class MuseBrowser {
  #paths;
  #getConfig;
  #log;
  #browsers = new Map();
  #reaper;
  /** Cached profile sizes; see `profileSizesAsync`. */
  #profileSizesCache;
  #profileSizesInFlight;

  constructor({ paths, getConfig, log }) {
    this.#paths = paths;
    this.#getConfig = getConfig;
    this.#log = log ?? (() => {});
  }

  get paths() {
    return this.#paths;
  }

  /** Whether the account currently has a live browser this module owns. */
  isRunning(accountId) {
    const instance = this.#browsers.get(accountId);
    return instance !== undefined && !instance.connection.closed;
  }

  /** Running accounts, for the settings card. */
  runningAccounts() {
    const out = [];
    for (const [accountId, instance] of this.#browsers) {
      if (instance.connection.closed) continue;
      out.push({
        accountId,
        port: instance.port,
        visible: instance.visible,
        idleMs: Date.now() - instance.lastUsedAt,
      });
    }
    return out;
  }

  /**
   * Start (or reuse) one account's browser and attach to its page.
   *
   * `visible` forces a window: the first sign-in must be a real window the user
   * can type into, so the caller passes `visible: true` for it. After an account
   * is verified a task runs headless, because a generation is background work —
   * a window that appears on every image is an interruption with no information
   * in it.
   *
   * `reuseOnly` refuses to start anything. A background quota poll passes it: it
   * may read the page if a browser happens to be up, and must never be the reason
   * one appears.
   */
  async open(
    accountId,
    { visible = false, reuseOnly = false, background = false, url = "https://muse.ai/thread/new", timeoutMs = 45_000 } = {},
  ) {
    this.#paths.ensure();
    const existing = this.#browsers.get(accountId);
    if (existing !== undefined && !existing.connection.closed) {
      // Reusing a browser for maintenance must not extend its life either; see
      // `withPage`'s note on `background`.
      if (!background) existing.touch();
      const page = await attachPage(existing.connection);
      await this.#landOn(page, url);
      return { page, browser: existing, connection: existing.connection };
    }
    if (existing !== undefined) this.#browsers.delete(accountId);
    if (reuseOnly) {
      throw Object.assign(
        new Error("account has no running browser and this operation may not start one"),
        { code: "NO_WINDOW" },
      );
    }

    const config = this.#getConfig() ?? {};
    const located = locateChrome(config.chromePath);
    if (located.path === undefined) {
      throw Object.assign(new Error(located.error), { code: "NO_BROWSER" });
    }

    const profileDir = this.#paths.profileDir(accountId);
    mkdirSync(profileDir, { recursive: true });
    // A profile left locked by a crashed run would make Chrome exit at once.
    for (const lockName of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const lockPath = join(profileDir, lockName);
      try {
        rmSync(lockPath, { force: true, recursive: true });
      } catch {
        /* symlinked lock files are best-effort on Windows */
      }
    }

    const port = await pickPort(Number(config.debugPortBase) || 19_220);
    const args = [
      ...BASE_FLAGS,
      /**
       * `--disable-dev-shm-usage` rides along with `--no-sandbox`: containers give /dev/shm 64 MB by default,
       * which is not enough for a rendering page and shows up as a crash rather than a slow load.
       */
      ...CONTAINER_FLAGS,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${resolve(profileDir)}`,
      ...(visible ? [] : ["--headless=new", "--disable-gpu"]),
      // The start page is about:blank, not the target: navigation happens
      // through CDP after attach, so one code path (`#landOn`) owns "which URL
      // is this page on" for both a fresh browser and a reused one.
      "about:blank",
    ];

    const child = spawn(located.path, args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: !visible,
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});

    let exited;
    const exitPromise = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        exited = { code, signal };
        resolveExit(exited);
      });
    });

    let document;
    try {
      document = await Promise.race([
        debugEndpoint(port, { timeoutMs }),
        exitPromise.then(() => {
          throw Object.assign(
            new Error(
              `浏览器启动后立即退出（code=${exited?.code ?? "?"}）。常见原因：该 profile 已被另一个窗口占用，或 chromePath 指向的不是可执行浏览器。`,
            ),
            { code: "BROWSER_EXITED" },
          );
        }),
      ]);
    } catch (error) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      throw error;
    }

    const connection = await CdpConnection.connect(document.webSocketDebuggerUrl, { timeoutMs: 20_000 });
    const instance = new BrowserInstance({
      accountId,
      pid: child.pid,
      port,
      connection,
      profileDir,
      visible,
    });
    this.#browsers.set(accountId, instance);
    this.#log(`浏览器已启动：账号 ${accountId} · ${browserLabel(document)} · 端口 ${port} · ${visible ? "可见窗口" : "无头"}`);

    /**
     * Evict the least recently used browser once over the live ceiling.
     *
     * Nothing bounded this before: the map is keyed by account, so every account
     * that ran kept its browser until the idle reaper reached it — and switching
     * accounts mid-task does not close the previous one. Measured on this machine,
     * one headless Muse page is ten processes and about 900 MB, so five live
     * accounts is several gigabytes. On an 8 GB machine that is the difference
     * between working and swapping.
     *
     * Eviction is by `lastUsedAt`, which the idle reaper already maintains; the
     * account that just started is by definition the newest, so it is never the
     * one evicted.
     */
    void this.#enforceLiveLimit();

    // A window the user closes themselves must be forgotten, not reused.
    connection.on("Target.targetDestroyed", () => {});
    /**
     * Reap the process when the connection dies.
     *
     * Forgetting the instance is not enough: `close()` is the only caller of
     * `#kill`, and it starts by deleting the map entry — so a path that deletes
     * without killing leaves a Chrome process alive that the plugin can never see
     * again. `closeAll` walks the map, the idle reaper walks the map, and the
     * `child` handle is gone with the instance, so nothing can reach it. The
     * renderer that died is then replaced by a new browser next launch while the
     * old one keeps its half of a gigabyte.
     *
     * So this path kills too. It is the same teardown `close()` performs, minus
     * the map deletion (which is conditional, in case a newer instance already
     * took the slot).
     */
    const watch = setInterval(() => {
      if (!connection.closed) return;
      clearInterval(watch);
      if (this.#browsers.get(accountId) === instance) this.#browsers.delete(accountId);
      void this.#kill(instance, "连接断开，回收进程").catch(() => {});
    }, 2_000);
    watch.unref?.();

    const page = await attachPage(connection);
    await this.#landOn(page, url);
    return { page, browser: instance, connection };
  }

  /**
   * Put the attached page on `url`.
   *
   * Navigation lives here — not in `attachPage` — because the same page is
   * reused across tasks and only the caller knows where it should be. A page
   * already on the target origin is *not* reloaded: `openThread` navigates
   * itself when a fresh thread is required, and reloading would throw away a
   * signed-in SPA shell for no reason.
   */
  async #landOn(page, url) {
    if (url === undefined || url === "") return;
    let current;
    try {
      current = await page.js("location.href");
    } catch {
      current = undefined;
    }
    if (typeof current === "string" && current !== "" && current !== "about:blank") {
      try {
        const want = new URL(url);
        const have = new URL(current);
        if (want.origin === have.origin) return;
      } catch {
        /* an unparseable URL is navigated to anyway */
      }
    }
    await page.navigate(url, { timeoutMs: 45_000 });
  }

  /**
   * Open a URL in a visible window and leave it there for the user.
   *
   * Used by "Open sign-in window": the browser stays up, the page is left on
   * Muse, and nothing is awaited afterwards — the user finishes the flow.
   */
  async openVisible(accountId, url = "https://muse.ai/") {
    const { page, browser } = await this.open(accountId, { visible: true, url });
    browser.touch();
    return { port: browser.port, pid: browser.pid, page };
  }

  /**
   * Run one operation against a page.
   *
   * `background: true` keeps the operation from counting as *use*.
   *
   * `touch()` resets `lastUsedAt`, which is what the idle reaper compares against
   * `idleReapSeconds`. A background quota read that touched the instance therefore
   * refreshed the idle clock, and with `autoRefreshQuotaSeconds` (300 s) shorter
   * than `idleReapSeconds` (600 s), the reaper's deadline could never arrive — the
   * browser stayed up for as long as the Host ran, around a gigabyte of it, with
   * no window to explain why. Measured: still alive nineteen minutes after the
   * last generation under default settings.
   *
   * So maintenance work opens the page, reads, and leaves the idle clock alone.
   * The browser it used is then reaped on the original schedule instead of being
   * kept alive by the very timer that was supposed to be cheap.
   */
  async withPage(accountId, options, operation) {
    const { page, browser, connection } = await this.open(accountId, options);
    const background = options?.background === true;
    try {
      return await operation(page, connection);
    } finally {
      if (!background) browser.touch();
    }
  }

  /** Close one account's browser. */
  async close(accountId, { reason = "关闭" } = {}) {
    const instance = this.#browsers.get(accountId);
    if (instance === undefined) return false;
    this.#browsers.delete(accountId);
    await this.#kill(instance, reason);
    return true;
  }

  async #kill(instance, reason) {
    if (instance.closing) return;
    instance.closing = true;
    // `Browser.close` beheads every renderer, and on Windows the profile lock
    // is released a moment later. Waiting on the pid — not on a fixed sleep —
    // is what keeps a plugin unload from leaving an orphan the next launch then
    // has to fight for the same directory.
    const exited = instance.pid === undefined ? Promise.resolve(true) : this.#waitExit(instance.pid, 6_000);
    try {
      await instance.connection.send("Browser.close", {}, { timeoutMs: 3_000 });
    } catch {
      /* the socket dying is the normal outcome of Browser.close */
    }
    try {
      instance.connection.close();
    } catch {
      /* ignore */
    }
    const clean = await exited;
    if (!clean && instance.pid !== undefined && this.#pidAlive(instance.pid)) {
      try {
        process.kill(instance.pid);
      } catch {
        /* the process may have exited between the check and the signal */
      }
      await this.#waitExit(instance.pid, 3_000);
    }
    this.#log(`浏览器已关闭：账号 ${instance.accountId} · ${reason}`);
  }

  /** Resolve true once `pid` is gone, or false when the budget runs out. */
  async #waitExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.#pidAlive(pid)) return true;
      if (Date.now() > deadline) return false;
      await delay(120);
    }
  }

  #pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Profile directory sizes, for the settings card's disk line.
   *
   * Cached, and that is the point. This walk is `readdir` + `stat` over every file
   * in every profile — measured at 608 ms for 2136 files — and it used to run
   * synchronously inside `snapshot()`, which the composer pill requests every 45
   * seconds. So the Host's main thread paid most of a second, repeatedly, for a
   * number the client did not even render.
   *
   * Two changes make that affordable: the result is cached for `PROFILE_SIZE_TTL_MS`
   * (the sizes only matter as a rough figure for a settings page), and the walk is
   * async so a slow scan cannot block the event loop.
   */
  async profileSizesAsync() {
    const now = Date.now();
    if (this.#profileSizesCache !== undefined && now - this.#profileSizesCache.at < PROFILE_SIZE_TTL_MS) {
      return this.#profileSizesCache.sizes;
    }
    if (this.#profileSizesInFlight !== undefined) return this.#profileSizesInFlight;

    this.#profileSizesInFlight = (async () => {
      const out = {};
      try {
        if (!existsSync(this.#paths.profiles)) return out;
        const { readdir, stat } = await import("node:fs/promises");
        const root = this.#paths.profiles;
        let entries;
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch {
          return out;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          let total = 0;
          try {
            const stack = [join(root, entry.name)];
            while (stack.length > 0) {
              const current = stack.pop();
              let children;
              try {
                children = await readdir(current, { withFileTypes: true });
              } catch {
                continue;
              }
              for (const child of children) {
                const childPath = join(current, child.name);
                if (child.isDirectory()) stack.push(childPath);
                else {
                  try {
                    total += (await stat(childPath)).size;
                  } catch {
                    /* a file that vanished mid-walk is not an error here */
                  }
                }
              }
            }
          } catch {
            continue;
          }
          out[entry.name] = total;
        }
      } finally {
        this.#profileSizesCache = { sizes: out, at: Date.now() };
        this.#profileSizesInFlight = undefined;
      }
      return out;
    })();

    return this.#profileSizesInFlight;
  }

  /** Last computed profile sizes without touching the disk. */
  cachedProfileSizes() {
    return this.#profileSizesCache?.sizes;
  }

  /**
   * Close the least recently used browsers while more than `maxLiveBrowsers` run.
   *
   * `maxLiveBrowsers: 0` disables the ceiling (the previous behaviour, unbounded).
   * A visible window is never evicted: it exists because a person is using it, and
   * closing it would look like the plugin refusing to cooperate.
   */
  async #enforceLiveLimit() {
    const config = this.#getConfig() ?? {};
    const limit = Number(config.maxLiveBrowsers);
    if (!Number.isFinite(limit) || limit <= 0) return;

    const live = [...this.#browsers.entries()].filter(([, instance]) => !instance.connection.closed);
    if (live.length <= limit) return;

    const candidates = live
      .filter(([, instance]) => instance.visible !== true)
      .filter(([, instance]) => instance.closing !== true)
      .sort((a, b) => (a[1].lastUsedAt ?? 0) - (b[1].lastUsedAt ?? 0));

    let excess = live.length - limit;
    for (const [accountId, instance] of candidates) {
      if (excess <= 0) break;
      this.#log(`同时运行的浏览器超过 ${limit} 个，回收最久未用的账号 ${accountId}`);
      await this.close(accountId, { reason: `超过 ${limit} 个上限` }).catch(() => {});
      void instance;
      excess -= 1;
    }
  }

  /** Close every browser this module started (plugin unload, DSH exit). */
  async closeAll(reason = "插件卸载") {
    const accounts = [...this.#browsers.keys()];
    await Promise.all(accounts.map((accountId) => this.close(accountId, { reason })));
    return accounts;
  }

  /**
   * Kill plugin browsers this process does not own.
   *
   * A Host that crashes or is force-quit never runs `closeAll`, so its Chrome
   * children survive. On the next launch the in-memory map is empty, so `open`
   * starts a *second* browser on the same profile (it also clears the singleton
   * locks, so Chrome permits it) and `pickPort` simply chooses another port. The
   * result is two processes, each around a gigabyte, on one profile — and the
   * older one is unreachable forever.
   *
   * The check is deliberately narrow: only processes whose `--user-data-dir`
   * points inside this plugin's profiles directory, and only when the pid is not
   * one this instance owns. Nothing else on the machine is touched.
   *
   * Best-effort by design: enumeration can fail (permissions, a non-Windows
   * platform), and a failure here must not stop the plugin from loading.
   */
  async reapOrphans() {
    if (process.platform !== "win32") return { killed: [], skipped: "unsupported-platform" };
    const profiles = resolve(this.#paths.profiles);
    const owned = new Set([...this.#browsers.values()].map((instance) => instance.pid).filter(Boolean));

    let listing;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      // A one-line PowerShell query rather than a WMI dependency: it is present
      // on every supported Windows and needs no extra module.
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | " +
            "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      const parsed = stdout.trim() === "" ? [] : JSON.parse(stdout);
      listing = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return { killed: [], skipped: "enumeration-failed" };
    }

    const killed = [];
    for (const row of listing) {
      const pid = Number(row?.ProcessId);
      const command = typeof row?.CommandLine === "string" ? row.CommandLine : "";
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (owned.has(pid)) continue;
      // Only the browser process carries `--user-data-dir`; children inherit the
      // switch in their command line too, so the pid check above plus this filter
      // covers both without killing an unrelated Chrome.
      if (!command.includes("--user-data-dir=")) continue;
      if (!command.toLowerCase().includes(profiles.toLowerCase())) continue;
      try {
        process.kill(pid);
        killed.push(pid);
      } catch {
        /* already gone */
      }
    }

    if (killed.length > 0) {
      this.#log(`已回收 ${killed.length} 个上次遗留的浏览器进程：${killed.join(", ")}`);
    }
    return { killed, skipped: undefined };
  }

  /**
   * Start the idle reaper.
   *
   * The interval is created once per plugin instance and disposed with it, so
   * unloading the plugin stops the timer instead of leaving it behind in the
   * Host process.
   */
  startIdleReaper() {
    if (this.#reaper !== undefined) return () => {};
    const tick = () => {
      const config = this.#getConfig() ?? {};
      const limit = Number(config.idleReapSeconds);
      if (!Number.isFinite(limit) || limit <= 0) return;
      const now = Date.now();
      for (const [accountId, instance] of [...this.#browsers]) {
        if (now - instance.lastUsedAt < limit * 1000) continue;
        void this.close(accountId, { reason: `空闲 ${Math.round((now - instance.lastUsedAt) / 1000)} 秒后回收` });
      }
    };
    const timer = setInterval(tick, 30_000);
    timer.unref?.();
    this.#reaper = timer;
    return () => {
      clearInterval(timer);
      this.#reaper = undefined;
    };
  }
}
