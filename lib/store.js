/**
 * Durable bookkeeping: the account index and the task journal.
 *
 * Two files under `<DSH_HOME>/muse-media/`, both plain JSON written through a
 * temp-file rename so a crash mid-write cannot truncate them:
 *
 *   - `state.json`  the account index. A label, a status, the last verified
 *                   time, the last conversation-probe result, the last known
 *                   quota numbers and a cooldown deadline. **Never a cookie,
 *                   never a session token**: the browser profile owns those,
 *                   and this file is safe to paste into a bug report.
 *   - `tasks.json`  the journal G5 requires. One record per task, written
 *                   *before* any page action that could send a request, so a
 *                   crash between "we clicked send" and "we saw a result" is
 *                   still resolvable afterwards instead of being invisible.
 *
 * The store is deliberately dumb: it validates shapes on read, hands out
 * copies, and lets `pool.js` own the selection policy.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Account statuses, mirroring the settings card's vocabulary. */
export const ACCOUNT_STATUS = {
  NEW: "new",
  NEEDS_LOGIN: "needs-login",
  READY: "ready",
  DISABLED: "disabled",
};

/** Task states, from first queue to settled. */
export const TASK_STATE = {
  QUEUED: "queued",
  RUNNING: "running",
  /** A page action that may have sent a request fired; the outcome is unknown. */
  POSSIBLY_SENT: "possibly-sent",
  ACCEPTED: "accepted",
  GENERATED_UNSAVED: "generated-unsaved",
  DELIVERED: "delivered",
  FAILED: "failed",
  UNKNOWN: "unknown",
};

/** How many settled task records to keep. The journal is a recovery aid. */
const TASK_KEEP = 40;

