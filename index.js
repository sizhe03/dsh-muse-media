/**
 * Host half of `dsh-muse-media`.
 *
 * Three agent tools, four loopback-scoped routes, one single-flight queue, and
 * the G5 send boundary. Everything the plugin owns lives under
 * `<DSH_HOME>/muse-media/`: one browser profile per account, the account index,
 * the task journal and the generated media.
 *
 * The invariants this file exists to enforce:
 *
 *   - **One page operation at a time.** `#queue` serialises every task that
 *     touches a page, so a generation can never have its page navigated away
 *     underneath it (A20).
 *   - **One send action per task, persisted first.** The journal records
 *     "maybe sent" before the click and refuses to send when that write fails.
 *     It never retries and never falls back from click to Enter after a click.
 *   - **After a send, a lost page is an unknown outcome, not a failure.** G5
 *     says so explicitly, and A16 checks it: reporting `failed` would invite a
 *     resubmission and a second charge.
 *   - **Blame only what is provable.** A signed-out session may move a task to
 *     another account (that is the one exception G5 allows). A cooldown — quota
 *     exhaustion or a rate limit — *stops the task*. A shared fault changes
 *     nothing (A21).
 */

import {
  mkdirSync,
  createReadStream,
  statSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";

import { MuseBrowser, MusePaths, locateChrome } from "./lib/browser.js";
import { MusePage, THREAD_URL } from "./lib/muse.js";
import { AccountStore, TaskStore, ACCOUNT_STATUS, TASK_STATE } from "./lib/store.js";
import {
  FAILURE,
  MuseFailure,
  asFailure,
  cooldownPatch,
  eligibility,
  maySwitchAccount,
  accountAttemptLimit,
  parseResetInstant,
  rankAccounts,
  isReadingStale,
  resetOrdinal,
} from "./lib/pool.js";
import { mintCode, monotonicNow, probeMessage, runProbe } from "./lib/probe.js";

/** Routes owned by this plugin. */
const QUOTA_PATH = "/plugins/dsh-muse-media/quota";
/**
 * Media route.
 *
 * The registered prefix must have **no trailing slash**. The Host matches a
 * prefix route with `pathname === prefix || pathname.startsWith(prefix + "/")`,
 * so a registered value ending in `/` produces `…/media//<file>` and never
 * matches the request `…/media/<file>` — every playback URL answered 404 while
 * the account routes looked fine. The separator is added by the matcher, not by
 * us.
 */
const MEDIA_ROUTE = "/plugins/dsh-muse-media/media";
/** The URL prefix a delivered file is exposed under. */
const MEDIA_PREFIX = `${MEDIA_ROUTE}/`;
const ACCOUNTS_PATH = "/plugins/dsh-muse-media/accounts";
const ACCOUNTS_ACTION_PATH = "/plugins/dsh-muse-media/accounts/action";

/** Media kinds the plugin can deliver. */
const MEDIA_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** Defaults; `cordis.patch.yml` restates them so users can edit them. */
const DEFAULTS = {
  chromePath: "",
  /**
   * Generations run headless.
   *
   * Only the first sign-in opens a window, because only the first sign-in needs a
   * human in front of it. A window that pops up for every image is an
   * interruption that carries no information: the result arrives in the
   * conversation, which is where the user is looking. `login` still forces a
   * visible window — that path passes `visible: true` explicitly.
   */
  headlessAfterLogin: true,
  idleReapSeconds: 600,
  imageTimeoutSeconds: 300,
  videoTimeoutSeconds: 780,
  quotaTimeoutSeconds: 90,
  /** Background quota refresh cadence in seconds; 0 disables it. */
  autoRefreshQuotaSeconds: 300,
  maxAccountsPerTask: 2,
  /**
   * How many browsers may run at once; 0 means no ceiling.
   *
   * Two is chosen against the measured cost of one: a headless Muse page is ten
   * processes and roughly 900 MB on this machine, so the ceiling is what keeps a
   * multi-account install from needing gigabytes of RAM. A visible window is never
   * evicted.
   */
  maxLiveBrowsers: 2,
  deliveryWarnSeconds: 25,
  deliveryUnknownSeconds: 60,
  probeTimeoutSeconds: 60,
  showQuotaInComposer: true,
  debugPortBase: 19_220,
};

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * A number from a text field, clamped to a range, or `undefined` when unusable.
 *
 * A parse failure returns `undefined` rather than a default: a user who typed "abc"
 * into a timeout should keep the value they had, not silently receive a default that
 * they never chose.
 */
function clampInt(value, min, max) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const rounded = Math.round(number);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function resolveHome(config) {
  const fromConfig = nonEmpty(config?.homeDir);
  if (fromConfig !== undefined) return fromConfig;
  const fromEnv = nonEmpty(process.env.DSH_HOME);
  if (fromEnv !== undefined) return fromEnv;
  return join(homedir(), ".dsh");
}

/* ------------------------------------------------------------------ */
/* Request gates                                                       */
/* ------------------------------------------------------------------ */

function hostnameOf(host) {
  const raw = String(host ?? "").trim().toLowerCase();
  if (raw === "") return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return raw;
    const after = raw.slice(end + 1);
    if (after !== "" && !/^:\d+$/.test(after)) return raw;
    return raw.slice(0, end + 1);
  }
  const colon = raw.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(raw.slice(colon + 1))) return raw.slice(0, colon);
  return raw;
}