function nowMs() {
  return Date.now();
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const text = readFileSync(file, "utf8");
    if (text.trim() === "") return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Write one JSON document atomically.
 *
 * `rename` is atomic within a directory on both NTFS and POSIX, so a reader
 * either sees the previous complete document or the next one. The temp name is
 * fixed rather than random: a leftover temp file from a crashed write is then
 * overwritten instead of accumulating.
 */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Coerce one stored account row, dropping anything unrecognised. */
function normalizeAccount(raw) {
  const record = asRecord(raw);
  const id = asString(record.id).trim();
  if (id === "") return undefined;
  const status = Object.values(ACCOUNT_STATUS).includes(record.status)
    ? record.status
    : ACCOUNT_STATUS.NEW;
  const quota = asRecord(record.quota);
  const probe = asRecord(record.probe);
  const cooldown = asRecord(record.cooldown);
  return {
    id,
    label: asString(record.label, id) || id,
    createdAt: asNumber(record.createdAt, nowMs()),
    status,
    statusReason: asString(record.statusReason) || undefined,
    autoRuleEligible: record.autoRuleEligible === true,
    memoryRule: record.memoryRule && asRecord(record.memoryRule),
    verifiedAt: asNumber(record.verifiedAt, 0) || undefined,
    lastUsedAt: asNumber(record.lastUsedAt, 0) || undefined,
    lastLoginAt: asNumber(record.lastLoginAt, 0) || undefined,
    quota:
      quota.usedPct === undefined && quota.plan === undefined && quota.at === undefined
        ? undefined
        : {
            usedPct: typeof quota.usedPct === "number" ? quota.usedPct : undefined,
            /**
             * What `usedPct` measures — always the free weekly allowance. The
             * extra allowance below is a separate budget and is never folded in.
             */
            scope: asString(quota.scope) || undefined,
            plan: asString(quota.plan) || undefined,
            reset: asString(quota.reset) || undefined,
            /** The extra allowance's own numbers, kept beside the weekly one. */
            extraUsedPct: typeof quota.extraUsedPct === "number" ? quota.extraUsedPct : undefined,
            extraLeft: asString(quota.extraLeft) || undefined,
            extraExpires: asString(quota.extraExpires) || undefined,
            at: asNumber(quota.at, 0) || undefined,
            /** True when the last read failed and the numbers are the old ones. */
            stale: quota.stale === true,
            error: asString(quota.error) || undefined,
          },
    probe:
      probe.ok === undefined && probe.checkedAt === undefined
        ? undefined
        : {
            ok: probe.ok === true,
            note: asString(probe.note) || undefined,
            code: asString(probe.code) || undefined,
            checkedAt: asNumber(probe.checkedAt, 0) || undefined,
            elapsedMs: asNumber(probe.elapsedMs, 0) || undefined,
            formatMismatch: probe.formatMismatch === true,
          },
    cooldown:
      cooldown.reason === undefined && cooldown.usableUntil === undefined
        ? undefined
        : {
            reason: asString(cooldown.reason) || undefined,
            /** Epoch ms when the limit is expected to clear; absent means "unknown". */
            usableUntil: asNumber(cooldown.usableUntil, 0) || undefined,
            /** Verbatim upstream text, kept when no exact instant can be read. */
            raw: asString(cooldown.raw) || undefined,
            setAt: asNumber(cooldown.setAt, 0) || undefined,
          },
  };
}

/** Coerce one task record. */
function normalizeTask(raw) {
  const record = asRecord(raw);
  const id = asString(record.id).trim();
  if (id === "") return undefined;
  const state = Object.values(TASK_STATE).includes(record.state) ? record.state : TASK_STATE.QUEUED;
  return {
    id,
    kind: record.kind === "video" ? "video" : record.kind === "quota" ? "quota" : "image",
    state,
    accountId: asString(record.accountId) || undefined,
    accountLabel: asString(record.accountLabel) || undefined,
    parentTaskId: asString(record.parentTaskId) || undefined,
    previewOnly: record.previewOnly === true || undefined,
    threadUrl: asString(record.threadUrl) || undefined,
    turn: Number.isSafeInteger(record.turn) && record.turn > 0 ? record.turn : undefined,
    /** Accounts already used for this task, in order. G5 caps the length. */
    attempted: Array.isArray(record.attempted)
      ? record.attempted.filter((entry) => typeof entry === "string")
      : [],
    createdAt: asNumber(record.createdAt, nowMs()),
    updatedAt: asNumber(record.updatedAt, nowMs()),
    /** Set the moment an action that could send a request fires. */
    sendAttemptedAt: asNumber(record.sendAttemptedAt, 0) || undefined,
    /** Why the task stopped, in the operator's words. */
    note: asString(record.note) || undefined,
    /** Recorded so a recovery pass can say where the media landed. */
    media: asString(record.media) || undefined,
    /** What was asked for. Absent on tasks recorded before the field existed. */
    prompt: asString(record.prompt) || undefined,
    /** Reference file names supplied with the prompt. */
    references: Array.isArray(record.references)
      ? record.references.map((entry) => asString(entry)).filter(Boolean)
      : undefined,
    /** Weekly panel readings bracketing this task. Older journals may contain only one. */
    quotaBefore: typeof record.quotaBefore === "number" ? record.quotaBefore : undefined,
    quotaAfter: typeof record.quotaAfter === "number" ? record.quotaAfter : undefined,
    /** How long the task took wall-clock, in ms, for the history list. */
    durationMs: typeof record.durationMs === "number" && record.durationMs > 0 ? record.durationMs : undefined,
  };
}

/** One entry per Muse conversation. Independent of the rotating task journal. */
export class ThreadLibrary {
  constructor(file) {
    this.file = file;
    const saved = readJson(file, {});
    this.threads = new Map(saved.threads ?? []);
    this.selections = new Map(saved.selections ?? []);
  }

  save() {
    writeJson(this.file, { threads: [...this.threads], selections: [...this.selections] });
  }

  remember({ accountId, threadUrl, prompt, updatedAt, kind, title }) {
    const key = accountId + "|" + threadUrl;
    const old = this.threads.get(key);
    if (!old || old.updatedAt < updatedAt) {
      this.threads.set(key, { key, accountId, threadUrl, title: title || old?.title || prompt.slice(0, 96),
        updatedAt, kind });
      return true;
    }
    return false;
  }

  selected(sessionId) {
    return this.threads.get(this.selections.get(sessionId));
  }

  select(sessionId, key) {
    const old = this.selections.get(sessionId);
    if (key) this.selections.set(sessionId, key);
    else this.selections.delete(sessionId);
    try { this.save(); } catch (error) {
      if (old) this.selections.set(sessionId, old);
      else this.selections.delete(sessionId);
      throw error;
    }
  }
}

/** The account index. */
export class AccountStore {
  #file;
  #accounts = new Map();
  #selectedId;
  #loaded = false;

  constructor(file) {
    this.#file = file;
  }

  load() {
    if (this.#loaded) return this;
    const document = asRecord(readJson(this.#file, {}));
    const rows = Array.isArray(document.accounts) ? document.accounts : [];
    this.#accounts.clear();
    for (const row of rows) {
      const account = normalizeAccount(row);
      if (account !== undefined) this.#accounts.set(account.id, account);
    }
    this.#selectedId = asString(document.selectedId) || undefined;
    if (this.#selectedId !== undefined && !this.#accounts.has(this.#selectedId)) {
      this.#selectedId = undefined;
    }
    this.#loaded = true;
    return this;
  }

  #persist() {
    writeJson(this.#file, {
      version: 1,
      selectedId: this.#selectedId,
      accounts: [...this.#accounts.values()],
    });
  }

  /** Every account, oldest first, as copies. */
  list() {
    this.load();
    return [...this.#accounts.values()].map((account) => structuredClone(account));
  }

  get(accountId) {
    this.load();
    const account = this.#accounts.get(accountId);
    return account === undefined ? undefined : structuredClone(account);
  }

  get selectedId() {
    this.load();
    return this.#selectedId;
  }

  /** The account a new request should start from. */
  selected() {
    this.load();
    if (this.#selectedId !== undefined) {
      const account = this.#accounts.get(this.#selectedId);
      if (account !== undefined) return structuredClone(account);
    }
    // No explicit selection: the oldest ready account is a stable default.
    const ready = [...this.#accounts.values()]
      .filter((account) => account.status !== ACCOUNT_STATUS.DISABLED)
      .sort((a, b) => a.createdAt - b.createdAt);
    return ready.length === 0 ? undefined : structuredClone(ready[0]);
  }

  select(accountId) {
    this.load();
    if (!this.#accounts.has(accountId)) return false;
    this.#selectedId = accountId;
    this.#persist();
    return true;
  }

  /**
   * Add one account.
   *
   * The id is derived from the label so the profile directory is legible on
   * disk (`profiles/acc-01/`), and a suffix is appended when the label is
   * already taken. It never comes from user input verbatim: a path separator
   * in a directory name would escape the profile root.
   */
  add(label) {
    this.load();
    const raw = asString(label).trim() || `acc-${this.#accounts.size + 1}`;
    const base = raw
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const seed = base === "" ? `acc-${this.#accounts.size + 1}` : base;
    let id = seed;
    let suffix = 2;
    while (this.#accounts.has(id)) {
      id = `${seed}-${suffix}`;
      suffix += 1;
    }
    const account = {
      id,
      label: raw.slice(0, 60),
      createdAt: nowMs(),
      status: ACCOUNT_STATUS.NEW,
      autoRuleEligible: true,
    };
    this.#accounts.set(id, account);
    if (this.#selectedId === undefined) this.#selectedId = id;
    this.#persist();
    return structuredClone(account);
  }

  /** Apply a partial update; unknown ids report `undefined`. */
  update(accountId, patch) {
    this.load();
    const current = this.#accounts.get(accountId);
    if (current === undefined) return undefined;
    const next = normalizeAccount({ ...current, ...patch, id: current.id });
    if (next === undefined) return undefined;
    this.#accounts.set(accountId, next);
    this.#persist();
    return structuredClone(next);
  }

  remove(accountId) {
    this.load();
    if (!this.#accounts.delete(accountId)) return false;
    if (this.#selectedId === accountId) {
      const next = [...this.#accounts.values()][0];
      this.#selectedId = next?.id;
    }
    this.#persist();
    return true;
  }
}

/** The task journal. */
export class TaskStore {
  #file;
  #tasks = new Map();
  #loaded = false;

  constructor(file) {
    this.#file = file;
  }

  load() {
    if (this.#loaded) return this;
    const document = asRecord(readJson(this.#file, {}));
    const rows = Array.isArray(document.tasks) ? document.tasks : [];
    this.#tasks.clear();
    for (const row of rows) {
      const task = normalizeTask(row);
      if (task !== undefined) this.#tasks.set(task.id, task);
    }
    this.#loaded = true;
    return this;
  }

  #persist() {
    // Newest first, and only the tail worth keeping for recovery.
    const rows = [...this.#tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, TASK_KEEP);
    writeJson(this.#file, { version: 1, tasks: rows });
  }

  /** Create the record before anything can send a request. */
  create({ kind, accountId, accountLabel, prompt, references, parentTaskId }) {
    this.load();
    const id = `muse-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id,
      kind,
      state: TASK_STATE.QUEUED,
      parentTaskId,
      accountId,
      accountLabel,
      /**
       * What was asked for, kept verbatim.
       *
       * Without this the history can only say "an image, 45 s, 2% of the allowance" — which does not let anyone decide
       * whether to look at the file, let alone re-run it. Tasks recorded before this field existed simply lack it; there
       * is nothing to backfill from.
       */
      prompt: asString(prompt) || undefined,
      /** Reference file names, so a re-run can be reconstructed. */
      references: Array.isArray(references)
        ? references.map((entry) => asString(entry)).filter(Boolean)
        : undefined,
      attempted: accountId === undefined ? [] : [accountId],
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };
    this.#tasks.set(id, task);
    this.#persist();
    return structuredClone(task);
  }

  update(taskId, patch) {
    this.load();
    const current = this.#tasks.get(taskId);
    if (current === undefined) return undefined;
    const next = normalizeTask({ ...current, ...patch, id: current.id, updatedAt: nowMs() });
    if (next === undefined) return undefined;
    this.#tasks.set(taskId, next);
    this.#persist();
    return structuredClone(next);
  }

  get(taskId) {
    this.load();
    const task = this.#tasks.get(taskId);
    return task === undefined ? undefined : structuredClone(task);
  }

  list() {
    this.load();
    return [...this.#tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => structuredClone(task));
  }

  /**
   * Records that still need a human look after a restart.
   *
   * A task that reached `possibly-sent` and never settled is exactly what G5's
   * "结果未知" branch exists for: it must be reported, never re-sent.
   */
  unsettled() {
    this.load();
    return this.list().filter(
      (task) =>
        task.state === TASK_STATE.POSSIBLY_SENT ||
        task.state === TASK_STATE.ACCEPTED ||
        task.state === TASK_STATE.RUNNING,
    );
  }
}