function isLoopbackHostname(name) {
  if (name === "localhost" || name === "[::1]" || name === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (match === null) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

function isIpLiteral(value) {
  const text = String(value ?? "").trim();
  if (text === "") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text.split(".").every((part) => Number(part) <= 255);
  return /^[0-9a-f:]+$/i.test(text) && text.includes(":");
}

function hostIsLoopback(host) {
  const name = hostnameOf(host);
  return name !== "" && isLoopbackHostname(name);
}

function hostIsLocal(host, localAddress) {
  const name = hostnameOf(host);
  if (name === "") return false;
  if (isLoopbackHostname(name)) return true;
  if (name === "0.0.0.0" || name === "[::]") return false;
  const local = String(localAddress ?? "").trim().toLowerCase();
  if (local === "") return false;
  const bare = (value) => (value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value);
  return bare(name) === bare(local);
}

function originIsLocal(origin, localAddress) {
  if (origin === undefined || String(origin).trim() === "") return true;
  try {
    const url = new URL(String(origin));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHostname(url.hostname) || hostIsLocal(url.hostname, localAddress);
  } catch {
    return false;
  }
}

/**
 * Whether a request may drive the settings card and the media route.
 *
 * Two checks, and the second is the load-bearing one on a deployment that binds
 * a concrete LAN address instead of loopback:
 *
 * 1. **Host names this machine** — loopback, or the address the socket was
 *    accepted on. This is what stops DNS rebinding: the attacker's page sends
 *    `Host: evil.example` while its socket lands here, and the name never
 *    matches.
 * 2. **The peer is this machine** — a browser on another machine reaching the
 *    same LAN listener reports its own address as the peer, so it is refused
 *    even though its Host is spelled correctly.
 *
 * This gate is deliberately broader than loopback because the Web GUI is
 * commonly opened at a LAN address. It is still not reachable from the network:
 * condition (2) refuses every peer that is not this machine.
 *
 * **The quota route does not use this gate.** A8 is literal — "本机回环请求正常
 * 返回；非回环请求返回 403" — so that route keeps its own strict check below, and
 * the composer pill reads its numbers from the account snapshot instead.
 */
function sameMachineRequest(req) {
  const localAddress = req.socket?.localAddress;
  if (!hostIsLocal(req.headers.host, localAddress)) return { ok: false, reason: "host not local" };
  if (!isSameMachine(req.socket?.remoteAddress, localAddress)) return { ok: false, reason: "peer not local" };
  if (!originIsLocal(req.headers.origin, localAddress)) return { ok: false, reason: "cross-origin refused" };
  return { ok: true };
}

/**
 * Whether a request arrived over the loopback interface itself.
 *
 * A8 verbatim, with no inference: the Host must name loopback, the connection
 * must have been accepted on a loopback address, and the peer must be loopback.
 * `localhost` and the whole 127/8 range count, which is how the harness's own
 * trust layer spells it.
 *
 * On a deployment that binds only a LAN address this route answers 403 to
 * everything, including a local browser. That is the spec's own answer, so the
 * pill does not depend on it — it reads `/accounts`.
 */
function loopbackRequest(req) {
  const localAddress = String(req.socket?.localAddress ?? "").trim();
  const remote = String(req.socket?.remoteAddress ?? "").trim();
  if (!hostIsLoopback(req.headers.host)) return { ok: false, reason: "loopback only" };
  const localLoop = isLoopbackHostname(localAddress) || localAddress === "::1";
  const peerLoop =
    isLoopbackHostname(remote) || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!localLoop || !peerLoop) return { ok: false, reason: "loopback only" };
  return { ok: true };
}

function isSameMachine(remote, local) {
  const peer = String(remote ?? "").trim();
  if (peer === "") return false;
  if (isLoopbackHostname(peer) || peer === "::1" || peer === "::ffff:127.0.0.1") return true;
  if (!isIpLiteral(peer)) return false;
  const bound = String(local ?? "").trim();
  if (bound === "") return false;
  const bare = (value) => (value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value);
  return bare(peer) === bare(bound);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("请求体过大。");
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** True when the thrown value means "the page is gone". */
function isBrowserGone(error) {
  const code = error?.code;
  return code === "CDP_CLOSED" || code === "BROWSER_EXITED" || code === "CDP_UNREACHABLE";
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

/** Everything one plugin instance owns. */
class MuseRuntime {
  #config;
  #log;
  #paths;
  #accounts;
  #tasks;
  #browser;
  #queue = Promise.resolve();
  #queueBusy = undefined;
  #quotaCache = new Map();
  #quotaInFlight = new Map();
  /**
   * Retry instants named by a rate limit, per account.
   *
   * Kept apart from the weekly quota cache on purpose: they answer a different
   * question ("when may this limited account be tried again") and must never be
   * satisfied by reading the weekly panel, which measures something else.
   */
  #rateLimitRetries = new Map();
  #attachments;
  /** Optional Host capability for persisting settings changes. */
  #configEditor;

  constructor({ getConfig, log }) {
    this.#config = getConfig;
    this.#log = log;
    const config = getConfig() ?? {};
    this.#paths = new MusePaths(resolveHome(config)).ensure();
    this.#accounts = new AccountStore(this.#paths.stateFile).load();
    this.#tasks = new TaskStore(this.#paths.tasksFile).load();
    this.#browser = new MuseBrowser({ paths: this.#paths, getConfig, log });
  }

  get accounts() {
    return this.#accounts;
  }

  get tasks() {
    return this.#tasks;
  }

  get browser() {
    return this.#browser;
  }

  get paths() {
    return this.#paths;
  }

  get log() {
    return this.#log;
  }

  setAttachments(service) {
    this.#attachments = service;
  }

  /**
   * Wire the config editor, so the settings page can change values.
   *
   * Fourteen keys were adjustable only by editing `cordis.patch.yml` and restarting.
   * The Host exposes `configEditor.edit(entry, change)`, which persists the change and
   * applies it through the normal Loader path — so a value saved here takes effect
   * without a restart, and the runtime keeps reading it through the same
   * `getConfig()` it always used.
   *
   * Held as an optional capability: an older Host without it leaves the settings
   * page read-only rather than breaking the mount.
   */
  setConfigEditor(service) {
    this.#configEditor = service;
  }

  /** The entry this plugin was mounted as, found by package name. */
  #configEntry() {
    const editor = this.#configEditor;
    if (editor === undefined || typeof editor.entries !== "function") return undefined;
    try {
      const entries = editor.entries();
      /**
       * The identifying fields live under `options`, not on the entry.
       *
       * `entries()` returns Loader rows whose own properties are `loader`, `ctx`,
       * `fiber`, `parent`, `moduleNamespace` — the name and id a plugin can be
       * recognised by are inside `options`. Reading `entry.packageName` therefore
       * never matched, which is why saving reported "no editor" even though the
       * service was bound.
       */
      const named = (entry) => {
        const options = entry?.options ?? {};
        return {
          id: String(options.id ?? ""),
          name: String(options.name ?? ""),
        };
      };
      return (
        entries.find((entry) => named(entry).name === "dsh-muse-media") ??
        entries.find((entry) => named(entry).id === "muse-media") ??
        entries.find((entry) => named(entry).name.includes("dsh-muse-media"))
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Which settings may be written from the UI, and how they are validated.
   *
   * An allowlist, not a passthrough: these values shape process spawning and
   * timeouts, and a typo from a text field should be corrected rather than applied.
   * Each entry returns either a cleaned value or `undefined` to mean "leave alone".
   */
  #clampSetting(key, raw) {
    const RULES = {
      headlessAfterLogin: (value) => (typeof value === "boolean" ? value : undefined),
      showQuotaInComposer: (value) => (typeof value === "boolean" ? value : undefined),
      idleReapSeconds: (value) => clampInt(value, 0, 86_400, 0),
      maxLiveBrowsers: (value) => clampInt(value, 0, 8, 2),
      autoRefreshQuotaSeconds: (value) => clampInt(value, 0, 86_400, 300),
      imageTimeoutSeconds: (value) => clampInt(value, 30, 1_800, 300),
      videoTimeoutSeconds: (value) => clampInt(value, 60, 3_600, 780),
      maxAccountsPerTask: (value) => clampInt(value, 1, 5, 2),
    };
    const rule = RULES[key];
    if (rule === undefined) return undefined;
    return rule(raw);
  }

  /**
   * Persist a settings change and let the Loader apply it.
   *
   * Returns the keys actually written, so the caller can report what happened instead
   * of assuming success. A Host without a config editor gets a clear refusal — the
   * values still work, they just have to be edited in YAML.
   */
  async updateSettings(patch) {
    if (this.busy !== undefined) {
      throw new MuseFailure("页面正被一个任务占用，请等它结束再改设置。", {
        code: "BUSY",
        kind: FAILURE.INVALID,
      });
    }
    const entry = this.#configEntry();
    if (entry === undefined) {
      throw new MuseFailure(
        "这个 Host 没有提供配置编辑接口，设置只能改 cordis.patch.yml 后重启。",
        { code: "NO_CONFIG_EDITOR", kind: FAILURE.SHARED, stage: "settings" },
      );
    }
    const wanted = asRecord(patch);
    const applied = {};
    for (const [key, raw] of Object.entries(wanted)) {
      const value = this.#clampSetting(key, raw);
      if (value !== undefined) applied[key] = value;
    }
    if (Object.keys(applied).length === 0) {
      return { ok: false, changed: [], error: "没有可写入的字段。" };
    }
    await this.#configEditor.edit(entry, (current) => ({ ...current, ...applied }));
    this.#log(`设置已更新：${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    return { ok: true, changed: Object.keys(applied), applied, snapshot: this.snapshot() };
  }

  settings() {
    const config = asRecord(this.#config() ?? {});
    const merged = { ...DEFAULTS };
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const value = config[key];
      if (value === undefined || value === null || value === "") continue;
      merged[key] = typeof fallback === "number" ? Number(value) : value;
    }
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[key] === "number" && !Number.isFinite(merged[key])) merged[key] = DEFAULTS[key];
    }
    return merged;
  }

  mediaDir() {
    const dir = join(this.#paths.root, "media");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Bytes in the media directory, cached.
   *
   * Same reasoning as the profile sizes: this feeds a settings line, so it must
   * not walk the disk on every snapshot. `#mediaBytesCache` is refreshed by the
   * same background tick that refreshes the browser sizes.
   */
  #mediaBytesCache;

  #mediaBytes() {
    return this.#mediaBytesCache;
  }

  /** How many delivered files are on disk, for the diagnostics panel. */
  #mediaCount() {
    try {
      return readdirSync(this.mediaDir(), { withFileTypes: true }).filter((entry) => entry.isFile()).length;
    } catch {
      return 0;
    }
  }

  async #refreshSizeCaches() {
    try {
      await this.#browser.profileSizesAsync();
    } catch {
      /* a settings figure is not worth surfacing an error over */
    }
    try {
      const { readdir, stat } = await import("node:fs/promises");
      const dir = this.mediaDir();
      let total = 0;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try {
          total += (await stat(join(dir, entry.name))).size;
        } catch {
          /* vanished mid-walk */
        }
      }
      this.#mediaBytesCache = total;
    } catch {
      /* ignore */
    }
  }

  /** The URL a tool result exposes for playback. */
  mediaUrl(name) {
    return `${MEDIA_PREFIX}${encodeURIComponent(name)}`;
  }

  /* ---------------- queue ---------------- */

  /**
   * Run one operation with exclusive access to the page.
   *
   * `label` is what the settings card shows as "busy because …", and
   * `accountId` is the account the operation is working on — the composer pill
   * needs it to report the right balance when a request has switched to a spare
   * account mid-task (A4). A rejected operation still releases the queue, which
   * is the point of a promise chain over a flag: an exception cannot wedge it.
   */
  runExclusive(label, operation, { accountId } = {}) {
    const run = async () => {
      this.#queueBusy = { label, accountId, since: Date.now() };
      try {
        return await operation();
      } finally {
        this.#queueBusy = undefined;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get busy() {
    return this.#queueBusy;
  }

  /** Point the running queue entry at the account now carrying the task. */
  #retargetQueue(_taskId, account) {
    if (this.#queueBusy === undefined) return;
    this.#queueBusy = { ...this.#queueBusy, accountId: account.id };
  }

  /**
   * One sentence explaining why this account took the task.
   *
   * Written for the person reading the tool result, not for a log: it names the
   * account, its reset day and its usage, so "why did this spend that quota" is
   * answerable without opening the settings card.
   */
  #explainChoice(account, picked) {
    const quota = account.quota ?? {};
    const reset = typeof quota.reset === "string" && quota.reset !== "" ? quota.reset : undefined;
    const used = typeof quota.usedPct === "number" ? `${quota.usedPct}%` : undefined;
    const facts = [];
    if (reset !== undefined) facts.push(`${reset} 重置`);
    if (used !== undefined) facts.push(`本周已用 ${used}`);
    const detail = facts.length === 0 ? "尚无额度读数" : facts.join("、");

    /**
     * A refresh run says so, because its numbers are the ones just measured and
     * the user should know the account had been unmeasured for a while.
     */
    if (isReadingStale(account.quota)) {
      return `${account.label} 的额度读数早于上次重置，本次优先刷新它（原读数：${detail}）`;
    }
    if (picked !== undefined && picked.id !== account.id) {
      return `${account.label}（${detail}）的周额度更早过期，本次优先使用它而不是 ${picked.label}`;
    }
    if (reset === undefined) {
      return `${account.label}：其它账号的重置日无法比较，本次使用它（${detail}）`;
    }
    return `${account.label}（${detail}）的周额度最早过期，本次使用它`;
  }

  /* ---------------- accounts ---------------- */

  preferredAccount() {
    const selected = this.#accounts.selected();
    if (selected === undefined) {
      throw new MuseFailure(
        "还没有 Muse 账号。打开「设置 → 插件 → Muse 媒体」新增一个账号并完成登录。",
        { code: "NO_ACCOUNT", kind: FAILURE.INVALID },
      );
    }
    return selected;
  }

  /**
   * Verify one account's session and record the verdict.
   *
   * `allowLaunch` is false for the card's polling path: a watcher must never be
   * the reason a browser starts, or closing the sign-in window would immediately
   * spawn a headless replacement that looks like a refusal to quit.
   */
  async verifyAccount(accountId, { visible = false, allowLaunch = false, timeoutMs = 60_000 } = {}) {
    const config = this.settings();
    const wasRunning = this.#browser.isRunning(accountId);
    if (!wasRunning && !allowLaunch) {
      const account = this.#accounts.get(accountId);
      return {
        ok: account?.status === ACCOUNT_STATUS.READY,
        verdict: account?.status === ACCOUNT_STATUS.READY ? "signed-in" : "no-window",
        launched: false,
        verifiedAt: account?.verifiedAt,
        reason: "浏览器没有打开；点「打开登录窗口」开始一次新的校验。",
      };
    }
    const budget = Math.max(1_000, timeoutMs);
    const outcome = await this.#browser.withPage(
      accountId,
      { visible, url: THREAD_URL, timeoutMs: Math.max(budget, 30_000) },
      async (rawPage) => {
        const page = new MusePage(rawPage, this.#log);
        const ready = await page.waitReady({ timeoutMs: budget });
        if (ready === "signed-out") return { verdict: "signed-out", ready };
        if (ready !== "ready") return { verdict: "unknown", ready };
        const session = await page.checkSession();
        return { verdict: session.verdict, ready, session };
      },
    );

    if (outcome.verdict === "signed-in") {
      /**
       * A successful sign-in proves the session, **not** the quota.
       *
       * G5 is explicit: a cooldown's deadline "只意味着可以重新校验，恢复可用须以
       * 校验结果为准". Clearing it here was wrong in a way that costs the user a
       * wasted submission: an account whose reset moment is unknown would drop its
       * cooldown the moment the session checked out, and the very next task would
       * be sent into a limit that had not lifted.
       *
       * So this only records the verification. The cooldown is cleared by
       * `#clearCooldownIfQuotaRecovered`, which reads the usage panel and removes
       * the cooldown only when the panel says usage is no longer exhausted.
       */
      const patch = {
        status: ACCOUNT_STATUS.READY,
        statusReason: undefined,
        verifiedAt: Date.now(),
      };
      this.#accounts.update(accountId, patch);
      return { ok: true, verdict: "signed-in", launched: !wasRunning };
    }
    if (outcome.verdict === "signed-out") {
      this.#accounts.update(accountId, {
        status: ACCOUNT_STATUS.NEEDS_LOGIN,
        statusReason: "会话检查返回未登录",
      });
      return { ok: false, verdict: "signed-out", launched: !wasRunning };
    }
    return { ok: false, verdict: "unknown", detail: outcome, launched: !wasRunning, config };
  }

  /* ---------------- quota ---------------- */

  /**
   * Read one account's usage panel and cache it.
   *
   * `force` bypasses a fresh cache but **still joins an in-flight read** for the
   * same account — that is A5's "刷新在途时再点只产生一次读取", and the ordering
   * below is what makes it true.
   *
   * The in-flight check must come *before* the cache check, and the in-flight
   * entry must be registered **synchronously**, before the first `await`. The
   * earlier version tested the cache first and built the promise before storing
   * it, so two forced refreshes issued in the same tick both saw an empty
   * `#quotaInFlight` and both opened the usage panel — measured as two real panel
   * reads for one double click.
   *
   * A failed read keeps the previous numbers and marks them stale, so the pill
   * greys out instead of blanking (G2).
   *
   * `allowLaunch: false` is the background refresh: it reads only when a browser
   * is already running for that account. A quota poll must never be the reason a
   * window appears. When no browser is up it reports `no-window`, the pill keeps
   * the last known number, and the next real generation refreshes it.
   */
  async readQuota(accountId, { force = false, allowLaunch = true } = {}) {
    const config = this.settings();
    const cacheMs = 60_000;

    // 1. Join an in-flight read first: it is the freshest answer available, and a
    //    caller asking while one runs must not start a second panel visit.
    const inFlight = this.#quotaInFlight.get(accountId);
    if (inFlight !== undefined) return inFlight;

    // 2. Then the cache, which only a non-forced read consults.
    const cached = this.#quotaCache.get(accountId);
    if (!force && cached !== undefined && Date.now() - cached.at < cacheMs) {
      return { ...cached.quota, cached: true, at: cached.at };
    }

    if (!allowLaunch && !this.#browser.isRunning(accountId)) {
      return {
        ok: false,
        status: "no-window",
        usedPct: cached?.quota.usedPct,
        plan: cached?.quota.plan,
        reset: cached?.quota.reset,
        at: cached?.at,
        stale: cached?.quota.usedPct !== undefined,
        error: "浏览器未运行；额度会在下一次生成后更新",
      };
    }

    /**
     * Register the promise synchronously, before any await **and before the
     * queue**, then do the queued work inside it.
     *
     * The deadlock this avoids: both callers arrive in one tick, both want a
     * forced read, and each is dispatched through `runExclusive`. If the merge is
     * decided *inside* the queued operation, the second call queues behind the
     * first while also awaiting the promise the first is producing — it waits on
     * the queue, the queue waits on it, and neither ever settles. Registering the
     * shared promise first means the second caller joins it and never enters the
     * queue at all.
     */
    let settle;
    let fail;
    const operation = new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.#quotaInFlight.set(accountId, operation);

    void (async () => {
      try {
        settle(
          await this.runExclusive(
            `读取额度 ${accountId}`,
            () => this.#readQuotaNow(accountId, { config, allowLaunch }),
            { accountId },
          ),
        );
      } catch (error) {
        fail(error);
      } finally {
        this.#quotaInFlight.delete(accountId);
      }
    })();

    return operation;
  }

  /** The panel read itself, so the caller can register its promise first. */
  async #readQuotaNow(accountId, { config, allowLaunch }) {
    try {
      const parsed = await this.#browser.withPage(
        accountId,
        {
          // A quota read is background maintenance: reuse an existing browser,
          // never open a window for it, and never extend the browser's life.
          visible: false,
          reuseOnly: !allowLaunch,
          background: true,
          url: THREAD_URL,
          timeoutMs: 60_000,
        },
        async (rawPage) => {
          const page = new MusePage(rawPage, this.#log);
          const ready = await page.waitReady({ timeoutMs: 40_000 });
          if (ready !== "ready") {
            throw new MuseFailure(
              ready === "signed-out"
                ? "账号会话已失效。"
                : `页面未就绪（${ready}）。`,
              {
                code: "PAGE_NOT_READY",
                kind: ready === "signed-out" ? FAILURE.SIGNED_OUT : FAILURE.SHARED,
                stage: "quota",
              },
            );
          }
          return page.readQuota({ timeoutMs: config.quotaTimeoutSeconds * 1000 });
        },
      );
      const at = Date.now();
      const quota = {
        ok: true,
        usedPct: parsed.usedPct,
        /**
         * What `usedPct` measures: the **free weekly allowance**.
         *
         * Muse shows two separate budgets — the weekly allowance and an extra one
         * that never expires — and the percentage the composer readout shows is
         * the weekly figure alone, never the two combined. `scope` says so in the
         * value so no consumer has to remember it, and the extra budget travels
         * beside it rather than being folded in.
         */
        scope: parsed.scope ?? "weekly",
        plan: parsed.plan,
        reset: parsed.reset,
        extraUsedPct: parsed.extraUsedPct,
        extraLeft: parsed.extraLeft,
        extraExpires: parsed.extraExpires,
        raw: parsed.raw,
        at,
      };
      this.#quotaCache.set(accountId, { quota, at });
      this.#accounts.update(accountId, {
        quota: {
          usedPct: parsed.usedPct,
          scope: quota.scope,
          plan: parsed.plan,
          reset: parsed.reset,
          extraUsedPct: parsed.extraUsedPct,
          extraLeft: parsed.extraLeft,
          extraExpires: parsed.extraExpires,
          at,
          stale: false,
          error: undefined,
        },
      });
      return quota;
    } catch (error) {
      const failure = asFailure(error, { stage: "quota" });
      const previous = this.#quotaCache.get(accountId)?.quota ?? this.#accounts.get(accountId)?.quota;
      const at = Date.now();
      const quota = {
        ok: false,
        error: failure.message,
        usedPct: previous?.usedPct,
        plan: previous?.plan,
        reset: previous?.reset,
        extraLeft: previous?.extraLeft,
        at,
        stale: previous?.usedPct !== undefined,
      };
      this.#quotaCache.set(accountId, { quota, at });
      this.#accounts.update(accountId, {
        quota: {
          usedPct: quota.usedPct,
          plan: quota.plan,
          reset: quota.reset,
          extraLeft: quota.extraLeft,
          at,
          stale: quota.stale,
          error: failure.message,
        },
      });
      if (failure.kind === FAILURE.SIGNED_OUT) {
        this.#accounts.update(accountId, {
          status: ACCOUNT_STATUS.NEEDS_LOGIN,
          statusReason: "读取额度时页面显示登录入口",
        });
      }
      return quota;
    }
  }
  /**
   * The composer pill's answer.
   *
   * Which account it reports on is a rule, not a default (G2, A4, A20):
   *
   *   - **While a task runs**, it reports the account that task is actually
   *     using. A request may start on the hand-picked account and switch to a
   *     spare when the preferred one is signed out; showing the hand-picked one
   *     then would display A's balance while B is being charged.
   *   - **While idle**, it reports the hand-picked account, so the number the
   *     user sees is what the next request will spend.
   *
   * The read is gated on the queue: it only happens when no task holds the page,
   * and it runs inside `runExclusive` so a forced refresh cannot interleave with
   * a generation (A20). While busy there is no page action at all — only the
   * cached figure for that account, marked stale.
   */
  async quotaView({ accountId, force = false, allowLaunch = false } = {}) {
    const accounts = this.#accounts.list();
    const busy = this.busy;
    const activeAccountId = busy?.accountId;
    const preferred =
      accountId ?? activeAccountId ?? this.#accounts.selectedId ?? this.#accounts.selected()?.id;
    const account = preferred === undefined ? undefined : this.#accounts.get(preferred);
    const total = accounts.length;
    const base = {
      show: this.settings().showQuotaInComposer !== false,
      account: account === undefined ? undefined : { id: account.id, label: account.label },
      accountCount: total,
      showLabel: total > 1,
      busy: busy === undefined ? undefined : busy.label,
      duringTask: busy !== undefined && activeAccountId !== undefined,
    };
    if (account === undefined) {
      return { ...base, ok: false, status: "no-account", text: "待刷新", reason: "还没有 Muse 账号" };
    }
    if (busy !== undefined) {
      const cached = this.#quotaCache.get(account.id);
      if (cached !== undefined) {
        return {
          ...base,
          ok: true,
          status: cached.quota.ok ? "cached" : "cached-error",
          usedPct: cached.quota.usedPct,
          plan: cached.quota.plan,
          reset: cached.quota.reset,
          at: cached.at,
          stale: true,
          reason: "页面正被生成任务占用，显示上次读取结果",
        };
      }
      return { ...base, ok: false, status: "pending", text: "待刷新", reason: "页面正被生成任务占用" };
    }
    if (account.status === ACCOUNT_STATUS.NEW || account.status === ACCOUNT_STATUS.NEEDS_LOGIN) {
      return {
        ...base,
        ok: false,
        status: "signed-out",
        text: "待刷新",
        reason: account.status === ACCOUNT_STATUS.NEW ? "账号尚未登录" : "账号需要重新登录",
      };
    }
    const quota = await this.readQuota(account.id, { force, allowLaunch });
    return {
      ...base,
      ...quota,
      status: quota.ok ? (quota.stale ? "stale" : "ok") : quota.status === "no-window" ? "pending" : "error",
    };
  }

  /* ---------------- generation ---------------- */

  /**
   * Turn reference arguments into local files.
   *
   * `DOM.setFileInputFiles` reads from the filesystem, so an attachment id or a
   * data URL has to be written down first. Each task gets its own upload
   * directory under `media/refs-<taskId>/`, which makes cleanup exact.
   */
  async materializeReferences(values, taskId) {
    if (values === undefined || values.length === 0) return { files: [], sources: new Set() };
    const dir = join(this.mediaDir(), `refs-${taskId}`);
    mkdirSync(dir, { recursive: true });
    const files = [];
    const sources = new Set();
    for (let index = 0; index < values.length; index += 1) {
      const resolved = await this.#resolveReference(values[index], dir, index);
      files.push(resolved.path);
      if (resolved.source !== undefined) sources.add(resolved.source);
    }
    return { files, sources };
  }

  async #resolveReference(value, dir, index) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw === "") {
      throw new MuseFailure(`第 ${index + 1} 个参考图是空字符串。`, {
        code: "INVALID_ARGS",
        kind: FAILURE.INVALID,
      });
    }

    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      if (comma === -1) {
        throw new MuseFailure(`第 ${index + 1} 个参考图是无效的 data URL。`, {
          code: "INVALID_ARGS",
          kind: FAILURE.INVALID,
        });
      }
      const head = raw.slice(5, comma);
      const payload = raw.slice(comma + 1);
      const mime = head.split(";")[0] || "image/png";
      const bytes = head.includes(";base64")
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "binary");
      if (bytes.length === 0) {
        throw new MuseFailure(`第 ${index + 1} 个参考图解码后为空。`, {
          code: "INVALID_ARGS",
          kind: FAILURE.INVALID,
        });
      }
      const ext = MEDIA_EXT[mime] ?? ".png";
      const path = join(dir, `reference-${index + 1}${ext}`);
      writeFileSync(path, bytes);
      return { path, source: raw };
    }

    if (raw.startsWith("file://")) {
      const path = decodeURIComponent(new URL(raw).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
      if (existsSync(path)) return { path, source: raw };
      throw new MuseFailure(`第 ${index + 1} 个参考图不存在：${path}`, {
        code: "REFERENCE_MISSING",
        kind: FAILURE.ATTACHMENT_INCOMPLETE,
      });
    }

    if (existsSync(raw)) return { path: raw, source: raw };

    if (raw.startsWith("sha256:")) {
      const attached = await this.#readAttachmentTo(raw, dir, index);
      if (attached !== undefined) return attached;
    }

    throw new MuseFailure(
      `第 ${index + 1} 个参考图无法读取：既不是本机路径，也不是可用的附件（${raw.slice(0, 80)}）。`,
      { code: "REFERENCE_UNREADABLE", kind: FAILURE.ATTACHMENT_INCOMPLETE },
    );
  }

  async #readAttachmentTo(attachmentId, dir, index) {
    const attachments = this.#attachments;
    if (attachments === undefined) return undefined;
    try {
      const stored = await attachments.readImage({
        attachmentId,
        mediaType: "image/png",
        bytes: 0,
        width: 1,
        height: 1,
      });
      const ext = MEDIA_EXT[stored.ref.mediaType] ?? ".png";
      const path = join(dir, `reference-${index + 1}${ext}`);
      writeFileSync(path, Buffer.from(stored.data));
      return { path, source: attachmentId };
    } catch {
      return undefined;
    }
  }

  /** Store an image result through the Host attachment service. */
  async persistImage(result, size) {
    const attachments = this.#attachments;
    if (attachments === undefined) {
      throw new MuseFailure(
        "这个 DSH 没有提供附件服务，图片无法在对话里显示。结果已保存到插件媒体目录。",
        { code: "NO_ATTACHMENTS", kind: FAILURE.SHARED },
      );
    }
    const mediaType = result.mime.startsWith("image/") ? result.mime : "image/png";
    const limits = attachments.imageLimits;
    if (!limits.mediaTypes.includes(mediaType)) {
      throw new MuseFailure(`当前 DSH 不支持保存 ${mediaType} 图片。`, {
        code: "UNSUPPORTED_MEDIA",
        kind: FAILURE.SHARED,
      });
    }
    const data = readFileSync(result.path);
    const ref = await attachments.saveImage({
      data,
      mediaType,
      name: `muse-${size.replace(":", "x")}-${result.taskId}`,
    });
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    };
  }

  /**
   * The one media task path for images and videos.
   *
   * The account loop is the G5 table in code. Each iteration is one account's
   * whole attempt; the journal is written before the send, and every exit that
   * left a request possibly in flight records `unknown` and forbids a retry.
   */
  async runMediaTask({ kind, prompt, references }) {
    const config = this.settings();
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new MuseFailure("prompt 必填，且必须是非空字符串。", {
        code: "INVALID_ARGS",
        kind: FAILURE.INVALID,
      });
    }
    /**
     * Video accepts several reference images.
     *
     * This used to be capped at one, on the assumption that video took a
     * "first frame" and nothing else. The composer's own file input accepts many
     * (`multiple`, no `accept` filter), a measured ten uploads were all accepted
     * with no warning, and searching the client bundles for any count guard found
     * none — so the cap was the plugin's invention, not Muse's.
     *
     * What Muse does *with* several images in a video prompt is not documented and
     * cannot be established without spending a generation, so the tool description
     * says exactly that: a first image is treated as the starting frame, and any
     * others may or may not be honoured as style/subject references. The ceiling
     * here only guards against a runaway upload, not a product limit.
     */
    const referenceCeiling = kind === "video" ? MAX_VIDEO_REFERENCES : MAX_IMAGE_REFERENCES;
    if (references !== undefined && references.length > referenceCeiling) {
      throw new MuseFailure(
        `一次最多 ${referenceCeiling} 张参考图，收到 ${references.length} 张。` +
          (kind === "video" ? "Muse 界面本身不限数量，这个上限只是防止误传过多。" : ""),
        { code: "INVALID_ARGS", kind: FAILURE.INVALID },
      );
    }

    /**
     * Pick the account whose allowance expires soonest.
     *
     * The weekly allowance is lost at its reset whether or not it was spent, and
     * the extra allowance never expires — so the weekly quota closest to being
     * thrown away is the one most worth spending. `rankAccounts` orders by reset
     * day, then by usage, then by the user's pick, then by idle time.
     *
     * The hand-picked account is no longer forced to the front: choosing one that
     * resets two weeks out while another resets tomorrow would waste the nearer
     * allowance. The pick still settles ties, and the result always names the
     * account that actually ran.
     */
    const preferred = this.preferredAccount();
    const ranked = rankAccounts(this.#accounts.list(), {
      preferredId: preferred.id,
      now: Date.now(),
    });
    const chosen = ranked.ordered[0] ?? preferred;

    const task = this.#tasks.create({
      kind,
      accountId: chosen.id,
      accountLabel: chosen.label,
    });
    /**
     * Freeze the allowance at the start of the task.
     *
     * The post-delivery read updates the cache, so without this snapshot the
     * "before" figure would be overwritten and the cost of this generation would be
     * unrecoverable. Taken from the cache only — a generation never waits for a
     * quota read to begin.
     */
    const cachedBefore = this.#quotaCache.get(chosen.id)?.quota.usedPct;
    if (typeof cachedBefore === "number") {
      this.#tasks.update(task.id, { quotaBefore: cachedBefore });
    }

    return this.runExclusive(
      `${kind === "video" ? "生视频" : "生图"} ${task.id}`,
      async () => {
        try {
          return await this.#runAccountLoop({
            kind,
            prompt,
            references,
            preferred: chosen,
            task,
            config,
            });
        } catch (error) {
          // The floor for an exit that journaled nothing. It must never
          // *downgrade* a record that already says a request may be upstream:
          // `possibly-sent` and `accepted` are exactly the states where G5
          // forbids reporting a failure, because the user would resubmit.
          const current = this.#tasks.get(task.id);
          const stillOpen =
            current !== undefined &&
            (current.state === TASK_STATE.QUEUED || current.state === TASK_STATE.RUNNING);
          if (stillOpen) {
            const failure = asFailure(error, { stage: "generate" });
            this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: failure.message });
          }
          throw error;
        }
      },
      { accountId: preferred.id },
    );
  }

  /**
   * The G5 account loop: try the preferred account, switch only on proof.
   *
   * The switch condition is deliberately narrow. G5's table allows a second
   * account for exactly one reason — the preferred account's authenticated check
   * says it is signed out — and its quota section says a limit or an exhaustion
   * **stops the task**. Anything else (a cooldown, a shared network fault, an
   * unreadable page) ends the attempt on that account and never spends somebody
   * else's quota on the same prompt.
   */
  async #runAccountLoop({ kind, prompt, references, preferred, task, config }) {
    const attempted = [preferred.id];
    let account = preferred;
    let lastFailure;

    for (;;) {
      /**
       * Re-read the account before every decision.
       *
       * `preferred` came from `preferredAccount()`, which returns a *clone* of the store row.
       * A queued task therefore carried the state it had when it was enqueued, so a cooldown
       * recorded while it waited was invisible to it — measured: a second task on one account
       * sent a request after the first had earned a 120-second 429 cooldown, while a third task
       * created afterwards was correctly refused. The gap only shows under contention, which is
       * exactly when spending a request is most expensive.
       *
       * Reading the store each turn costs nothing and makes every exit condition current:
       * cooldown, sign-out, disablement.
       */
      const fresh = this.#accounts.get(account.id);
      if (fresh !== undefined) account = fresh;
      const verdict = eligibility(account);

      if (!verdict.usable && !verdict.needsRecheck) {
        lastFailure = this.#unavailableFailure(account, verdict);
        if (verdict.maySwitch === true) {
          const next = this.#nextAccount(attempted, config.maxAccountsPerTask);
          if (next !== undefined) {
            account = next;
            attempted.push(account.id);
            this.#retargetQueue(task.id, account);
            this.#tasks.update(task.id, {
              state: TASK_STATE.QUEUED,
              accountId: account.id,
              accountLabel: account.label,
              attempted,
            });
            continue;
          }
        }
        this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: lastFailure.message });
        throw this.#exhausted(lastFailure, attempted, verdict);
      }

      this.#tasks.update(task.id, {
        state: TASK_STATE.RUNNING,
        accountId: account.id,
        accountLabel: account.label,
        attempted,
      });
      this.#retargetQueue(task.id, account);

      try {
        if (verdict.needsRecheck) {
          /**
           * A cooldown's deadline passing means "may be re-checked", never "is
           * recovered".
           *
           * G5: "恢复时间到达只意味着可重新校验，恢复可用须以校验结果为准". So the
           * re-check has two halves, and both are required before a send:
           *
           *   1. the session still works (otherwise this is a sign-out), and
           *   2. the usage panel no longer reports the limit (otherwise the
           *      cooldown simply stays, with a refreshed deadline if the panel
           *      now names one).
           *
           * Skipping step 2 is what let an unknown-deadline account clear its
           * cooldown on a passing sign-in and submit into a live limit (A17).
           */
          const verified = await this.verifyAccount(account.id, {
            visible: !config.headlessAfterLogin,
            allowLaunch: true,
          });
          if (!verified.ok) {
            if (verified.verdict === "signed-out") {
              lastFailure = new MuseFailure(`账号 ${account.label} 需要重新登录。`, {
                code: "SIGNED_OUT",
                kind: FAILURE.SIGNED_OUT,
                stage: "select",
              });
              const next = this.#nextAccount(attempted, config.maxAccountsPerTask);
              if (next !== undefined) {
                account = next;
                attempted.push(account.id);
                this.#retargetQueue(task.id, account);
                this.#tasks.update(task.id, {
                  attempted,
                  accountId: account.id,
                  accountLabel: account.label,
                });
                continue;
              }
              this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: lastFailure.message });
              throw this.#exhausted(lastFailure, attempted);
            }
            // A re-check that could not confirm the session proves nothing about
            // this account, so it neither cools it nor moves the task elsewhere.
            lastFailure = new MuseFailure(
              `账号 ${account.label} 的会话无法确认（${verified.verdict}）。`,
              { code: "SESSION_UNKNOWN", kind: FAILURE.SHARED, stage: "select" },
            );
            this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: lastFailure.message });
            throw lastFailure;
          }

          const recovered = await this.#recheckQuotaRecovered(account, config);
          if (!recovered.ok) {
            // Still limited (or unreadable): the cooldown stands, the task stops,
            // and nothing is sent. No other account is tried — a limit is a stop
            // condition, not a redirect.
            lastFailure = recovered.failure;
            this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: lastFailure.message });
            throw this.#quotaFailure(
              lastFailure,
              account,
              recovered.reset === undefined ? { note: "（额度面板未能确认已恢复）" } : recovered.reset,
            );
          }
        }

        const result = await this.#attemptOnAccount({
          kind,
          prompt,
          references,
          account,
          task,
          config,
        });
        this.#accounts.update(account.id, { lastUsedAt: Date.now(), status: ACCOUNT_STATUS.READY });
        /**
         * Say which account ran, and why, in the result itself.
         *
         * The account is chosen by "whose weekly allowance expires soonest", not
         * by the user's selection, so a task can legitimately spend an account
         * other than the highlighted one. Leaving that implicit would mean the
         * user spends quota on an account they did not expect, with no way to
         * notice. `accountReason` explains the choice in one sentence.
         */
        return {
          ...result,
          taskId: task.id,
          account: { id: account.id, label: account.label },
          accountReason: this.#explainChoice(account, preferred),
        };
      } catch (error) {
        const failure = asFailure(error, { stage: "generate" });
        lastFailure = failure;

        // ---- exits that must not be retried on another account ----

        if (failure.code === "OUTCOME_UNKNOWN" || failure.kind === FAILURE.TIMEOUT) {
          this.#tasks.update(task.id, { state: TASK_STATE.UNKNOWN, note: failure.message });
          throw failure;
        }
        if (failure.kind === FAILURE.QUOTA_EXHAUSTED) {
          const reset = await this.#recordQuotaCooldown(account, failure, config);
          this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: `${failure.message}${reset.note}` });
          throw this.#quotaFailure(failure, account, reset);
        }
        if (failure.kind === FAILURE.RATE_LIMITED) {
          /**
           * A rate limit keeps its own deadline.
           *
           * Two things were wrong before. The retry instant the message named was
           * thrown away (`resetAt: undefined`), so the cooldown had no expiry; and
           * the later re-check looked at the **weekly** panel, which is a different
           * limit entirely — a healthy 19% there was read as "recovered" and the
           * task resumed into a limit that had never lifted (A17).
           *
           * Now the parsed instant is stored, and an unknown one stays
           * `usableUntil: undefined`, meaning "re-check required, no automatic
           * expiry" — which is the honest state for a limit that named nothing.
           */
          const retryAt = failure.retryAt;
          this.#accounts.update(
            account.id,
            cooldownPatch({
              reason: "上游限流",
              resetAt: retryAt,
              raw: failure.message,
            }),
          );
          if (retryAt !== undefined) this.#rateLimitRetries.set(account.id, retryAt);
          this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: failure.message });
          throw this.#quotaFailure(failure, account, {
            note:
              retryAt === undefined
                ? "（限流没有给出可用的重试时刻）"
                : `（限流给出重试时刻：${new Date(retryAt).toLocaleString()}）`,
            resetAt: retryAt,
            raw: failure.message,
          });
        }
        if (failure.kind === FAILURE.ATTACHMENT_INCOMPLETE || failure.kind === FAILURE.INVALID) {
          this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: failure.message });
          throw failure;
        }

        // ---- signed out: the one case that may use a second account ----

        if (failure.kind === FAILURE.SIGNED_OUT) {
          this.#accounts.update(account.id, {
            status: ACCOUNT_STATUS.NEEDS_LOGIN,
            statusReason: failure.message,
          });
          if (maySwitchAccount(failure, attempted, config.maxAccountsPerTask)) {
            const next = this.#nextAccount(attempted, config.maxAccountsPerTask);
            if (next !== undefined) {
              account = next;
              attempted.push(account.id);
              this.#retargetQueue(task.id, account);
              this.#tasks.update(task.id, {
                attempted,
                accountId: account.id,
                accountLabel: account.label,
              });
              continue;
            }
          }
          this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: failure.message });
          throw this.#exhausted(failure, attempted);
        }

        // ---- shared fault: end the attempt, change no account's health ----

        this.#tasks.update(task.id, { state: TASK_STATE.FAILED, note: failure.message });
        if (isBrowserGone(error)) {
          await this.#browser.close(account.id, { reason: "任务中浏览器失联" }).catch(() => {});
        }
        throw failure;
      }
    }
  }

  /** One account's whole attempt, from page open to media bytes. */
  async #attemptOnAccount({ kind, prompt, references, account, task, config }) {
    const { files, sources } = await this.materializeReferences(references, task.id);

    return this.#browser.withPage(
      account.id,
      { visible: !config.headlessAfterLogin, url: THREAD_URL, timeoutMs: 60_000 },
      async (rawPage) => {
        const page = new MusePage(rawPage, this.#log);
        const ready = await page.waitReady({ timeoutMs: 45_000 });
        if (ready === "signed-out") {
          throw new MuseFailure(`账号 ${account.label} 的会话已失效，需要重新登录。`, {
            code: "SIGNED_OUT",
            kind: FAILURE.SIGNED_OUT,
            stage: "select",
          });
        }
        if (ready !== "ready") {
          throw new MuseFailure(`页面没有就绪（${ready}），本次尝试结束。`, {
            code: "PAGE_NOT_READY",
            kind: FAILURE.SHARED,
            stage: "prepare",
          });
        }

        const session = await page.checkSession();
        if (session.verdict === "signed-out") {
          throw new MuseFailure(`账号 ${account.label} 的会话已失效，需要重新登录。`, {
            code: "SIGNED_OUT",
            kind: FAILURE.SIGNED_OUT,
            stage: "select",
          });
        }

        // The composer must start clean: a leftover attachment from an earlier
        // task would ride along with this prompt.
        await page.clearComposer({ fresh: true });

        let upload = { attached: 0 };
        if (files.length > 0) {
          upload = await page.attachFiles(files, { expected: files.length, timeoutMs: 90_000 });
        }

        const baseline = await page.snapshot();
        const promptResult = await page.setPrompt(prompt);
        if (promptResult.length === 0) {
          throw new MuseFailure("提示词没有进入输入框，已停止（没有提交）。", {
            code: "COMPOSER_EMPTY",
            kind: FAILURE.SHARED,
            stage: "composer",
          });
        }

        /**
         * Last look at the account's health before the send boundary.
         *
         * Preparation takes real time — opening the page, verifying the session, uploading
         * references — and a cooldown can be recorded during it, either by this task's earlier
         * turn or by another task that failed while this one was working. Checking here, before
         * the journal write rather than after, means a task that has become ineligible stops
         * *before* the point of no return instead of spending a request into a live limit.
         */
        const current = this.#accounts.get(account.id);
        if (current !== undefined) {
          const verdictNow = eligibility(current);
          if (!verdictNow.usable) {
            this.#tasks.update(task.id, {
              state: TASK_STATE.FAILED,
              note: `发送前复核：${verdictNow.label}`,
            });
            throw this.#unavailableFailure(current, verdictNow);
          }
        }

        // ---- send boundary (G5): journal first, then exactly one action ----
        this.#tasks.update(task.id, {
          state: TASK_STATE.POSSIBLY_SENT,
          accountId: account.id,
          accountLabel: account.label,
          sendAttemptedAt: Date.now(),
          note: files.length > 0 ? `参考素材 ${upload.attached} 个已就绪` : "无参考素材",
        });
        if (this.#tasks.get(task.id)?.state !== TASK_STATE.POSSIBLY_SENT) {
          throw new MuseFailure("任务记录写入失败，已在提交前停止（没有发送）。", {
            code: "JOURNAL_WRITE_FAILED",
            kind: FAILURE.SHARED,
            stage: "journal",
          });
        }

        const send = await page.sendOnce();
        if (!send.fired) {
          this.#tasks.update(task.id, {
            state: TASK_STATE.FAILED,
            note: `发送动作未触发（${send.reason ?? "unknown"}）`,
          });
          throw new MuseFailure(`发送动作未触发（${send.reason ?? "unknown"}），本次没有提交。`, {
            code: "SEND_NOT_FIRED",
            kind: FAILURE.SHARED,
            stage: "send",
          });
        }

        /**
         * An unconfirmed action is already an unknown outcome.
         *
         * When the click's own reply was lost, the plugin cannot tell whether the
         * page submitted — but it also cannot claim it did not. Waiting for
         * delivery would be waiting for evidence from a page it can no longer
         * read, and letting a later failure propagate would journal `failed`.
         * So the record goes straight to `UNKNOWN` and the caller is told to look
         * at the account's thread: exactly the sentence G5 specifies and A16
         * checks.
         */
        if (send.unconfirmed === true) {
          this.#tasks.update(task.id, {
            state: TASK_STATE.UNKNOWN,
            note: `发送动作已发出但回执丢失（${send.reason ?? "unknown"}）`,
          });
          throw new MuseFailure(
            `任务 ${task.id} · ${account.label} · 结果未知（发送动作已发出但回执丢失：${
              send.reason ?? "unknown"
            }）。请先看该账号的 Muse 会话，不要直接重发。`,
            { code: "OUTCOME_UNKNOWN", kind: FAILURE.TIMEOUT, stage: "send" },
          );
        }

        // From here on the request may already be upstream. Every exit lands on
        // `UNKNOWN`, never `FAILED` (G5, A16).
        const delivery = await page.waitDelivery(baseline, {
          warnMs: config.deliveryWarnSeconds * 1000,
          unknownMs: config.deliveryUnknownSeconds * 1000,
        });

        if (delivery.unknown === true) {
          const residue = delivery.residue === "" ? "输入框为空" : `输入框残留 ${delivery.residue}`;
          const why = delivery.reason === undefined ? "" : `；${delivery.reason}`;
          this.#tasks.update(task.id, {
            state: TASK_STATE.UNKNOWN,
            note: `发送后 ${Math.round(delivery.at / 1000)} 秒没有本轮送达证据（${residue}）${why}`,
          });
          throw new MuseFailure(
            `任务 ${task.id} · ${account.label} · 结果未知（发送动作已触发，` +
              `${Math.round(delivery.at / 1000)} 秒后仍没有送达证据；${residue}${why}）。` +
              `请先看该账号的 Muse 会话，不要直接重发。`,
            { code: "OUTCOME_UNKNOWN", kind: FAILURE.TIMEOUT, stage: "delivery" },
          );
        }

        this.#tasks.update(task.id, {
          state: TASK_STATE.ACCEPTED,
          note: `送达证据：${delivery.evidence}`,
        });

        /**
         * Two different questions, two different answers.
         *
         * `upload.attached` is ours: the composer's own remove-button count proved
         * the file reached the page before the send. `roundEvidence` is the
         * shell's: how many attachment nodes the *sent* user message renders.
         *
         * They can legitimately disagree. Measured live on a frame-conditioned
         * video: the delivered MP4's first visible frame IS the submitted
         * triangle, while the user bubble renders no attachment node at all
         * (`imgs: 0`, no `data-testid`), so Muse consumed the upload without
         * displaying it in the thread. Reporting "0/1" as an upload failure would
         * be wrong, and reporting nothing would hide a real capability fact — so
         * both numbers are carried and the wording says which is which.
         */
        const roundEvidence = await page.roundUserAttachments(prompt).catch(() => undefined);
        const roundCount = roundEvidence === undefined ? undefined : roundEvidence.count;
        const uploadCount = upload.attached ?? 0;
        if (files.length > 0 && roundCount !== undefined && roundCount < files.length) {
          this.#log(
            `本轮用户消息渲染了 ${roundCount}/${files.length} 个附件（上传侧 ${uploadCount} 个已确认）；` +
              `上游可能把参考图作为输入消费而不在消息里显示（任务 ${task.id}）`,
          );
        }

        let media;
        try {
          /**
           * The media budget starts **now**, not when the attempt began.
           *
           * `imageTimeoutSeconds` describes how long to wait for the picture to
           * appear, so it must not be spent on opening the page, verifying the
           * session, or uploading references — all of which happen before a
           * request even exists. Measuring from the attempt start meant a
           * two-reference upload could consume a third of the budget and hand the
           * media wait what was left, which is how a real double-image request
           * reported `unknown` at ~300 s with the result still upstream.
           */
          const deadline = Date.now() + (kind === "video" ? config.videoTimeoutSeconds : config.imageTimeoutSeconds) * 1000;
          media = await page.waitMedia(baseline, { kind, deadline, referenceSources: sources });
        } catch (error) {
          const failure = asFailure(error, { stage: "media" });
          // A verified quota stop keeps its own kind so the caller can cool the
          // account (A17). Anything else after acceptance is an unknown result.
          if (failure.kind === FAILURE.QUOTA_EXHAUSTED || failure.kind === FAILURE.RATE_LIMITED) {
            this.#tasks.update(task.id, { state: TASK_STATE.ACCEPTED, note: failure.message });
            throw failure;
          }
          this.#tasks.update(task.id, {
            state: TASK_STATE.UNKNOWN,
            note: `已接单，取回媒体时中断：${failure.message}`,
          });
          throw new MuseFailure(
            `任务 ${task.id} · ${account.label} · 结果未知（上游已接单，但取回媒体时中断：${failure.message}）。` +
              `请先看该账号的 Muse 会话，不要直接重发。`,
            { code: "OUTCOME_UNKNOWN", kind: FAILURE.TIMEOUT, stage: "media" },
          );
        }

        const stored = this.#storeMedia(media, kind);
        this.#tasks.update(task.id, {
          state: TASK_STATE.DELIVERED,
          media: stored.file,
          /**
           * Wall-clock duration, for the history list.
           *
           * `delivery.at` is not the task's start and `Date.now()` here is not the
           * end of a user-visible wait, so the figure is taken from the task record
           * itself, which is written before any page work begins.
           */
          durationMs: Math.max(1, Date.now() - (this.#tasks.get(task.id)?.createdAt ?? Date.now())),
          note:
            `送达证据：${delivery.evidence}` +
            (files.length === 0
              ? ""
              : `；上传确认 ${uploadCount}/${files.length}` +
                (roundCount === undefined ? "；消息附件未读到" : `；消息渲染 ${roundCount} 个`)),
        });

        /**
         * Refresh the readout after this task releases the page.
         *
         * A generation is the cheapest moment to read the usage panel: the
         * browser is already up, and the number beside the composer should
         * reflect the run that just happened rather than the one before it.
         *
         * It must NOT run inline. This code executes while the task still holds
         * the queue, so a page read here would be a second concurrent page
         * operation — exactly what A20 forbids. The work is therefore queued
         * behind the current task by deferring it a turn of the event loop past
         * the queue's own settlement.
         */
        const accountId = account.id;
        const taskId = task.id;
        setImmediate(() => {
          void this.readQuota(accountId, { force: true, allowLaunch: false })
            .then((quota) => {
              /**
               * Record what this generation cost.
               *
               * The read happens for the composer anyway; keeping its result on the
               * task turns a stream of readings into a history — which is what makes
               * "what is eating my weekly allowance" answerable without another page
               * visit. `quotaBefore` was frozen at task start, so the pair survives
               * the cache being overwritten.
               */
              if (typeof quota?.usedPct === "number") {
                this.#tasks.update(taskId, { quotaAfter: quota.usedPct });
              }
            })
            .catch(() => {});
        });

        return {
          ...stored,
          kind,
          prompt,
          sentAction: send.action,
          deliveryEvidence: delivery.evidence,
          attachmentCount: roundCount,
          uploadCount,
          requestedAttachments: files.length,
          media,
        };
      },
    );
  }

  /** Write the fetched bytes under the plugin's media directory. */
  /**
   * Write one delivered file.
   *
   * Delivered media is **never deleted automatically**. These files are the
   * product: they cost real quota to make, and each one is linked from the
   * conversation message that announced it. Pruning old files to bound disk usage
   * would silently break those links — a picture the user scrolls back to months
   * later would simply be gone, with no record of why. Disk growth is the user's
   * decision to make, so the settings card reports the total and offers an explicit
   * clear action instead; nothing here removes a file on its own.
   */
  #storeMedia(media, kind) {
    const dir = this.mediaDir();
    const ext =
      MEDIA_EXT[(media.mime || "").toLowerCase()] ??
      (kind === "video" ? ".mp4" : extname(nonEmpty(media.source) ?? "") || ".png");
    const name = `muse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const file = join(dir, name);
    writeFileSync(file, media.bytes);
    this.#mediaBytesCache = undefined;
    return {
      file,
      name,
      path: file,
      bytes: media.bytes.length,
      mime: media.mime || MIME_BY_EXT[ext] || "application/octet-stream",
    };
  }

  /**
   * Remove the per-task reference directories left behind by earlier runs.
   *
   * `materializeReferences` creates `refs-<taskId>/` per task and the comment says
   * the naming "makes cleanup exact", but no cleanup existed — a live install had
   * five empty directories. They are cheap, but they accumulate one per task, so
   * they are swept whenever the settings card asks for a snapshot.
   */
  #sweepRefDirs() {
    const dir = this.mediaDir();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - 10 * 60_000;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("refs-")) continue;
      const full = join(dir, entry.name);
      try {
        // Only directories that no running task could still be filling.
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
      } catch {
        /* leave it for the next sweep */
      }
    }
  }

  /** Next usable account, only for a switch G5 permits. */
  #nextAccount(attempted, maxAccounts) {
    const limit = accountAttemptLimit(maxAccounts);
    if (attempted.length >= limit) return undefined;
    const ranked = this.#accounts
      .list()
      .filter((account) => !attempted.includes(account.id))
      .map((account) => ({ account, verdict: eligibility(account) }))
      .filter((row) => row.verdict.usable)
      .sort((a, b) => (a.account.lastUsedAt ?? 0) - (b.account.lastUsedAt ?? 0));
    return ranked[0]?.account;
  }

  /**
   * The failure an unavailable account produces, before any switching decision.
   *
   * The kind drives the caller's behaviour, so it must match the reason: a
   * cooldown is its own stop condition, never a sign-out.
   */
  #unavailableFailure(account, verdict) {
    if (verdict.reason === "cooling" || verdict.reason === "cooling-expired") {
      return new MuseFailure(`账号 ${account.label}：${verdict.label}。本次任务结束。`, {
        code: "QUOTA_COOLDOWN",
        kind:
          verdict.cooldown?.reason === "上游限流" ? FAILURE.RATE_LIMITED : FAILURE.QUOTA_EXHAUSTED,
        stage: "select",
      });
    }
    if (verdict.reason === "disabled") {
      return new MuseFailure(`账号 ${account.label} 已停用。`, {
        code: "ACCOUNT_DISABLED",
        kind: FAILURE.INVALID,
        stage: "select",
      });
    }
    return new MuseFailure(`账号 ${account.label}：${verdict.label}。`, {
      code: "ACCOUNT_UNAVAILABLE",
      kind: FAILURE.SIGNED_OUT,
      stage: "select",
    });
  }

  /**
   * The error a task ends with when no account can carry it.
   *
   * The sentence depends on why it ran out, because the two answers send the
   * user to different places: a cooldown needs "wait until it clears", a
   * sign-out needs "log in".
   */
  #exhausted(failure, attempted, verdict) {
    if (
      failure.kind === FAILURE.QUOTA_EXHAUSTED ||
      failure.kind === FAILURE.RATE_LIMITED ||
      verdict?.reason === "cooling" ||
      verdict?.reason === "cooling-expired"
    ) {
      const cooling = verdict?.cooldown;
      const until =
        cooling?.usableUntil === undefined
          ? "恢复时间未知（上游只给了模糊日期）。"
          : `预计 ${new Date(cooling.usableUntil).toLocaleString()} 后可复核。`;
      return new MuseFailure(`${failure.message} ${until} 本次没有提交到其他账号。`, {
        code: "ACCOUNT_COOLING",
        kind: FAILURE.QUOTA_EXHAUSTED,
        stage: failure.stage,
      });
    }
    const needsLogin = attempted
      .map((id) => this.#accounts.get(id))
      .filter((account) => account !== undefined)
      .filter(
        (account) =>
          account.status === ACCOUNT_STATUS.NEEDS_LOGIN || account.status === ACCOUNT_STATUS.NEW,
      );
    const hint =
      needsLogin.length === 0
        ? "没有其他可用账号。"
        : `没有其他可用账号；需要重新登录：${needsLogin
            .map((account) => account.label)
            .join("、")}。请在「设置 → 插件 → Muse 媒体」里登录。`;
    return new MuseFailure(`${failure.message} ${hint}`, {
      code: failure.code,
      kind: failure.kind,
      stage: failure.stage,
    });
  }

  /**
   * Decide whether a cooled account has actually recovered, by reading its usage
   * panel.
   *
   * A cooldown is cleared **only** on positive evidence from the panel:
   *
   *   - the panel read succeeded, and
   *   - it reports a used percentage that is below the cap (i.e. the account is
   *     no longer at the limit).
   *
   * Everything else keeps the cooldown. An unreadable panel is not a licence to
   * send: G5 says an unreadable reset moment stays unknown, and the same logic
   * applies to an unreadable recovery — the safe direction is to wait, because a
   * submit into a live limit spends a request and teaches the user nothing.
   * When the panel *does* name a new reset moment, the cooldown is refreshed with
   * it instead of being dropped.
   */
  /**
   * Clear a cooldown only when the usage panel says it has lifted.
   *
   * A convenience wrapper for callers that hold an account id rather than a
   * record — the settings card's sign-in path. Returns whether the cooldown was
   * lifted; a read failure or a still-limited panel leaves it in place.
   */
  async #clearCooldownOnPanelEvidence(accountId) {
    const account = this.#accounts.get(accountId);
    if (account === undefined) return false;
    if (account.cooldown === undefined || account.cooldown.reason === undefined) return true;
    const config = this.settings();
    try {
      const recovered = await this.#recheckQuotaRecovered(account, config);
      return recovered.ok === true;
    } catch {
      return false;
    }
  }

  async #recheckQuotaRecovered(account, config) {
    /**
     * A rate limit is re-checked against itself, not against the weekly panel.
     *
     * The two are different limits with different recovery moments. Reading the
     * weekly percentage to decide whether a 429 has cleared is a category error
     * that happens to look plausible — a healthy 19% weekly reads as "fine" while
     * the rate limit is still in force (A17).
     *
     * So for a rate-limited account the only evidence that counts is time: an
     * explicit retry instant that has arrived. An unknown instant means the
     * account stays limited until a human clears it.
     */
    if (account.cooldown?.reason === "上游限流") {
      const retryAt = this.#rateLimitRetries.get(account.id) ?? account.cooldown.usableUntil;
      if (retryAt === undefined) {
        return {
          ok: false,
          failure: new MuseFailure(
            `账号 ${account.label} 处于限流冷却，且上游未给出可用的重试时刻，无法确认已恢复。本次任务结束。`,
            { code: "RATE_LIMITED", kind: FAILURE.RATE_LIMITED, stage: "select" },
          ),
        };
      }
      if (Date.now() < retryAt) {
        return {
          ok: false,
          failure: new MuseFailure(
            `账号 ${account.label} 限流冷却未到期（${new Date(retryAt).toLocaleString()} 后可重试）。本次任务结束。`,
            { code: "RATE_LIMITED", kind: FAILURE.RATE_LIMITED, stage: "select" },
          ),
          reset: {
            note: `（限流给出的重试时刻：${new Date(retryAt).toLocaleString()}）`,
            resetAt: retryAt,
            raw: account.cooldown.raw,
          },
        };
      }
      // The named moment has arrived: that *is* the recovery evidence for a 429.
      this.#accounts.update(account.id, { cooldown: null });
      this.#rateLimitRetries.delete(account.id);
      return { ok: true };
    }

    let parsed;
    try {
      parsed = await this.#browser.withPage(
        account.id,
        { visible: !config.headlessAfterLogin, url: THREAD_URL, timeoutMs: 60_000 },
        async (rawPage) => {
          const page = new MusePage(rawPage, this.#log);
          const ready = await page.waitReady({ timeoutMs: 40_000 });
          if (ready !== "ready") return undefined;
          return page.readQuota({ timeoutMs: config.quotaTimeoutSeconds * 1000 });
        },
      );
    } catch {
      parsed = undefined;
    }

    const limitKind =
      account.cooldown?.reason === "上游限流" ? FAILURE.RATE_LIMITED : FAILURE.QUOTA_EXHAUSTED;
    const stillLimited = (note) => ({
      ok: false,
      failure: new MuseFailure(`账号 ${account.label} ${note}，本次任务结束。`, {
        code: limitKind === FAILURE.RATE_LIMITED ? "RATE_LIMITED" : "QUOTA_EXHAUSTED",
        kind: limitKind,
        stage: "select",
      }),
    });

    if (parsed === undefined || parsed.found !== true) {
      return stillLimited("的额度面板读不到，无法确认已恢复");
    }

    // The panel is authoritative: a used percentage that is not pinned at the cap
    // means the limit has lifted. `>= 100` is the exhaustion signal Muse prints.
    const usedPct = typeof parsed.usedPct === "number" ? parsed.usedPct : undefined;
    if (usedPct === undefined) {
      return stillLimited("的额度面板没有给出已用百分比，无法确认已恢复");
    }
    if (usedPct >= 100) {
      const resetAt = parsed.reset === undefined ? undefined : parseResetInstant(parsed.reset);
      this.#accounts.update(
        account.id,
        cooldownPatch({ reason: "本周额度耗尽", resetAt, raw: parsed.reset ?? "（面板仍为 100%）" }),
      );
      return {
        ...stillLimited("的额度仍未恢复"),
        reset: {
          note:
            resetAt === undefined
              ? `（恢复时间未知：面板给的是「${parsed.reset ?? "无"}」）`
              : `（预计 ${new Date(resetAt).toLocaleString()} 后可复核）`,
          resetAt,
          raw: parsed.reset,
        },
      };
    }

    // Recovered: the evidence is the panel, not the clock and not the sign-in.
    this.#accounts.update(account.id, { cooldown: null });
    const at = Date.now();
    this.#quotaCache.set(account.id, {
      quota: { ok: true, usedPct, plan: parsed.plan, reset: parsed.reset, at },
      at,
    });
    this.#accounts.update(account.id, {
      quota: { usedPct, plan: parsed.plan, reset: parsed.reset, at, stale: false, error: undefined },
    });
    return { ok: true, usedPct };
  }

  /** Read the usage panel after a quota stop and record the cooldown. */
  async #recordQuotaCooldown(account, failure, config) {
    let parsed;
    try {
      parsed = await this.#browser.withPage(
        account.id,
        { visible: !config.headlessAfterLogin, url: THREAD_URL, timeoutMs: 60_000 },
        async (rawPage) => {
          const page = new MusePage(rawPage, this.#log);
          const ready = await page.waitReady({ timeoutMs: 40_000 });
          if (ready !== "ready") return undefined;
          return page.readQuota({ timeoutMs: config.quotaTimeoutSeconds * 1000 });
        },
      );
    } catch {
      parsed = undefined;
    }

    // A bare date is not an instant: G5 keeps the verbatim text and reports
    // "恢复时间未知" rather than scheduling a check upstream never named.
    const resetAt = parsed?.reset === undefined ? undefined : parseResetInstant(parsed.reset);
    const raw = parsed?.reset ?? failure.message;
    this.#accounts.update(
      account.id,
      cooldownPatch({
        reason: failure.kind === FAILURE.RATE_LIMITED ? "上游限流" : "本周额度耗尽",
        resetAt,
        raw,
      }),
    );
    if (parsed?.usedPct !== undefined) {
      const at = Date.now();
      this.#quotaCache.set(account.id, {
        quota: { ok: true, usedPct: parsed.usedPct, plan: parsed.plan, reset: parsed.reset, at },
        at,
      });
    }
    return {
      note:
        resetAt === undefined
          ? `（恢复时间未知：面板给的是「${raw}」，没有可用的具体时刻）`
          : `（预计 ${new Date(resetAt).toLocaleString()} 后可复核）`,
      resetAt,
      raw,
    };
  }

  #quotaFailure(failure, account, reset) {
    if (failure.kind === FAILURE.RATE_LIMITED) {
      return new MuseFailure(`${failure.message} 账号 ${account.label} 已标记限流${reset.note}。`, {
        code: failure.code,
        kind: failure.kind,
        stage: failure.stage,
      });
    }
    return new MuseFailure(
      `账号 ${account.label} 本周额度已用完${reset.note}。本次生成结束，页面已释放。`,
      { code: failure.code, kind: failure.kind, stage: failure.stage },
    );
  }

  /* ---------------- probe ---------------- */

  /**
   * The settings card's "测试".
   *
   * Order and clock are both part of A13:
   *
   * - **The deadline starts when the test starts**, not when the page is ready.
   *   G6 says "从测试开始用单调时钟计时" and gives 60 s for the whole test; a
   *   clock that started after account verification would hand the probe extra
   *   time, and one that started after page preparation would report a duration
   *   the user cannot reconcile with the wall clock.
   * - **A signed-out account sends nothing.** That check necessarily precedes
   *   the message, so its cost is charged to the same budget: the probe then
   *   reports a timeout with the stage it reached, which is A13's last row.
   */
  async runProbeFor(accountId) {
    const config = this.settings();
    const account = this.#accounts.get(accountId);
    if (account === undefined) {
      throw new MuseFailure("账号不存在。", { code: "UNKNOWN_ACCOUNT", kind: FAILURE.INVALID });
    }
    /**
     * A probe reuses a running browser and never starts one.
     *
     * The test button exists to answer "is this account working", and that answer
     * is worth a message, not a window. When no browser is up the plugin opens one
     * headless for the duration (below), which is invisible — but if even that is
     * undesirable the user can close the browser and the probe simply reports that
     * it needs one.
     */
    return this.runExclusive(
      `对话测试 ${account.label}`,
      async () => {
        const startedAt = monotonicNow();
        const deadline = startedAt + config.probeTimeoutSeconds * 1000;
        const remainingMs = () => Math.max(0, deadline - monotonicNow());

        const verified = await this.verifyAccount(accountId, {
          visible: false,
          allowLaunch: true,
          timeoutMs: Math.max(1_000, remainingMs()),
        });
        if (!verified.ok) {
          this.#accounts.update(accountId, {
            probe: {
              ok: false,
              note: verified.verdict === "signed-out" ? "登录校验失败，未发送" : "登录状态无法确认，未发送",
              code: "NOT_SENT",
              checkedAt: Date.now(),
              elapsedMs: Math.round(monotonicNow() - startedAt),
            },
          });
          throw new MuseFailure(
            `账号 ${account.label} 登录校验失败（${verified.verdict}），没有发送任何消息。`,
            { code: "PROBE_NOT_SENT", kind: FAILURE.SIGNED_OUT, stage: "probe-auth" },
          );
        }

        const code = mintCode();
        const message = probeMessage(code);
        const outcome = await this.#browser.withPage(
          accountId,
          { visible: false, url: THREAD_URL, timeoutMs: 60_000 },
          async (rawPage) => {
            const page = new MusePage(rawPage, this.#log);
            const ready = await page.waitReady({ timeoutMs: Math.max(1_000, remainingMs()) });
            if (ready !== "ready") {
              throw new MuseFailure(`页面没有就绪（${ready}），未发送。`, {
                code: "PAGE_NOT_READY",
                kind: FAILURE.SHARED,
                stage: "probe",
              });
            }
            /**
             * Never send on an expired budget.
             *
             * Preparation (account check plus page load) can eat the whole 60 s.
             * Sending then would be spending a real message on a test that is
             * already over — A13 requires the deadline to outrank the send, so
             * this reports the timeout with the stage it reached instead.
             */
            if (monotonicNow() >= deadline) {
              return {
                ok: false,
                note: "准备阶段已用完 60 秒预算，未发送",
                code: "PROBE_INCOMPLETE",
                elapsedMs: Math.round(monotonicNow() - startedAt),
                detail: { stage: "prepare-expired" },
              };
            }
            await page.clearComposer({ fresh: true });
            return runProbe({ page, code, message, deadlineAt: deadline, startedAt });
          },
        );

        this.#accounts.update(accountId, {
          probe: {
            ok: outcome.ok === true,
            note: outcome.note,
            code: outcome.code,
            checkedAt: Date.now(),
            elapsedMs: outcome.elapsedMs,
            formatMismatch: outcome.formatMismatch === true,
          },
        });
        return { ...outcome, code, message, accountId, accountLabel: account.label };
      },
      { accountId },
    );
  }

  /* ---------------- settings actions ---------------- */

  /** Everything the settings card renders in one call. */
  snapshot() {
    const config = this.settings();
    const accounts = this.#accounts.list();
    const selectedId = this.#accounts.selectedId;
    const located = locateChrome(config.chromePath);
    // Sweeping here keeps the media directory tidy without its own timer: the card
    // polls the snapshot, and the sweep is a cheap directory read.
    try {
      this.#sweepRefDirs();
    } catch {
      /* housekeeping must not break the snapshot */
    }
    return {
      accounts: accounts.map((account) => {
        const verdict = eligibility(account);
        const cached = this.#quotaCache.get(account.id);
        return {
          ...account,
          usable: verdict.usable,
          usableReason: verdict.label,
          needsRecheck: verdict.needsRecheck,
          running: this.#browser.isRunning(account.id),
          selected: account.id === selectedId,
          quotaLive: cached?.quota,
        };
      }),
      selectedId,
      busy: this.busy,
      /**
       * The composer pill's reading, so it does not need a page-touching route.
       *
       * `account` carries the **reading itself**, not just identity. The client
       * reads `quota.account.quota`, and an id-and-label-only object made that
       * expression undefined — so during a generation, when the pill must show
       * the task's account, it showed nothing even though an 11% reading was
       * sitting in the cache (A4).
       *
       * `duringTask` tells the pill the numbers belong to the task's account
       * rather than the hand-picked one.
       */
      quota: (() => {
        const activeId = this.busy?.accountId ?? selectedId ?? this.#accounts.selected()?.id;
        const active = activeId === undefined ? undefined : this.#accounts.get(activeId);
        return {
          show: config.showQuotaInComposer !== false,
          account:
            active === undefined
              ? undefined
              : {
                  id: active.id,
                  label: active.label,
                  quota: active.quota ?? this.#quotaCache.get(active.id)?.quota,
                },
          accountCount: accounts.length,
          showLabel: accounts.length > 1,
          busy: this.busy === undefined ? undefined : this.busy.label,
          duringTask: this.busy?.accountId !== undefined,
        };
      })(),
      browser: {
        path: located.path,
        source: located.source,
        error: located.path === undefined ? located.error : undefined,
        running: this.#browser.runningAccounts(),
      },
      unsent: this.#tasks.unsettled(),
      /**
       * Recent generations, newest first.
       *
       * Everything here already existed on disk — the task journal records kind,
       * state, account, note and now duration and the allowance either side of the
       * run. Nothing was ever shown, so a user could not see what they had generated,
       * which account paid for it, or what it cost. Capped because this rides in the
       * same snapshot the composer pill polls.
       */
      history: this.#tasks
        .list()
        .filter((task) => task.state === TASK_STATE.DELIVERED || task.state === TASK_STATE.FAILED || task.state === TASK_STATE.UNKNOWN)
        .slice(0, 24)
        .map((task) => ({
          id: task.id,
          kind: task.kind,
          state: task.state,
          account: task.accountLabel,
          at: task.createdAt,
          durationMs: task.durationMs,
          media: task.media === undefined ? undefined : basename(task.media),
          quotaBefore: task.quotaBefore,
          quotaAfter: task.quotaAfter,
          note: task.note,
        })),
      /**
       * The settings a user would otherwise have to edit YAML to change.
       *
       * Fourteen keys existed and none were visible in the UI, so every adjustment —
       * headless or not, how long an idle browser survives, the concurrency ceiling,
       * the generation timeouts — meant editing `cordis.patch.yml` and restarting.
       * Only the ones that make sense for a person to tune are listed; the rest are
       * internal.
       */
      settings: {
        headlessAfterLogin: config.headlessAfterLogin === true,
        idleReapSeconds: config.idleReapSeconds,
        maxLiveBrowsers: config.maxLiveBrowsers,
        autoRefreshQuotaSeconds: config.autoRefreshQuotaSeconds,
        imageTimeoutSeconds: config.imageTimeoutSeconds,
        videoTimeoutSeconds: config.videoTimeoutSeconds,
        maxAccountsPerTask: config.maxAccountsPerTask,
        showQuotaInComposer: config.showQuotaInComposer !== false,
      },
      /** What the settings page cannot derive from the snapshot's other fields. */
      diagnostics: {
        stateRoot: this.#paths.root,
        taskCount: this.#tasks.list().length,
        mediaCount: this.#mediaCount(),
        browserRunning: this.#browser.runningAccounts().length,
        chromeSource: located.source,
        chromeConfigured: config.chromePath !== "" && config.chromePath !== undefined,
      },
      /**
       * Profile sizes, from the cache — never a synchronous disk walk.
       *
       * `snapshot()` is served to the composer pill every 45 seconds, and the walk
       * behind this figure measured 608 ms for 2136 files. Paying that on the Host
       * main thread, repeatedly, for a settings-page number was pure cost. The
       * cached reading is refreshed in the background instead; `undefined` on the
       * very first call, which the client renders as "computing".
       */
      profileBytes: this.#browser.cachedProfileSizes(),
      mediaBytes: this.#mediaBytes(),
      mediaDir: this.mediaDir(),
      paths: { root: this.#paths.root, profiles: this.#paths.profiles },
    };
  }

  addAccount(label) {
    const account = this.#accounts.add(label);
    return { account, snapshot: this.snapshot() };
  }

  async removeAccount(accountId) {
    if (this.busy !== undefined) {
      throw new MuseFailure("页面正被一个任务占用，请等它结束。", {
        code: "BUSY",
        kind: FAILURE.INVALID,
      });
    }
    const account = this.#accounts.get(accountId);
    if (account === undefined) {
      throw new MuseFailure("账号不存在。", { code: "UNKNOWN_ACCOUNT", kind: FAILURE.INVALID });
    }
    await this.#browser.close(accountId, { reason: "删除账号" }).catch(() => {});
    /**
     * The profile must be gone before the account row disappears.
     *
     * Removing the row while `removeProfile` had failed left a ~130 MB directory
     * on disk that nothing could reach any more: the settings card lists accounts,
     * so no entry remained to trigger a cleanup, while `profileBytes` kept
     * reporting the orphan. The order below is what prevents that — if the
     * directory cannot be deleted, the account stays and the caller is told why.
     */
    const removedFiles = this.#paths.removeProfile(accountId);
    if (!removedFiles) {
      throw new MuseFailure(
        `账号 ${account.label} 的浏览器数据目录删不掉（可能仍被占用）。请关闭它的浏览器后重试，账号未删除。`,
        { code: "PROFILE_REMOVE_FAILED", kind: FAILURE.SHARED, stage: "remove" },
      );
    }
    this.#accounts.remove(accountId);
    this.#quotaCache.delete(accountId);
    this.#rateLimitRetries.delete(accountId);
    void this.#refreshSizeCaches();
    return { removed: true, removedFiles, snapshot: this.snapshot() };
  }

  selectAccount(accountId) {
    if (!this.#accounts.select(accountId)) {
      throw new MuseFailure("账号不存在。", { code: "UNKNOWN_ACCOUNT", kind: FAILURE.INVALID });
    }
    return this.snapshot();
  }

  /**
   * Open a visible sign-in window and report promptly.
   *
   * It must not block the HTTP request for the whole sign-in: a person may take
   * minutes, and a route that waits that long reads as a hung card. So it waits
   * only briefly — long enough to catch a profile that already holds a valid
   * session — then returns `waiting`, and the card polls `verify` while the user
   * finishes. `verify` is the same authenticated check either way.
   */
  async loginAccount(accountId, { waitSeconds = 10 } = {}) {
    const account = this.#accounts.get(accountId);
    if (account === undefined) {
      throw new MuseFailure("账号不存在。", { code: "UNKNOWN_ACCOUNT", kind: FAILURE.INVALID });
    }
    await this.#browser.openVisible(accountId, "https://muse.ai/");
    this.#accounts.update(accountId, { lastLoginAt: Date.now() });

    const deadline = Date.now() + Math.max(3, Math.min(waitSeconds, 30)) * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // Stop the moment the window is gone: a person who closed it abandoned the
      // sign-in, and a poll that kept calling `withPage` would silently launch a
      // fresh browser that looks like the plugin refusing to quit.
      if (!this.#browser.isRunning(accountId)) {
        return {
          ok: false,
          verdict: "closed",
          note: "登录窗口已关闭。需要时可以再点「打开登录窗口」。",
          snapshot: this.snapshot(),
        };
      }
      let verdict;
      try {
        verdict = await this.#browser.withPage(
          accountId,
          { visible: true, url: "https://muse.ai/", timeoutMs: 20_000 },
          async (rawPage) => new MusePage(rawPage, this.#log).checkSession(),
        );
      } catch {
        continue;
      }
      if (verdict.verdict === "signed-in") {
        /**
         * A sign-in proves the session, not the quota — here too.
         *
         * This used to clear any cooldown on a passing check, on the reasoning
         * that the user was standing at the window and had just re-authenticated.
         * Measurement says otherwise: pressing "open sign-in window" on an
         * already-signed-in account cleared a cooldown that had not expired, with
         * **zero** panel reads. A session check is not evidence about a limit, so
         * the same rule as the generation entry applies — a cooldown is lifted
         * only by a panel read that shows usage below the cap.
         */
        this.#accounts.update(accountId, {
          status: ACCOUNT_STATUS.READY,
          statusReason: undefined,
          verifiedAt: Date.now(),
        });
        const cleared = await this.#clearCooldownOnPanelEvidence(accountId);
        return {
          ok: true,
          verdict: "signed-in",
          cooldownCleared: cleared,
          snapshot: this.snapshot(),
        };
      }
    }
    return {
      ok: false,
      verdict: "waiting",
      note: "登录窗口已经打开。在窗口里完成登录后，点「验证登录」，或等设置卡自动检测。",
      snapshot: this.snapshot(),
    };
  }

  async quitBrowser(accountId) {
    const closed = await this.#browser.close(accountId, { reason: "用户在设置卡里关闭" });
    return { closed, snapshot: this.snapshot() };
  }

  /**
   * Delete every delivered media file, because the user asked to.
   *
   * Deliberately the only code path that removes media. The files are the product
   * of paid generations and are linked from past conversation messages, so the
   * decision belongs to whoever owns the disk and knows what they still want.
   *
   * **This breaks old links.** A conversation message whose player pointed at a
   * cleared file will report it missing, which is the honest outcome of deleting
   * the file; the count is returned so the settings card can say what happened
   * rather than just emptying the figure.
   */
  clearMedia() {
    const dir = this.mediaDir();
    let removed = 0;
    let bytes = 0;
    let failed = 0;
    let why;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Reference scratch directories are per-task and carry nothing the user
          // asked to keep, so they go with the clear.
          if (entry.name.startsWith("refs-")) {
            try {
              rmSync(full, { recursive: true, force: true });
              removed += 1;
            } catch {
              failed += 1;
            }
          }
          continue;
        }
        try {
          const size = statSync(full).size;
          rmSync(full, { force: true });
          bytes += size;
          removed += 1;
        } catch (error) {
          /**
           * A file that will not delete is reported, not hidden.
           *
           * The earlier shape swallowed every error and returned the same `0` for
           * "nothing to delete" and "deletion is broken" — so a user pressing the
           * button saw no change and no reason. Those are different answers and
           * only one of them needs action.
           */
          failed += 1;
          why ??= error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      why ??= error instanceof Error ? error.message : String(error);
      this.#log(`清空媒体目录失败：${why}`);
      return { ok: false, removed, bytes, failed, error: why, snapshot: this.snapshot() };
    }
    this.#mediaBytesCache = undefined;
    /**
     * Recompute the figure synchronously after a clear.
     *
     * The periodic refresh is async, so leaving the cache empty would make the
     * card show "computing" right after the user cleared — the one moment the number
     * matters most. Walking the (now small) directory here is cheap, and if anything
     * survived the deletion it is counted rather than assumed gone.
     */
    try {
      let remaining = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try {
          remaining += statSync(join(dir, entry.name)).size;
        } catch {
          /* gone between the two walks */
        }
      }
      this.#mediaBytesCache = remaining;
    } catch {
      this.#mediaBytesCache = 0;
    }
    this.#log(`已清空媒体目录：删除 ${removed} 项，释放 ${Math.round(bytes / 1024)} KB${failed > 0 ? `，${failed} 项未删除` : ""}`);
    return { ok: failed === 0, removed, bytes, failed, error: why, snapshot: this.snapshot() };
  }

  /**
   * Background quota refresh.
   *
   * The pill must show a live number without the user pressing anything (G2's
   * whole point), and it must never be the reason a window appears. Those two
   * requirements meet here:
   *
   *   - the timer wakes on its own interval and refreshes the *selected* account
   *     while the page is idle;
   *   - it passes `allowLaunch: false`, so a read happens only when a browser is
   *     already running. A quota readout is not worth opening a window for.
   *
   * A generation that just finished leaves its browser up for the idle window, so
   * the number right after a generation is the fresh one. With no browser at all
   * the pill keeps the last value and says it is waiting for the next generation,
   * which is exactly true.
   *
   * Every failure is swallowed: this is maintenance, and a failed background read
   * must not surface as an error the user has to dismiss.
   */
  #quotaRefreshTimer;
  /** Refreshes the profile/media size caches off the request path. */
  #sizeCacheTimer;

  maintain() {
    const stopReaper = this.#browser.startIdleReaper();
    /**
     * Reap browsers left behind by a previous Host process.
     *
     * A crash or force-quit skips `closeAll`, and the in-memory map starts empty
     * next launch — so the next `open` would start a second browser on the same
     * profile while the first keeps its memory. Doing this once at startup is what
     * keeps that from accumulating across restarts.
     */
    void this.#browser.reapOrphans().catch(() => {});
    // Prime the size caches once, then keep them warm off the main thread.
    void this.#refreshSizeCaches();
    if (this.#sizeCacheTimer === undefined) {
      const timer = setInterval(() => void this.#refreshSizeCaches(), 10 * 60_000);
      timer.unref?.();
      this.#sizeCacheTimer = timer;
    }
    if (this.#quotaRefreshTimer !== undefined) return stopReaper;

    const tick = () => {
      void (async () => {
        const config = this.settings();
        if (config.autoRefreshQuotaSeconds <= 0) return;
        // Never fight a task for the page; the task's own completion refreshes.
        if (this.busy !== undefined) return;
        const account =
          this.#accounts.selectedId === undefined
            ? this.#accounts.selected()
            : this.#accounts.get(this.#accounts.selectedId);
        if (account === undefined) return;
        if (account.status !== ACCOUNT_STATUS.READY) return;
        try {
          /**
           * Go through the queue, not around it.
           *
           * Checking `busy` and then calling `readQuota` directly leaves a window:
           * a task can start between the check and the read, and then two page
           * operations overlap (A20). `runExclusive` serialises it, and the busy
           * check above stays as a cheap early exit so an idle timer does not
           * queue work behind a long generation.
           */
          await this.readQuota(account.id, { force: true, allowLaunch: false });
        } catch {
          /* background maintenance: a failed read is not user-visible */
        }
      })();
    };

    const seconds = Number(this.settings().autoRefreshQuotaSeconds);
    const intervalMs = Math.max(30, Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    this.#quotaRefreshTimer = timer;

    return () => {
      stopReaper?.();
      if (this.#quotaRefreshTimer !== undefined) {
        clearInterval(this.#quotaRefreshTimer);
        this.#quotaRefreshTimer = undefined;
      }
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const IMAGE_SIZE = ["1:1", "16:9", "9:16", "4:3", "3:4"];

/**
 * How many reference images a tool call may carry.
 *
 * Neither is a Muse limit. The composer's file input is `multiple` with no `accept`
 * filter, ten staged uploads were accepted without a warning, and no count guard
 * exists in the client bundles. These ceilings only stop a mistaken multi-hundred
 * upload from hammering the page, so they are set well above anything useful.
 */
const MAX_IMAGE_REFERENCES = 10;
const MAX_VIDEO_REFERENCES = 10;

function normalizeImageArgument(value) {
  if (value === undefined || value === null) return undefined;
  /**
   * Tolerate a JSON-encoded array.
   *
   * The host's argument layer can hand a list through as text when a schema
   * declares more than one possible type — which is what produced "cannot read
   * reference 1" for a two-image call whose array was valid. Accepting the encoded
   * form keeps one delivery quirk from costing a generation.
   */
  let source = value;
  if (typeof source === "string" && source.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) source = parsed;
    } catch {
      /* not JSON; treat it as a plain path below */
    }
  }
  const list = Array.isArray(source) ? source : [source];
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new MuseFailure("image 的每一项都必须是非空字符串。", {
        code: "INVALID_ARGS",
        kind: FAILURE.INVALID,
      });
    }
    out.push(entry.trim());
  }
  return out.length === 0 ? undefined : out;
}

/**
 * Worst-case wall clock for one generation, derived from the stages it runs.
 *
 * A tool's `timeoutMs` is the Host's own limit: when it expires the Host stops
 * waiting and reports a timeout to the model, while this plugin is still working
 * — the browser keeps running, the queue stays held, and the task record sits at
 * `possibly-sent`. The user reads "timed out" and resubmits, which is the
 * duplicate-charge case the send journal exists to prevent.
 *
 * The numbers were also inconsistent: the image tool declared 360 s while its own
 * stages can take 60 (page) + 45 (ready) + 90 (quota) + 60 (delivery) + 300
 * (media) = 555 s, and video declared 840 s against 1035 s. So a slow-but-succeeding
 * generation was guaranteed to be reported as a timeout.
 *
 * The host budget is therefore computed, never guessed: every stage the attempt
 * can spend time in, plus the slack needed to record the result. `SLACK_MS` covers
 * the reference upload, the send action and the journal writes.
 */
function generationBudget(config, kind) {
  const SPEC = {
    /** Opening the page and waiting for the composer. */
    pageMs: 60_000,
    readyMs: 45_000,
    /** A quota read may happen inside the attempt (cooldown re-check). */
    quotaSeconds: Number(config?.quotaTimeoutSeconds ?? 90),
    /** The delivery confirmation window. */
    deliverySeconds: Number(config?.deliveryUnknownSeconds ?? 60),
    mediaSeconds: Number(
      kind === "video"
        ? (config?.videoTimeoutSeconds ?? 780)
        : (config?.imageTimeoutSeconds ?? 300),
    ),
    slackMs: 60_000,
  };
  return (
    SPEC.pageMs + SPEC.readyMs + SPEC.quotaSeconds * 1000 + SPEC.deliverySeconds * 1000 + SPEC.mediaSeconds * 1000 + SPEC.slackMs
  );
}

/**
 * How long a tool may wait, given the runtime's current settings.
 *
 * Read at call time rather than captured in the tool object: `timeoutMs` is a
 * static property, so it is computed from the settings in force when the tool is
 * registered, and the registration follows a settings change.
 */
function toolTimeout(runtime, kind) {
  return generationBudget(runtime.settings(), kind);
}

function imageTool(runtime) {
  return {
    name: "muse_draw_image",
    description:
      "用你自己的一个 Muse 账号生成一张图片（文生图；传 image 就是带参考图的图生图）。" +
      "插件通过 CDP 驱动本机 Chrome 操作 muse.ai 网页，每次生成真实消耗该账号的免费周额度。" +
      "生成要几十秒，工具会一直等到出图或失败；同一个提示词两次的结果不同（上游没有种子）。" +
      "结果图片直接显示在对话里，不需要再调用 read_image 之类的工具去确认。" +
      "\n\n" +
      "边界：这是 Muse 自己的生图工具，只消耗 Muse 账号的额度，不影响也不调用其他已安装的生图插件。" +
      "如果你要的不是 Muse，或者用户点名了别的服务，请用那个服务的工具，不要用这个。" +
      "同一类工具存在多个时，由用户或会话决定用哪个；这个插件不提供全局默认工具设置。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "画面描述。写清主体、风格、构图、光线；中文或英文都可以。",
        },
        size: {
          type: "string",
          enum: IMAGE_SIZE,
          description: `画幅提示，默认 1:1。可选 ${IMAGE_SIZE.join(" / ")}；上游不保证严格遵循。`,
        },
        image: {
          type: ["string", "array"],
          items: { type: "string" },
          description:
            `参考图，可选，最多 ${MAX_IMAGE_REFERENCES} 张（传数组）。接受本机绝对路径、file:// URL、data URL，` +
            "或对话里附件的 attachmentId（sha256:…）。提交前会确认每一张都上传完成；少一张就不提交。",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          attachment: {
            type: "object",
            additionalProperties: false,
            properties: {
              attachmentId: { type: "string" },
              mediaType: { type: "string" },
              bytes: { type: "integer" },
              width: { type: "integer" },
              height: { type: "integer" },
              name: { type: "string" },
            },
          },
          width: { type: "integer" },
          height: { type: "integer" },
          mime: { type: "string" },
          bytes: { type: "integer" },
          taskId: { type: "string" },
          account: { type: "string" },
          accountReason: { type: "string" },
          sentAction: { type: "string" },
          deliveryEvidence: { type: "string" },
          attachmentCount: { type: "integer" },
          seconds: { type: "number" },
        },
        required: ["mime", "bytes", "taskId", "account"],
        additionalProperties: false,
      },
      render(_args, raw) {
        const value = asRecord(raw);
        const blocks = [
          {
            type: "text",
            text:
              `Muse 出图 · ${String(value.width ?? "?")}×${String(value.height ?? "?")} · ` +
              `账号 ${String(value.account ?? "?")} · ${String(value.seconds ?? "?")} 秒 · ` +
              `任务 ${String(value.taskId ?? "?")}` +
              (value.accountReason === undefined ? "" : `\n${String(value.accountReason)}`),
          },
        ];
        if (asRecord(value.attachment).attachmentId !== undefined) {
          blocks.push({ type: "image", attachment: value.attachment });
        }
        return blocks;
      },
    },
    // Computed from the stages this tool actually runs, so the Host never gives up
    // before the plugin does. See `generationBudget`.
    timeoutMs: toolTimeout(runtime, "image"),
    async execute(args) {
      const record = asRecord(args);
      const startedAt = Date.now();
      const size = nonEmpty(record.size) ?? "1:1";
      if (!IMAGE_SIZE.includes(size)) {
        throw new MuseFailure(`size 只接受 ${IMAGE_SIZE.join(" / ")}，收到 "${size}"。`, {
          code: "INVALID_ARGS",
          kind: FAILURE.INVALID,
        });
      }
      const references = normalizeImageArgument(record.image);
      // Muse's chat surface has no aspect control, so the size rides in the
      // prompt as an explicit instruction rather than being silently dropped.
      const prompt =
        size === "1:1"
          ? String(record.prompt)
          : `${String(record.prompt)}\n\n(Preferred aspect ratio: ${size})`;

      const result = await runtime.runMediaTask({ kind: "image", prompt, references });
      const seconds = (Date.now() - startedAt) / 1000;
      const attachment = await runtime.persistImage(result, size);
      return {
        attachment,
        width: result.media.width,
        height: result.media.height,
        mime: result.mime,
        bytes: result.bytes,
        taskId: result.taskId,
        account: result.account.label,
        accountReason: result.accountReason,
        sentAction: result.sentAction,
        deliveryEvidence: result.deliveryEvidence,
        attachmentCount: result.attachmentCount ?? 0,
        seconds,
      };
    },
  };
}

function videoTool(runtime) {
  return {
    name: "muse_draw_video",
    description:
      "用你自己 Muse 账号的额度生成一段短视频（文生视频；传 image 就是带参考图的图生视频）。" +
      "Muse 没有独立的视频模式：界面上只有一个对话框，「生成视频」这件事完全靠提示词表达，" +
      "所以时长、镜头、动作都要写进 prompt。" +
      "多张参考图可以上传（Muse 的附件入口本身不限数量），但上游如何解读并不公开：" +
      "第一张会被当作起始画面，其余是否作为风格或主体参考无法保证——重要的一致性要求请写进 prompt。" +
      "插件通过 CDP 驱动本机 Chrome 操作 muse.ai 网页，每次生成真实消耗该账号的免费周额度。" +
      "视频要几分钟起步，工具会一直等到出片或失败；不要因为慢就重复提交。" +
      "成品是可播放的 MP4，在对话里用播放器打开。" +
      "\n\n" +
      "边界：这是 Muse 自己的视频工具，只消耗 Muse 账号的额度。" +
      "同一类工具存在多个时，由用户或会话决定用哪个；这个插件不提供全局默认工具设置。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "画面描述。写清主体、动作、镜头与光线；时长也写在这里。",
        },
        image: {
          /**
           * A string or an array of strings.
           *
           * The host validates arguments against this schema before the tool runs,
           * and it normalises `anyOf` by picking the first branch — which turned a
           * two-image array into its JSON text, so a valid call failed as "cannot
           * read reference 1". The image tool's spelling (`type: [...]` with
           * `items`) is the one that survives, so video uses the same.
           */
          type: ["string", "array"],
          items: { type: "string" },
          description:
            "参考图，可选，可以是一张或多张（传数组）。第一张作为起始画面；多传的图会一并上传，但上游是否把它们当作参考无法保证。" +
            "接受本机绝对路径、file:// URL、data URL，或对话里附件的 attachmentId（sha256:…）。" +
            "提交前确认上传完成；上传未确认就不提交。",
        },
        size: {
          type: "string",
          enum: IMAGE_SIZE,
          description: "画幅提示，默认 16:9；上游不保证严格遵循。",
        },
        seconds: {
          type: "number",
          description: "期望时长（秒），可选。作为提示词的一部分提交，上游可能不遵循。",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "同一 Host 下的播放地址。" },
          path: { type: "string", description: "磁盘上的 MP4 绝对路径。" },
          name: { type: "string" },
          bytes: { type: "integer" },
          mime: { type: "string" },
          width: { type: "integer" },
          height: { type: "integer" },
          taskId: { type: "string" },
          account: { type: "string" },
          accountReason: { type: "string" },
          sentAction: { type: "string" },
          deliveryEvidence: { type: "string" },
          firstFrame: { type: "string" },
          seconds: { type: "number" },
        },
        required: ["url", "path", "name", "bytes", "taskId", "account"],
        additionalProperties: false,
      },
      render(_args, raw) {
        const value = asRecord(raw);
        const lines = [
          `Muse 出视频 · ${String(value.name ?? "?")} · 账号 ${String(value.account ?? "?")} · ` +
            `${String(value.seconds ?? "?")} 秒 · 任务 ${String(value.taskId ?? "?")}`,
          `文件：${String(value.path ?? "")}`,
          `播放：${String(value.url ?? "")}`,
        ];
        // Why this account took the task: the choice follows the soonest-expiring
        // allowance, so it may not be the highlighted account.
        if (value.accountReason !== undefined) lines.push(`选号：${String(value.accountReason)}`);
        if (value.firstFrame !== undefined) lines.splice(2, 0, `首帧证据：${String(value.firstFrame)}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    // See `generationBudget`: video spends far longer in the media wait.
    timeoutMs: toolTimeout(runtime, "video"),
    async execute(args) {
      const record = asRecord(args);
      const startedAt = Date.now();
      const seconds = record.seconds;
      if (seconds !== undefined && seconds !== null) {
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
          throw new MuseFailure("seconds 必须是正数。", { code: "INVALID_ARGS", kind: FAILURE.INVALID });
        }
      }
      const size = nonEmpty(record.size) ?? "16:9";
      const hints = [];
      if (size !== "16:9") hints.push(`Preferred aspect ratio: ${size}`);
      if (typeof seconds === "number") hints.push(`Target duration: ${Math.round(seconds)} seconds`);
      const prompt =
        hints.length === 0 ? String(record.prompt) : `${String(record.prompt)}\n\n(${hints.join("; ")})`;

      const result = await runtime.runMediaTask({
        kind: "video",
        prompt,
        // Several references are allowed, matching what the composer accepts. The
        // first is the starting frame; what Muse does with the rest is undocumented.
        references: normalizeImageArgument(record.image),
      });
      const elapsed = (Date.now() - startedAt) / 1000;
      return {
        url: runtime.mediaUrl(result.name),
        path: result.path,
        name: result.name,
        bytes: result.bytes,
        mime: result.mime,
        width: result.media.width,
        height: result.media.height,
        taskId: result.taskId,
        account: result.account.label,
        accountReason: result.accountReason,
        sentAction: result.sentAction,
        deliveryEvidence: result.deliveryEvidence,
        /**
         * What the evidence actually establishes, stated without overclaiming.
         *
         * Two facts exist and they are not the same. The upload was confirmed on
         * our side (`uploadCount`), and the shell renders `attachmentCount`
         * attachment nodes in the sent message — measured as 0 even when the
         * delivered video's first frame IS the submitted image, because Muse
         * consumes a frame upload as input without displaying it. So the honest
         * sentence separates "the file reached the page" from "the pictures are
         * visible in the thread", and leaves the visual check to the person
         * watching the clip.
         *
         * With several references the wording also has to avoid implying that all
         * of them shape the result: Muse does not document what extra images mean
         * for a video, and only the first is known to act as the starting frame.
         */
        firstFrame:
          result.requestedAttachments === 0
            ? "本次没有提供参考图"
            : `上传已确认 ${result.uploadCount ?? 0}/${result.requestedAttachments}；` +
              (result.requestedAttachments > 1
                ? "多张参考图的第一张作为起始画面，其余是否被采用无法保证；"
                : "") +
              (result.attachmentCount === undefined
                ? "消息附件未读到；请打开成片核对首个可见画面"
                : `消息渲染 ${result.attachmentCount} 个；请打开成片核对首个可见画面`),
        seconds: elapsed,
      };
    },
  };
}

function quotaTool(runtime) {
  return {
    name: "muse_quota",
    description:
      "查 Muse 账号的免费周额度：计划名、本周已用百分比、下次重置时间（另附独立的额外额度）。" +
      "这个数字只属于 Muse：其他已安装的生图或视频插件各有自己的额度，不受它影响。" +
      "这个查询会真实打开上游的额度面板，几十秒，但不消耗生成额度。" +
      "想知道「还能不能继续生图/生视频」时用它，不要每一轮都查。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: "object",
        properties: {
          account: { type: "string" },
          plan: { type: "string" },
          usedPct: { type: "number" },
          /** Names what `usedPct` measures; always the free weekly allowance. */
          usedPctScope: { type: "string", enum: ["weekly"] },
          reset: { type: "string" },
          /** The extra allowance's own percentage, reported separately. */
          extraUsedPct: { type: "number" },
          extraLeft: { type: "string" },
          stale: { type: "boolean" },
          summary: { type: "string" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      render(_args, raw) {
        const value = asRecord(raw);
        return [{ type: "text", text: `**Muse 额度** · ${String(value.summary ?? "未读到额度")}` }];
      },
    },
    timeoutMs: 120_000,
    async execute() {
      const account = runtime.preferredAccount();
      const view = await runtime.quotaView({ accountId: account.id, force: false });
      /**
       * Two budgets, two sentences.
       *
       * Muse reports the free weekly allowance and a separate extra allowance
       * that never expires. The weekly figure is what a generation consumes
       * first, so it leads and is labelled as such; the extra one is stated
       * beside it, never summed into it. Merging them would answer the wrong
       * question — "how much do I have left overall" instead of "how much of this
       * week's allowance is spent".
       */
      const parts = [];
      if (view.plan !== undefined) parts.push(view.plan);
      if (view.usedPct !== undefined) parts.push(`本周免费额度已用 ${view.usedPct}%`);
      if (view.reset !== undefined) parts.push(`下次重置 ${view.reset}`);
      if (view.extraUsedPct !== undefined || view.extraLeft !== undefined) {
        const extra = [];
        if (view.extraUsedPct !== undefined) extra.push(`已用 ${view.extraUsedPct}%`);
        if (view.extraLeft !== undefined) extra.push(view.extraLeft);
        parts.push(`额外额度（独立计数）${extra.join("，")}`);
      } else if (view.extraExpires === "never") {
        parts.push("额外额度：从不过期（未读到数值）");
      }
      if (view.stale === true) parts.push("（上次成功值，读取失败）");
      return {
        account: account.label,
        ...(view.plan === undefined ? {} : { plan: view.plan }),
        ...(view.usedPct === undefined ? {} : { usedPct: view.usedPct }),
        /** Names what `usedPct` measures: the free weekly allowance. */
        ...(view.usedPct === undefined ? {} : { usedPctScope: view.scope ?? "weekly" }),
        ...(view.reset === undefined ? {} : { reset: view.reset }),
        ...(view.extraUsedPct === undefined ? {} : { extraUsedPct: view.extraUsedPct }),
        ...(view.extraLeft === undefined ? {} : { extraLeft: view.extraLeft }),
        ...(view.stale === undefined ? {} : { stale: view.stale }),
        summary:
          parts.length === 0
            ? `上游没有返回可读额度（${view.reason ?? view.error ?? "未知"}）`
            : parts.join(" · "),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

export const inject = ["tools"];

export function apply(ctx, config) {
  const getConfig = () => (typeof config?.get === "function" ? config.get() : config);
  const log = (message) => {
    try {
      ctx.logger?.info?.(`dsh-muse-media: ${message}`);
    } catch {
      /* logging must never take the plugin down */
    }
  };

  let runtime;
  try {
    runtime = new MuseRuntime({ getConfig, log });
  } catch (error) {
    log(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // Services are read through `ctx.get(name)`, never the `ctx.<name>` property:
  // Cordis throws on an undeclared service property at activation, so probing
  // the property would fail the mount in a Host that lists the service only as
  // optional. `get` answers `undefined` instead.
  const bindAttachments = (hostCtx) => {
    const service = hostCtx.get("attachments");
    if (service === undefined) return;
    runtime.setAttachments(service);
  };

  /**
   * Wire the settings editor when the Host has one.
   *
   * Optional on purpose: `configEditor` is a Host capability, and a build without it
   * should leave the settings section read-only instead of failing the mount.
   */
  const bindConfigEditor = (hostCtx) => {
    const service = hostCtx.get("configEditor");
    if (service === undefined || typeof service.edit !== "function") return;
    runtime.setConfigEditor(service);
  };

  /* ---- tools ---- */
  const definitions = [imageTool(runtime), videoTool(runtime), quotaTool(runtime)];
  const mountTools = (toolsCtx) => {
    const registry = toolsCtx.get("tools");
    if (registry === undefined || typeof registry.register !== "function") return;
    for (const definition of definitions) {
      try {
        const dispose = registry.register(definition);
        toolsCtx.effect(() => () => {
          try {
            dispose?.();
          } catch {
            /* ignore */
          }
        });
      } catch (error) {
        log(`工具 ${definition.name} 注册失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  if (ctx.get("tools") !== undefined) mountTools(ctx);
  else ctx.inject(["tools"], (toolsCtx) => mountTools(toolsCtx));

  if (ctx.get("attachments") !== undefined) bindAttachments(ctx);
  else ctx.inject(["attachments"], (hostCtx) => bindAttachments(hostCtx));

  // `configEditor` is optional: the settings section stays read-only without it.
  if (ctx.get("configEditor") !== undefined) bindConfigEditor(ctx);
  else ctx.inject(["configEditor"], (hostCtx) => bindConfigEditor(hostCtx));

  /* ---- routes ---- */
  const registerRoutes = (webCtx) => {
    const server = webCtx.get("webServer");
    if (server === undefined || typeof server.register !== "function") return;

    webCtx.effect(() => {
      const disposers = [];

      // A8 verbatim: loopback answers, everything else 403. The pill does not
      // call this route (it reads /accounts), so a LAN-only bind loses nothing
      // but this endpoint.
      disposers.push(
        server.register({
          kind: "exact",
          path: QUOTA_PATH,
          handler: async (req, res) => {
            if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
            const allowed = loopbackRequest(req);
            if (!allowed.ok) return json(res, 403, { error: allowed.reason });
            try {
              const url = new URL(req.url ?? "/", "http://127.0.0.1");
              const force = url.searchParams.get("force") === "1";
              const accountId = nonEmpty(url.searchParams.get("account") ?? undefined);
              json(res, 200, await runtime.quotaView({ accountId, force }));
            } catch (error) {
              json(res, 200, {
                ok: false,
                status: "error",
                show: runtime.settings().showQuotaInComposer !== false,
                text: "待刷新",
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }),
      );

      // Media playback: token-named files only, and only for this machine.
      disposers.push(
        server.register({
          kind: "prefix",
          path: MEDIA_ROUTE,
          handler: async (req, res) => {
            const allowed = sameMachineRequest(req);
            if (!allowed.ok) return json(res, 403, { error: allowed.reason });
            if (req.method !== "GET" && req.method !== "HEAD") {
              return json(res, 405, { error: "method not allowed" });
            }
            // Strip the route, then tolerate one leading slash: the matcher
            // accepts both `/media/<file>` and the bare `/media`, and a client
            // may also send the encoded form. `basename` then rejects anything
            // that still looks like a path.
            const pathname = String(req.url ?? "").split("?")[0];
            let raw = pathname.startsWith(MEDIA_PREFIX)
              ? pathname.slice(MEDIA_PREFIX.length)
              : pathname.slice(MEDIA_ROUTE.length).replace(/^\/+/, "");
            try {
              raw = decodeURIComponent(raw);
            } catch {
              return json(res, 400, { error: "bad name" });
            }
            const name = basename(raw);
            if (name === "" || name !== raw || name.includes("..")) {
              return json(res, 400, { error: "bad name" });
            }
            const file = join(runtime.mediaDir(), name);
            if (!existsSync(file)) return json(res, 404, { error: "not found" });
            let size;
            try {
              size = statSync(file).size;
            } catch {
              return json(res, 404, { error: "not found" });
            }
            res.statusCode = 200;
            res.setHeader("content-type", MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream");
            res.setHeader("content-length", String(size));
            res.setHeader("accept-ranges", "none");
            res.setHeader("cache-control", "private, max-age=300");
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            await new Promise((resolve) => {
              const stream = createReadStream(file);
              stream.on("error", () => {
                res.destroy();
                resolve();
              });
              stream.on("end", resolve);
              res.on("close", resolve);
              stream.pipe(res);
            });
          },
        }),
      );

      const gate = (req, res) => {
        const allowed = sameMachineRequest(req);
        if (!allowed.ok) {
          json(res, 403, { error: allowed.reason });
          return false;
        }
        return true;
      };

      disposers.push(
        server.register({
          kind: "exact",
          path: ACCOUNTS_PATH,
          handler: async (req, res) => {
            if (!gate(req, res)) return;
            if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
            try {
              json(res, 200, runtime.snapshot());
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      );

      disposers.push(
        server.register({
          kind: "exact",
          path: ACCOUNTS_ACTION_PATH,
          handler: async (req, res) => {
            if (!gate(req, res)) return;
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            let body;
            try {
              body = await readBody(req);
            } catch (error) {
              return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
            }
            const action = nonEmpty(asRecord(body).action);
            const accountId = nonEmpty(asRecord(body).accountId);
            try {
              switch (action) {
                case "add":
                  return json(res, 200, runtime.addAccount(asRecord(body).label));
                case "remove":
                  return json(res, 200, await runtime.removeAccount(accountId));
                case "select":
                  return json(res, 200, runtime.selectAccount(accountId));
                case "login":
                  return json(res, 200, await runtime.loginAccount(accountId));
                case "verify": {
                  if (runtime.busy !== undefined) {
                    throw new MuseFailure("页面正被一个任务占用，请等它结束。", {
                      code: "BUSY",
                      kind: FAILURE.INVALID,
                    });
                  }
                  // `verify` is the card's watcher: it must never be the reason a
                  // browser starts, or closing the sign-in window would spawn a
                  // hidden replacement.
                  const verified = await runtime.runExclusive(
                    `验证登录 ${accountId}`,
                    () =>
                      runtime.verifyAccount(accountId, {
                        visible: !runtime.settings().headlessAfterLogin,
                        allowLaunch: false,
                      }),
                    { accountId },
                  );
                  return json(res, 200, { ...verified, snapshot: runtime.snapshot() });
                }
                case "probe": {
                  if (runtime.busy !== undefined) {
                    throw new MuseFailure("页面正被一个任务占用，请等它结束。", {
                      code: "BUSY",
                      kind: FAILURE.INVALID,
                    });
                  }
                  const outcome = await runtime.runProbeFor(accountId);
                  return json(res, 200, { ...outcome, snapshot: runtime.snapshot() });
                }
                case "refresh-quota": {
                  // A manual read from the card is still a background read: it
                  // refreshes the number, it does not summon a window.
                  const quota = await runtime.readQuota(accountId, { force: true, allowLaunch: false });
                  return json(res, 200, { ...quota, snapshot: runtime.snapshot() });
                }
                case "quit-browser":
                  return json(res, 200, await runtime.quitBrowser(accountId));
                /**
                 * Media deletion is only ever this: an explicit action the user
                 * asks for. Nothing in the plugin removes a delivered file on its
                 * own, because each one is linked from the conversation that
                 * announced it and cost real quota to produce.
                 */
                case "clear-media":
                  return json(res, 200, runtime.clearMedia());
                /** Write settings changes through the Host's config editor. */
                case "save-settings":
                  return json(res, 200, await runtime.updateSettings(asRecord(body).settings));
                case "snapshot":
                  return json(res, 200, runtime.snapshot());
                default:
                  return json(res, 400, { error: `unknown action ${String(action)}` });
              }
            } catch (error) {
              const failure = error instanceof MuseFailure ? error : undefined;
              return json(res, 200, {
                ok: false,
                code: failure?.code ?? "ERROR",
                kind: failure?.kind,
                error: error instanceof Error ? error.message : String(error),
                busy: runtime.busy,
                snapshot: (() => {
                  try {
                    return runtime.snapshot();
                  } catch {
                    return undefined;
                  }
                })(),
              });
            }
          },
        }),
      );

      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            /* ignore */
          }
        }
      };
    });
  };

  if (ctx.get("webServer") !== undefined) registerRoutes(ctx);
  else ctx.inject(["webServer"], (webCtx) => registerRoutes(webCtx));

  /* ---- lifecycle ---- */
  ctx.effect(() => {
    const stopReaper = runtime.maintain();
    return () => {
      stopReaper?.();
      // Only browsers this plugin spawned are closed; nothing else is touched.
      void runtime.browser.closeAll("DSH 退出");
    };
  });
}
