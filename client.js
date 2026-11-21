/**
 * Client half of `dsh-muse-media`: the composer pill and the settings card.
 *
 * Two surfaces, one data source. Both read the Host's own routes rather than
 * holding state of their own, because the Host is the only place that knows
 * which account is selected, whether a page is busy, and what the last read
 * actually returned:
 *
 *   GET  /plugins/dsh-muse-media/accounts          the pill and the card
 *   POST /plugins/dsh-muse-media/accounts/action   account operations
 *
 * The pill does **not** read `/plugins/dsh-muse-media/quota`. A8 makes that
 * route strictly loopback, and a Host bound to a LAN address would answer 403
 * there while the card kept working — a split no user could diagnose. The
 * account snapshot carries the same numbers plus the account the running task is
 * using (A4), so one read serves both surfaces.
 *
 * Styling uses only `--dsw-alias-*` tokens, so light/dark and theme changes come
 * from the host. Controls are hand-written rather than imported: a Harness
 * Client package cannot be required from a plugin, so the markup, focus ring
 * and disabled behaviour are reproduced here under this plugin's own class
 * prefix.
 *
 * Text is localized from a dictionary embedded in this file, read against the
 * live `locale` service snapshot. The plugin's `locale/*.json` files serve the
 * Plugin Manager's title and description, which is a different contract with a
 * different lifetime.
 */

window.__ModuleLoader__.load({
  id: "dsh-muse-media",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const ACCOUNTS_PATH = "/plugins/dsh-muse-media/accounts";
    const ACTION_PATH = "/plugins/dsh-muse-media/accounts/action";

    /**
     * The one string that identifies this plugin's settings entry.
     *
     * Used four times — the section registration, the nav icon's cell key, the
     * sidebar page and the plugin-page card — and the icon slot is matched against
     * it by the shell, so it lives here rather than being repeated as a literal.
     */
    const SECTION_ID = "dsh-muse-media";

    /**
     * The settings-nav glyph.
     *
     * Inherits `currentColor`, so it follows the row's active/idle tint without any
     * colour of its own. `size` comes from the shell and is honoured so the mark
     * lines up with the shipped icons.
     */
    function MuseNavIcon({ size = 16 }) {
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block" },
        },
        // A ring, with three blades crossing it: an aperture, not a gear.
        h("circle", { cx: 12, cy: 12, r: 8.2 }),
        h("path", { d: "M12 3.8 L15.6 10" }),
        h("path", { d: "M19.4 15.5 L12.4 16.4" }),
        h("path", { d: "M6.6 18.2 L8.4 11.2" }),
      );
    }

    /** Pill refresh cadence; the Host caches its own reads for 60 s. */
    const PILL_INTERVAL_MS = 45_000;

    /** How many `verify` polls to spend watching one sign-in window. */
    const LOGIN_WATCH_TRIES = 40;
    const LOGIN_WATCH_INTERVAL_MS = 3_000;

    /* ---------------- copy ---------------- */

    const ZH = {
      "pill.label": "Muse",
      "pill.used": "周额度已用 {pct}%",
      "pill.unknown": "待刷新",
      "pill.busy": "生成中",
      "pill.plan": "计划",
      "pill.reset": "重置",
      "pill.updated": "数据更新于",
      "pill.account": "账号",
      "pill.accountViewing": "当前查看的账号（下次生成可能按额度重置日期选其他账号）",
      "pill.accountRunning": "本次生成使用的账号",
      "pill.source": "更新方式",
      "pill.extra": "额外额度",
      "pill.usedShort": "已用 {pct}%",
      "pill.autoRefresh": "自动刷新，生成后立即更新",
      "pill.pendingRefresh": "还没有读到额度；下一次生成后自动更新",
      "pill.warn": "提醒",
      "pill.warnHigh": "本周额度已用 {pct}%",
      "pill.warnHighSolo": "本周额度接近用完；用完后会转用额外额度（不会中断生成）",
      "pill.warnHighMulti": "本周额度接近用完；如果另有账号，下一次会优先用它",
      "pill.warnFullNoExtra": "本周额度已用完。额外额度读数未知，仍可继续生成",
      "pill.warnFullExtra": "本周额度已用完，正在使用额外额度（不会过期，可继续生成）",

      "settings.title": "Muse 账号",
      /**
       * The sidebar entry, kept separate from the page heading.
       *
       * One key used to serve both, which forced the sidebar to name the page's
       * *content* ("Muse accounts"). A sidebar is a list of places, not of
       * headings: the neighbouring entries are `Trae` and `WorkBuddy`, so a bare
       * product name is what belongs here — and this page is not only accounts
       * (quota, browser control and the conversation test live there too).
       */
      "settings.nav": "Muse",
      "settings.intro":
        "每个账号有自己的浏览器数据目录。首次登录会打开一个可见窗口，你在窗口里登录一次即可；凭据由浏览器保存，插件不读取。",
      "settings.addAccount": "新增账号",
      "settings.accountsTitle": "账号",
      "settings.disk": "占用磁盘",
      "settings.history": "最近生成",
      "settings.paneAccounts": "账号",
      "settings.paneHistory": "记录",
      "settings.paneAdvanced": "高级",
      "settings.historyEmpty": "还没有生成记录。",
      "settings.historyImages": "张图",
      "settings.historyVideos": "段视频",
      "settings.historyCost": "本周额度消耗",
      "settings.showAll": "显示全部",
      "settings.stateUnknown": "结果未知",
      "settings.stateFailed": "未完成",
      "settings.stateUnsaved": "已生成，本地保存失败；请到该账号的 Muse 会话取回",
      "settings.advanced": "高级设置",
      "settings.save": "保存",
      "settings.saved": "已保存",
      "settings.discard": "放弃",
      "settings.savedKeys": "已保存：{keys}",
      "settings.fieldHeadless": "生成时不显示窗口",
      "settings.fieldHeadlessHint": "关掉会弹出浏览器窗口，只在首次登录时才有必要。",
      "settings.fieldPill": "在输入框显示额度",
      "settings.fieldPillHint": "在对话输入框旁边显示本周已用百分比。",
      "settings.fieldIdle": "空闲回收（秒）",
      "settings.fieldIdleHint": "浏览器闲置这么久后关闭；0 表示不自动关闭。",
      "settings.fieldConcurrent": "同时运行的浏览器上限",
      "settings.fieldConcurrentHint": "每个无头浏览器约占 1 GB；0 表示不限制。",
      "settings.fieldRefresh": "额度刷新间隔（秒）",
      "settings.fieldRefreshHint": "0 关闭后台刷新；生成结束时总会刷新一次。",
      "settings.fieldImageTimeout": "生图超时（秒）",
      "settings.fieldVideoTimeout": "生视频超时（秒）",
      "settings.needsRestartHint": "改动会立即生效，无需重启。",
      "settings.diagnostics": "诊断",
      "settings.diagState": "状态目录",
      "settings.diagTasks": "任务记录",
      "settings.diagMedia": "媒体文件",
      "settings.diagBrowsers": "运行中的浏览器",
      "settings.diagChrome": "浏览器来源",
      "settings.diagChromeAuto": "自动探测",
      "settings.diagChromeConfig": "配置指定",
      "settings.diskProfiles": "浏览器数据",
      "settings.diskMedia": "已下载媒体",
      "settings.clearMedia": "清空已下载媒体",
      "settings.less": "收起",
      "settings.quotaUsedShort": "本周已用",
      "settings.quotaNeverShort": "未读取",
      "settings.quotaNeverHint": "点「读取额度」",
      "settings.quotaNeverAction": "尚未读取",
      "settings.clearMediaHint": "清空后旧对话里的播放链接会失效",
      "settings.clearMediaConfirm": "确认清空？不可恢复",
      "settings.clearMediaDone": "已清空 {removed} 项，释放 {size}。旧对话里的播放链接现在会失效。",
      "settings.clearMediaFailed": "清空未完成：删除 {removed} 项，{failed} 项失败（{error}）。",
      "settings.cancel": "取消",
      "settings.addPending": "新增中…",
      "settings.addHint": "标签（可留空，自动命名）",
      "settings.label": "标签",
      "settings.login": "打开登录窗口",
      "settings.loginPending": "等待登录…",
      "settings.loginClosed": "登录窗口已关闭。需要时再点「打开登录窗口」。",
      "settings.verify": "验证登录",
      "settings.verifyPending": "正在验证…",
      "settings.test": "测试",
      "settings.testPending": "测试中…",
      "settings.select": "同条件时优先",
      "settings.selected": "优先",
      "settings.selectedHint": "同条件下优先使用；实际仍会先选周额度最早重置的账号",
      "settings.remove": "删除",
      "settings.removeConfirm": "删除会连同该账号的浏览器数据目录一起清除，之后需要重新登录。确定删除 {label}？",
      "settings.refreshQuota": "读取额度",
      "settings.refreshShort": "刷新",
      "settings.quit": "关闭浏览器",
      "settings.empty": "还没有账号。先新增一个，再打开登录窗口完成登录。",
      "settings.noBrowser": "找不到可用的浏览器",
      "settings.noBrowserFix": "这个插件驱动你机器上已有的 Chrome 或 Edge，不自己带浏览器。请安装 Chrome，或在插件配置里用 chromePath 指定浏览器可执行文件的路径。",
      "settings.step1": "点「新增账号」建立一个账号（标签可留空，会自动命名）。",
      "settings.step2": "在账号那一行点「打开登录窗口」，会弹出一个独立的浏览器窗口。",
      "settings.step3": "在那个窗口里用你的 Muse 账号登录。插件不读取凭据，由浏览器自己保存。",
      "settings.step4": "登录完成后点「验证登录」（或等设置卡自动检测）。状态变成「可用」就能生成了。",
      "settings.busy": "页面正被一个生成任务占用，请等它结束。",
      "settings.running": "浏览器已开",
      "settings.status.new": "未登录",
      "settings.status.needs-login": "需要重新登录",
      "settings.status.ready": "可用",
      "settings.status.disabled": "已停用",
      "settings.probe.never": "尚未测试",
      "settings.probe.ok": "对话连通",
      "settings.probe.format": "对话连通（格式不符）",
      "settings.probe.failed": "测试失败",
      "settings.probe.timeout": "测试超时",
      "settings.quotaUsed": "本周已用",
      "settings.quotaNever": "尚未读取",
      "settings.quotaPlan": "计划",
      "settings.quotaReset": "重置",
      "settings.quotaUpdated": "更新于",
      "settings.quotaStale": "上次成功值",
      "settings.lastUsed": "最近使用",
      "settings.never": "从未",
      "settings.browser": "浏览器",
      "settings.profiles": "账号目录",
      "settings.readFailed": "读取账号状态失败：",
      "settings.seconds": "秒",
      "settings.unsent": "需要人工确认的任务",
      "settings.actionFailed": "操作失败。",
    };

    const EN = {
      "pill.label": "Muse",
      "pill.used": "{pct}% weekly used",
      "pill.unknown": "Refresh needed",
      "pill.busy": "Generating",
      "pill.plan": "Plan",
      "pill.reset": "Resets",
      "pill.updated": "Data from",
      "pill.account": "Account",
      "pill.accountViewing": "The account being viewed (the next run may pick another by reset date)",
      "pill.accountRunning": "The account used for this run",
      "pill.source": "Updates",
      "pill.extra": "Extra allowance",
      "pill.usedShort": "{pct}% used",
      "pill.autoRefresh": "Automatic; refreshes right after a generation",
      "pill.pendingRefresh": "No reading yet; updates after the next generation",
      "pill.warn": "Note",
      "pill.warnHigh": "{pct}% of the weekly allowance used",
      "pill.warnHighSolo": "The weekly allowance is nearly spent; generations continue on the extra allowance",
      "pill.warnHighMulti": "The weekly allowance is nearly spent; the next task will prefer another account if one is available",
      "pill.warnFullNoExtra": "The weekly allowance is spent. The extra allowance is unmeasured; generation can continue",
      "pill.warnFullExtra": "The weekly allowance is spent; running on the extra allowance, which does not expire",

      "settings.title": "Muse accounts",
      "settings.nav": "Muse",
      "settings.intro":
        "Each account keeps its own browser data directory. The first sign-in opens a visible window; you sign in once there. The browser holds the credential and the plugin never reads it.",
      "settings.addAccount": "Add account",
      "settings.accountsTitle": "Accounts",
      "settings.disk": "On disk",
      "settings.history": "Recent generations",
      "settings.paneAccounts": "Accounts",
      "settings.paneHistory": "History",
      "settings.paneAdvanced": "Advanced",
      "settings.historyEmpty": "Nothing generated yet.",
      "settings.historyImages": "images",
      "settings.historyVideos": "videos",
      "settings.historyCost": "allowance used this week",
      "settings.showAll": "Show all",
      "settings.stateUnknown": "unknown",
      "settings.stateFailed": "did not finish",
      "settings.stateUnsaved": "Generated, local save failed. Retrieve it from this account’s Muse chat.",
      "settings.advanced": "Advanced",
      "settings.save": "Save",
      "settings.saved": "Saved",
      "settings.discard": "Discard",
      "settings.savedKeys": "Saved: {keys}",
      "settings.fieldHeadless": "Run generations headless",
      "settings.fieldHeadlessHint": "Turning this off opens a browser window for every generation.",
      "settings.fieldPill": "Show usage beside the composer",
      "settings.fieldPillHint": "Display the weekly percentage next to the message box.",
      "settings.fieldIdle": "Reap an idle browser after (s)",
      "settings.fieldIdleHint": "0 keeps browsers open until DSH exits.",
      "settings.fieldConcurrent": "Live browser ceiling",
      "settings.fieldConcurrentHint": "One headless browser costs about 1 GB; 0 means no ceiling.",
      "settings.fieldRefresh": "Usage refresh interval (s)",
      "settings.fieldRefreshHint": "0 disables background refresh; a delivery still refreshes once.",
      "settings.fieldImageTimeout": "Image timeout (s)",
      "settings.fieldVideoTimeout": "Video timeout (s)",
      "settings.needsRestartHint": "Changes apply immediately; no restart needed.",
      "settings.diagnostics": "Diagnostics",
      "settings.diagState": "State directory",
      "settings.diagTasks": "Task records",
      "settings.diagMedia": "Media files",
      "settings.diagBrowsers": "Browsers running",
      "settings.diagChrome": "Browser source",
      "settings.diagChromeAuto": "auto-detected",
      "settings.diagChromeConfig": "from config",
      "settings.diskProfiles": "browser data",
      "settings.diskMedia": "downloaded media",
      "settings.clearMedia": "Clear downloaded media",
      "settings.less": "Less",
      "settings.quotaUsedShort": "used this week",
      "settings.quotaNeverShort": "no reading",
      "settings.quotaNeverHint": "press Refresh",
      "settings.quotaNeverAction": "not read yet",
      "settings.clearMediaHint": "Old conversation links stop working afterwards",
      "settings.clearMediaConfirm": "Clear? This cannot be undone",
      "settings.clearMediaDone": "Cleared {removed} items, freed {size}. Old conversation links no longer work.",
      "settings.clearMediaFailed": "Clear incomplete: removed {removed}, {failed} failed ({error}).",
      "settings.cancel": "Cancel",
      "settings.addPending": "Adding…",
      "settings.addHint": "label (optional; auto-named when empty)",
      "settings.label": "Label",
      "settings.login": "Open sign-in window",
      "settings.loginPending": "Waiting for sign-in...",
      "settings.loginClosed": "The sign-in window was closed. Open it again when you are ready.",
      "settings.verify": "Verify sign-in",
      "settings.verifyPending": "Verifying...",
      "settings.test": "Test",
      "settings.testPending": "Testing...",
      "settings.select": "Prefer when tied",
      "settings.selected": "Preferred",
      "settings.selectedHint": "Ties go to this account; the soonest-expiring weekly allowance still ranks first",
      "settings.remove": "Remove",
      "settings.removeConfirm":
        "Removing also deletes this account's browser data directory, so you will sign in again. Remove {label}?",
      "settings.refreshQuota": "Read usage",
      "settings.refreshShort": "Refresh",
      "settings.quit": "Close browser",
      "settings.empty": "No accounts yet. Add one, then open its sign-in window.",
      "settings.noBrowser": "No usable browser found",
      "settings.noBrowserFix": "This plugin drives the Chrome or Edge already on your machine; it does not ship a browser. Install Chrome, or point chromePath at a browser executable in the plugin configuration.",
      "settings.step1": "Press \"Add account\" to create one. The label is optional; it is named for you.",
      "settings.step2": "On that account row press \"Open sign-in window\" to get a separate browser window.",
      "settings.step3": "Sign in to Muse in that window. The plugin never reads the credential; the browser keeps it.",
      "settings.step4": "Then press \"Verify sign-in\" (or wait for the card to detect it). Once the status reads usable, generation works.",
      "settings.busy": "A generation task is using the page. Wait for it to finish.",
      "settings.running": "Browser open",
      "settings.status.new": "Not signed in",
      "settings.status.needs-login": "Sign-in required",
      "settings.status.ready": "Ready",
      "settings.status.disabled": "Disabled",
      "settings.probe.never": "Not tested",
      "settings.probe.ok": "Conversation reachable",
      "settings.probe.format": "Reachable (wrong format)",
      "settings.probe.failed": "Test failed",
      "settings.probe.timeout": "Test timed out",
      "settings.quotaUsed": "Used this week",
      "settings.quotaNever": "Not read yet",
      "settings.quotaPlan": "Plan",
      "settings.quotaReset": "Resets",
      "settings.quotaUpdated": "Updated",
      "settings.quotaStale": "last good value",
      "settings.lastUsed": "Last used",
      "settings.never": "Never",
      "settings.browser": "Browser",
      "settings.profiles": "Account directory",
      "settings.readFailed": "Could not read account state: ",
      "settings.seconds": "s",
      "settings.unsent": "Tasks needing a human check",
      "settings.actionFailed": "The action failed.",
    };

    function interpolate(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        values[key] === undefined || values[key] === null ? match : String(values[key]),
      );
    }

    function makeTranslate(locale) {
      const dict = String(locale).toLowerCase().startsWith("zh") ? ZH : EN;
      return (key, values) => {
        const template = dict[key];
        if (typeof template !== "string") return key;
        return values === undefined ? template : interpolate(template, values);
      };
    }

    /* ---------------- plumbing ---------------- */

    async function fetchJson(path, init) {
      const response = await fetch(path, {
        ...init,
        headers: { accept: "application/json", ...(init && init.headers ? init.headers : {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    /** Bytes as a short human figure, for the disk line. */
    function formatBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "\u2014";
      if (bytes < 1024) return `${bytes} B`;
      const mb = bytes / (1024 * 1024);
      if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
      if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
      return `${(mb / 1024).toFixed(2)} GB`;
    }

    function relativeTime(at, locale) {
      if (typeof at !== "number" || at <= 0) return "";
      const zh = String(locale).toLowerCase().startsWith("zh");
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 60) return zh ? "刚刚" : "just now";
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
      return new Date(at).toLocaleDateString();
    }

    function readLocale(ctx) {
      const service = ctx.get("locale");
      if (service === undefined || typeof service.getSnapshot !== "function") return "en";
      const snapshot = service.getSnapshot();
      return typeof snapshot?.active === "string" ? snapshot.active : "en";
    }

    /**
     * Subscribe one component to the live locale.
     *
     * Reading the snapshot once would freeze the copy at mount; a subscription
     * makes a language switch re-render without remounting the slot.
     */
    function useLocale(ctx) {
      const [locale, setLocale] = useState(() => readLocale(ctx));
      useEffect(() => {
        const service = ctx.get("locale");
        if (service === undefined || typeof service.subscribe !== "function") return;
        return service.subscribe(() => setLocale(readLocale(ctx)));
      }, [ctx]);
      return locale;
    }

    const STYLE = `
.muse-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary);padding:2px 4px;border-radius:6px;white-space:nowrap;}
.muse-pill[data-state="stale"]{opacity:.55;}
.muse-pill[data-state="error"]{opacity:.75;color:var(--dsw-alias-state-error-primary);}
.muse-pill[data-state="busy"]{color:var(--dsw-alias-state-warn-primary);}
/* Nearly spent: amber, so the allowance is visible before it runs out. */
.muse-pill[data-state="high"]{color:var(--dsw-alias-state-warn-primary);}
/* Weekly allowance spent; the extra allowance takes over, so this is not an
   error — it is a change of source. Red would read as "broken". */
.muse-pill[data-state="full"]{color:var(--dsw-alias-state-warn-primary);font-weight:600;}
.muse-pill-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none;}
.muse-pill[data-state="stale"] .muse-pill-dot{background:var(--dsw-alias-state-idle-primary);}
.muse-pill[data-state="busy"] .muse-pill-dot{background:var(--dsw-alias-state-warn-primary);}
.muse-pill[data-state="error"] .muse-pill-dot{background:var(--dsw-alias-state-error-primary);}
.muse-pill[data-state="high"] .muse-pill-dot{background:var(--dsw-alias-state-warn-primary);}
.muse-pill[data-state="full"] .muse-pill-dot{background:var(--dsw-alias-state-warn-primary);}
.muse-pill-label{font-weight:600;color:var(--dsw-alias-label-primary);}
.muse-pill-acct{opacity:.75;}
/* A "waiting for the next generation" readout is muted, not an error: nothing
   is wrong, the Host simply has no reading to show yet. */
.muse-pill[data-state="waiting"]{opacity:.6;}
.muse-tip{position:fixed;z-index:2147483000;max-width:280px;padding:6px 8px;border-radius:6px;
  font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);
  box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;}
.muse-tip-row{display:flex;justify-content:space-between;gap:12px;}
.muse-tip-key{color:var(--dsw-alias-label-secondary);flex:none;}

.muse-card{display:flex;flex-direction:column;gap:16px;padding:8px 0;min-width:0;
  font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}
.muse-head{display:flex;flex-direction:column;gap:8px;}
.muse-card h3{margin:0;line-height:24px;font-size:16px;font-weight:500;}
.muse-card p{font-size:14px;margin:0;color:var(--dsw-alias-label-secondary);line-height:22px;}
.muse-card-actions,.muse-actions-more{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;}
.muse-btn{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
  font:inherit;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;
  min-height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);}
.muse-btn:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);}
.muse-btn--quiet{border-color:transparent;}
.muse-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);
  border-color:transparent;font-weight:500;}
.muse-btn--primary:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover);}
.muse-btn--danger,.muse-btn--danger-quiet:not(:disabled):hover{color:var(--dsw-alias-state-error-primary);}
.muse-btn:focus-visible,.muse-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}
.muse-btn:disabled{opacity:.5;cursor:not-allowed;}
.muse-input{all:unset;box-sizing:border-box;line-height:20px;font-size:14px;padding:5px 8px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);min-width:150px;}
.muse-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.muse-steps{margin:6px 0 0;padding-left:20px;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-secondary);}
.muse-steps li{margin:2px 0;}
.muse-card-steps{margin:6px 0;}
/* The pane header: what the list is, and the one action that changes it. Sized like the
   Host's own row labels (14px) so it lines up with the navigation column beside it. */
.muse-list-head{display:flex;align-items:center;gap:12px;justify-content:space-between;}
.muse-list-title{margin:0;font-size:14px;line-height:22px;font-weight:600;
  color:var(--dsw-alias-label-primary);}
.muse-list{display:flex;flex-direction:column;}
.muse-row{display:flex;flex-direction:column;gap:6px;padding:16px 0 14px;
  border-top:.5px solid var(--dsw-alias-border-l2);}
.muse-row:last-child{padding-bottom:0;}
.muse-row .muse-card-actions{margin-top:4px;}
.muse-row .muse-btn{min-height:30px;padding:0 10px;font-size:13px;}
/* Identity on the left, the figure on the right: the two things a user scans for. */
.muse-row-main{display:flex;align-items:flex-start;gap:12px;}
.muse-row-ident{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto;}
.muse-row-name{line-height:22px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.muse-row-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
/* The allowance figure. Deliberately the largest thing in the row. */
/* A button that reads as a figure: no chrome of its own, but a hover surface so the
   refresh action is discoverable. Flex is re-declared after the reset, which clears it. */
.muse-row-quota{all:unset;cursor:pointer;box-sizing:border-box;flex:0 0 auto;
  display:flex;flex-direction:column;align-items:flex-end;gap:0;
  min-width:56px;line-height:1;padding:2px 4px;border-radius:6px;}
.muse-row-quota:hover{background:var(--dsw-alias-bg-layer-2);}
.muse-row-quota:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.muse-row-quota[disabled]{cursor:default;opacity:.6;}
.muse-row-quota[disabled]:hover{background:transparent;}
.muse-quota-value{font-size:20px;font-weight:600;line-height:26px;letter-spacing:-0.01em;
  color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}
/* Figure and action on one line: the number is what the click changes, so the label sits
   beside it rather than under it. */
.muse-quota-line{display:flex;align-items:baseline;gap:6px;}
.muse-quota-action{font-size:12px;line-height:18px;
  color:color-mix(in srgb, var(--dsw-alias-brand-primary) 78%, transparent);}
.muse-row-quota:hover .muse-quota-action{color:var(--dsw-alias-brand-primary);}
.muse-quota-label{font-size:12px;line-height:16px;margin-top:2px;
  color:var(--dsw-alias-label-secondary);white-space:nowrap;}
/* Colour follows how much is LEFT, so a spent allowance reads as a warning at a
   glance and matches the composer pill's thresholds. */
.muse-row-quota[data-tone="high"] .muse-quota-value{color:var(--dsw-alias-state-warn-primary);}
.muse-row-quota[data-tone="full"] .muse-quota-value{color:var(--dsw-alias-state-warn-primary);}
.muse-row-quota[data-tone="none"] .muse-quota-value{font-size:12px;font-weight:500;
  color:var(--dsw-alias-label-secondary);}
.muse-row-context{line-height:22px;font-size:14px;margin-top:-2px;}
/* Pills, not boxes: a 999px radius is why the reference's tags read as labels rather
   than as tiny buttons. */
.muse-tag{font-size:12px;padding:1px 8px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);white-space:nowrap;line-height:1.6;}
/* Colour marks the exception. A working account is the norm, so it is quiet: a filled
   dot rather than a coloured outline, and no bold. */
.muse-tag--ok{color:var(--dsw-alias-label-secondary);border-color:transparent;
  background:var(--dsw-alias-bg-layer-2);}
.muse-tag--ok::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;
  margin-right:4px;vertical-align:1px;background:var(--dsw-alias-state-success-primary);}
/* A setup gap is neutral, not a warning: nothing is wrong yet. */
.muse-tag--warn{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);}
/* These two earn their colour: they mean "needs you now". */
.muse-tag--bad{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}
.muse-tag--sel{color:var(--dsw-alias-brand-primary);border-color:currentColor;font-weight:500;}
.muse-meta{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px;}
/* A titled block inside the card: same rhythm as the account list, one step quieter
   than the page title so the hierarchy reads at a glance. */
/* Tab strip: an underline row, not pills. It sits under the page intro and reads as a
   filter over the same page rather than a second navigation level. */
.muse-tabs{display:flex;align-items:center;gap:4px;margin:2px 0 0;
  border-bottom:1px solid var(--dsw-alias-border-l1);}
.muse-tab{all:unset;cursor:pointer;padding:6px 10px;font-size:14px;line-height:20px;
  color:var(--dsw-alias-label-secondary);border-bottom:2px solid transparent;
  margin-bottom:-1px;border-radius:4px 4px 0 0;white-space:nowrap;}
.muse-tab:hover{color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);}
.muse-tab[data-active="true"]{color:var(--dsw-alias-label-primary);font-weight:600;
  border-bottom-color:var(--dsw-alias-brand-primary);}
.muse-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}

.muse-section,.muse-foot{min-width:0;display:flex;flex-direction:column;gap:12px;padding:12px 16px;
  border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));
  border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));}
.muse-section--settings{padding:0;border:0;border-radius:0;background:transparent;gap:0;}
.muse-section-title{margin:0;line-height:22px;font-size:14px;font-weight:600;letter-spacing:0.01em;
  color:var(--dsw-alias-label-primary);}

/* Week summary: three figures with their labels, aligned like the account quota. */
.muse-facts{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;}
.muse-fact{display:flex;align-items:baseline;gap:4px;line-height:18px;font-size:12px;
  color:var(--dsw-alias-label-secondary);}
.muse-fact strong{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums;}

/* One generation per row: kind, when and which account, then cost. */
.muse-history{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2);}
.muse-history-row{display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 0;box-sizing:border-box;
  line-height:20px;font-size:14px;color:var(--dsw-alias-label-primary);}
.muse-history-row + .muse-history-row{border-top:.5px solid var(--dsw-alias-border-l2);}
.muse-history-kind{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary);}
.muse-history-main{display:flex;align-items:baseline;gap:8px;flex:1 1 auto;min-width:0;}
.muse-history-when{color:var(--dsw-alias-label-primary);white-space:nowrap;}
.muse-history-acct{color:var(--dsw-alias-label-primary);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.muse-history-meta{flex:0 0 auto;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary);}

.muse-fields{display:flex;flex-direction:column;}
.muse-field{display:flex;align-items:center;justify-content:space-between;gap:24px;
  min-width:0;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.muse-field-copy{display:flex;flex-direction:column;gap:4px;min-width:0;}
.muse-field-label{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);}
.muse-field-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.muse-input--num{width:84px;min-width:0;flex:none;text-align:end;font-variant-numeric:tabular-nums;}
.muse-switch{appearance:none;position:relative;flex:none;box-sizing:border-box;width:36px;height:22px;margin:0;
  border:1px solid var(--dsw-alias-border-l3);border-radius:11px;background:var(--dsw-alias-bg-overlay);cursor:pointer;}
.muse-switch::before{content:"";position:absolute;inset-block-start:2px;inset-inline-start:2px;width:16px;height:16px;
  border-radius:50%;background:var(--dsw-alias-switch-thumb);box-shadow:0 1px 3px var(--dsw-alias-border-l4);}
.muse-switch:checked{background:var(--dsw-alias-button-primary-fill);border-color:transparent;}
.muse-switch:checked::before{inset-inline-start:16px;background:var(--dsw-alias-label-primary-foreground);}
.muse-section--settings > .muse-card-actions{margin-top:16px;}
@media (forced-colors:active){.muse-switch{appearance:auto;}.muse-switch::before{display:none;}}
.muse-btn--tiny{padding:2px 6px;font-size:12px;}

/* Diagnostics: a definition list, two columns, quietest type on the page. */
.muse-diag{margin-top:20px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l2);}
.muse-diag h5{margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.04em;
  text-transform:uppercase;color:var(--dsw-alias-label-primary);}
.muse-diag dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0;font-size:12px;}
.muse-diag dt{color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.muse-diag dd{margin:0;color:var(--dsw-alias-label-primary);word-break:break-all;}

.muse-foot{gap:8px;}
.muse-foot-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.muse-foot-figs{display:flex;align-items:baseline;gap:16px;flex:1 1 auto;min-width:0;}
.muse-foot-fig{display:flex;align-items:baseline;gap:4px;line-height:18px;font-size:12px;
  color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.muse-foot-fig strong{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums;}
.muse-foot-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;}
/* Where the data lives: the quietest thing on the page, and allowed to wrap. */
.muse-foot-paths{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);
  word-break:break-all;}
.muse-notice{font-size:12px;line-height:1.6;padding:6px 8px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.muse-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary);
  border-color:var(--dsw-alias-state-error-primary);}
.muse-notice[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);
  border-color:var(--dsw-alias-state-warn-primary);}
.muse-notice[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);
  border-color:var(--dsw-alias-state-success-primary);}
.muse-spacer{flex:1 1 auto;}
`;

    /** Install this plugin's stylesheet once per slot entry. */
    function useStyleTag() {
      useEffect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-muse-media";
        tag.textContent = STYLE;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, []);
    }

    /**
     * Hover tooltip portaled to `document.body`.
     *
     * The composer dock clips overflow and the slot catalog says fixed overlays
     * must portal, so the tip cannot live inside the pill.
     */
    function Tooltip({ rows, anchor }) {
      if (rows.length === 0 || anchor === undefined) return null;
      const reactDom = require("react-dom");
      const width = 280;
      const height = rows.length * 18 + 16;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      const top = Math.max(8, anchor.top - height - 10);
      return reactDom.createPortal(
        h(
          "div",
          { className: "muse-tip", role: "tooltip", style: { top, left } },
          rows.map((row, index) =>
            h(
              "div",
              { className: "muse-tip-row", key: index },
              h("span", { className: "muse-tip-key" }, row.key),
              h("span", null, row.value),
            ),
          ),
        ),
        document.body,
      );
    }

    /* ---------------- pill ---------------- */

    /**
     * The composer pill.
     *
     * It is a **readout**, not a control. The number comes from the Host, which
     * refreshes it on its own timer (`autoRefreshQuotaSeconds`) whenever a
     * browser is already running — so the figure follows usage without the user
     * pressing anything, and without a window ever appearing to fetch it. A
     * manual refresh button was removed deliberately: it asked the user to do
     * work the Host can do itself, and on a LAN-bound Host the route behind it
     * answers 403 (A8), so it failed in exactly the setup it was meant to help.
     *
     * The data source is the account snapshot, not the quota route, for the same
     * reason: one read serves the pill and the settings card, and it carries the
     * account the *task* is using (A4).
     */
    function MuseQuotaPill({ ctx }) {
      useStyleTag();
      const locale = useLocale(ctx);
      const t = makeTranslate(locale);
      const [view, setView] = useState(undefined);
      const [tip, setTip] = useState(undefined);

      const load = useCallback(async () => {
        try {
          setView(await fetchJson(ACCOUNTS_PATH));
        } catch (error) {
          setView({ quota: { show: true, ok: false, status: "error", reason: String(error) } });
        }
      }, []);

      useEffect(() => {
        void load();
        // Faster than the Host's own refresh so a number that changed while the
        // tab was hidden appears promptly; this is a cheap local read.
        const timer = setInterval(() => {
          void load();
        }, PILL_INTERVAL_MS);
        return () => {
          clearInterval(timer);
        };
      }, [load]);

      // The snapshot carries the pill's own block plus the account list, so the
      // numbers and the account label come from one consistent read. The Host
      // puts the live figure on the selected (or the running task's) account.
      const quota = view === undefined ? undefined : view.quota ?? view;
      if (quota === undefined || quota.show === false) return null;

      // The account the number belongs to: the running task's account when a
      // task is active, otherwise the hand-picked one (G2/A4).
      const accounts = view.accounts ?? [];
      const activeAccount =
        quota.account !== undefined
          ? quota.account
          : (accounts.find((entry) => entry.selected === true) ??
            accounts.find((entry) => entry.status === "ready"));
      const live = activeAccount?.quota;

      const busy = typeof quota.busy === "string" && quota.busy !== "";
      const hasNumber = typeof live?.usedPct === "number";
      const stale = live?.stale === true;
      /**
       * Warn before the weekly allowance runs out.
       *
       * This is the cheap half of the "don't waste expiring quota" problem: the
       * loss comes from *not noticing*, and until now the pill looked identical at
       * 4% and 96%. Two thresholds, because the two states differ:
       *
       *   - `high` (>= 80%) means the allowance is nearly spent — route to another
       *     account if one is available, or expect the extra allowance to take over.
       *   - `full` (>= 100%) means the weekly allowance is gone. Generations
       *     continue on the extra allowance, which never expires, so this is a
       *     change of source rather than a stop — worth a distinct colour so it is
       *     not misread as "generation will fail".
       */
      const usedPct = hasNumber ? live.usedPct : undefined;
      const warning =
        usedPct === undefined ? undefined : usedPct >= 100 ? "full" : usedPct >= 80 ? "high" : undefined;
      const state = busy
        ? "busy"
        : hasNumber
          ? stale
            ? "stale"
            : warning === undefined
              ? "ok"
              : warning === "full"
                ? "full"
                : "high"
          : activeAccount === undefined || live === undefined
            ? "unknown"
            : "waiting";
      const text = hasNumber
        ? t("pill.used", { pct: live.usedPct })
        : busy
          ? t("pill.busy")
          : t("pill.unknown");

      const rows = [];
      if (activeAccount !== undefined) {
        /**
         * Idle and running are different claims about the same name.
         *
         * Idle, the figure belongs to the account someone is looking at — the next run may
         * order usable accounts by the reset date of their weekly allowance and choose another.
         * During a run, it belongs to the account actually paying. Saying which is which is what
         * keeps "acc-01 · 25%" from being read as a promise about the next generation.
         */
        rows.push({
          key: t("pill.account"),
          value: `${activeAccount.label} ${"·"} ${
            quota.duringTask === true ? t("pill.accountRunning") : t("pill.accountViewing")
          }`,
        });
      }
      if (live?.plan !== undefined) rows.push({ key: t("pill.plan"), value: live.plan });
      if (live?.reset !== undefined) rows.push({ key: t("pill.reset"), value: live.reset });
      /**
       * Say, in words, what the colour means. A warning that only changes shade
       * is easy to miss and impossible to act on.
       */
      if (warning === "high") {
        rows.push({
          key: t("pill.warn"),
          value: live?.accountCount === 1 || (view?.accounts ?? []).filter((a) => a.usable === true).length < 2
            ? t("pill.warnHighSolo")
            : t("pill.warnHighMulti"),
        });
      } else if (warning === "full") {
        rows.push({
          key: t("pill.warn"),
          value:
            live?.extraUsedPct === undefined
              ? t("pill.warnFullNoExtra")
              : t("pill.warnFullExtra"),
        });
      }
      /**
       * The two budgets are stated separately, because they are separate.
       *
       * `usedPct` is the free weekly allowance — the number the pill shows. The
       * extra allowance never expires and is counted on its own, so it gets its
       * own rows instead of being added to the weekly figure.
       */
      if (live?.extraUsedPct !== undefined || live?.extraLeft !== undefined) {
        const extra = [];
        if (live?.extraUsedPct !== undefined) extra.push(t("pill.usedShort", { pct: live.extraUsedPct }));
        if (live?.extraLeft !== undefined) extra.push(live.extraLeft);
        rows.push({ key: t("pill.extra"), value: extra.join(" · ") });
      }
      if (live?.at !== undefined) rows.push({ key: t("pill.updated"), value: relativeTime(live.at, locale) });
      // Always say how the number stays current, so "0%" never looks stuck.
      rows.push({
        key: t("pill.source"),
        value: hasNumber ? t("pill.autoRefresh") : t("pill.pendingRefresh"),
      });
      if (live?.error !== undefined) rows.push({ key: "-", value: live.error });
      if (quota.busy !== undefined) rows.push({ key: "-", value: quota.busy });

      return h(
        "div",
        {
          className: "muse-pill",
          "data-state": state,
          onMouseEnter: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setTip({ left: rect.left, top: rect.top });
          },
          onMouseLeave: () => setTip(undefined),
        },
        h("span", { className: "muse-pill-dot", "aria-hidden": "true" }),
        h("span", { className: "muse-pill-label" }, t("pill.label")),
        h("span", null, text),
        quota.showLabel && activeAccount !== undefined
          ? h("span", { className: "muse-pill-acct" }, `\u00B7 ${activeAccount.label}`)
          : null,
        h(Tooltip, { rows, anchor: tip }),
      );
    }

    /* ---------------- settings card ---------------- */

    /**
     * One account, as a row that can be scanned rather than read.
     *
     * The previous shape printed four facts at equal weight in one line — quota,
     * plan, reset, "updated N ago", "last used N ago" — so nothing stood out and two
     * of them ("updated" and "last used") said nearly the same thing. A settings
     * page is scanned for one question first ("which account can run, and how much
     * has it got left"), so:
     *
     *   - the **percentage is a number**, set apart and coloured by how much is
     *     left, because it is the one figure a user comes here to read;
     *   - the secondary facts collapse to one quiet line, with the redundant
     *     timestamps merged into a single "last used";
     *   - the actions split into the one that matters (sign in / verify, depending
     *     on state) and a "more" disclosure for maintenance and deletion.
     */
    function AccountRow({ account, t, locale, busy, pending, onAction }) {
      const [confirming, setConfirming] = useState(false);
      const statusText = t(`settings.status.${account.status}`);
      const statusTone =
        account.status === "ready" && account.usable ? "ok" : account.status === "needs-login" ? "bad" : "warn";

      const probe = account.probe;
      const probeNode =
        probe !== undefined && probe.checkedAt !== undefined
          ? h(
              "span",
              {
                className: `muse-tag muse-tag--${
                  probe.ok === true ? (probe.formatMismatch ? "warn" : "ok") : "bad"
                }`,
                title: probe.note ?? "",
              },
              `${
                probe.ok === true
                  ? probe.formatMismatch
                    ? t("settings.probe.format")
                    : t("settings.probe.ok")
                  : probe.code === "PROBE_INCOMPLETE" || probe.code === "PROBE_TIMEOUT"
                    ? t("settings.probe.timeout")
                    : t("settings.probe.failed")
              } \u00B7 ${relativeTime(probe.checkedAt, locale)}`,
            )
          : h("span", { className: "muse-meta" }, t("settings.probe.never"));

      const quota = account.quota;
      const hasQuota = quota !== undefined && quota.usedPct !== undefined;

      /**
       * How much of the weekly allowance is left, as a tone.
       *
       * The figure is a *used* percentage, so the colour has to invert the meaning:
       * a high number is the bad end. Thresholds match the composer pill's, so the
       * two surfaces never disagree about what "nearly spent" looks like.
       */
      const quotaTone = !hasQuota
        ? "none"
        : quota.usedPct >= 100
          ? "full"
          : quota.usedPct >= 80
            ? "high"
            : "ok";

      // One quiet line of context. `quotaUpdated` and `lastUsed` are merged: the
      // panel is read right after a generation, so they answer the same question.
      const contextParts = [
        quota !== undefined && quota.plan !== undefined ? quota.plan : undefined,
        quota !== undefined && quota.reset !== undefined
          ? `${t("settings.quotaReset")} ${quota.reset}`
          : undefined,
        `${t("settings.lastUsed")} ${
          account.lastUsedAt === undefined
            ? t("settings.never")
            : relativeTime(account.lastUsedAt, locale)
        }`,
        quota !== undefined && quota.error !== undefined ? quota.error : undefined,
        account.usable !== true ? account.usableReason : undefined,
      ].filter((entry) => typeof entry === "string" && entry !== "");

      const disabled = pending !== undefined;
      const button = (action, label, options) =>
        h(
          "button",
          {
            type: "button",
            className: `muse-btn${options?.primary ? " muse-btn--primary" : ""}${
              options?.danger ? " muse-btn--danger" : ""
            }`,
            disabled: disabled || (busy && action !== "quit-browser"),
            onClick: () => onAction(action, account.id),
          },
          label,
        );

      /**
       * The one action this account most likely needs.
       *
       * A never-signed-in account needs a window; a ready one needs verification
       * only when something looks wrong; a signed-out one needs to sign in again.
       * Everything else is maintenance and goes behind "more".
       */
      const needsSignIn = account.status === "new" || account.status === "needs-login";
      /**
       * A working account has no primary action.
       *
       * Verification already happened — the row says 可用 — so making "verify" the loudest
       * control asks the user to redo something that succeeded. Signing in is the only state
       * that genuinely blocks work, and that is the only one that gets the filled button.
       */
      const primaryAction = needsSignIn
        ? button("login", pending === "login" ? t("settings.loginPending") : t("settings.login"), {
            primary: true,
          })
        : null;

      return h(
        "div",
        { className: "muse-row", "data-selected": account.selected === true },
        h(
          "div",
          { className: "muse-row-main" },
          // Identity column: name, state, and which account is the hand-picked one.
          h(
            "div",
            { className: "muse-row-ident" },
            h("strong", { className: "muse-row-name" }, account.label),
            h(
              "div",
              { className: "muse-row-tags" },
              h("span", { className: `muse-tag muse-tag--${statusTone}` }, statusText),
              account.selected
                ? h(
                    "span",
                    { className: "muse-tag muse-tag--sel", title: t("settings.selectedHint") },
                    t("settings.selected"),
                  )
                : null,
              account.running ? h("span", { className: "muse-tag" }, t("settings.running")) : null,
              probeNode,
            ),
          ),
          /**
           * The figure the page exists to answer — and the control that refreshes it.
           *
           * "Read the quota" was a button competing for room with four others. The number
           * is what it updates, so the number is where it belongs: one click re-reads the
           * panel, and the row gains back a button of width.
           */
          h(
            "button",
            {
              type: "button",
              className: "muse-row-quota",
              "data-tone": quotaTone,
              title: t("settings.refreshQuota"),
              "aria-label": t("settings.refreshQuota"),
              disabled: disabled || busy,
              onClick: () => onAction("refresh-quota", account.id),
            },
            h(
              "div",
              { className: "muse-quota-line" },
              h(
                "span",
                { className: "muse-quota-value" },
                hasQuota ? `${quota.usedPct}%` : t("settings.quotaNeverShort"),
              ),
              h("span", { className: "muse-quota-action" }, t("settings.refreshShort")),
            ),
            /**
             * State and action share one line under the figure: what it measures on the
             * left, what a click does on the right. The caption used to be here and the
             * action was invisible, which is why nobody found refresh.
             */
            hasQuota
              ? h(
                  "div",
                  { className: "muse-quota-label" },
                  `${t("settings.quotaUsedShort")}${quota.stale ? ` ${t("settings.quotaStale")}` : ""}`,
                )
              : null,
          ),
        ),
        h("div", { className: "muse-meta muse-row-context" }, contextParts.join(" \u00B7 ")),
        h(
          "div",
          { className: "muse-card-actions" },
          primaryAction,
          /**
           * Maintenance actions are shown, not hidden behind a disclosure.
           *
           * "More" cost two clicks to reach four buttons that fit on one line anyway,
           * and it hid the very actions a user opens this page to reach — read the
           * quota, run the test, switch accounts. The recessed strip keeps them
           * visually second without making them hidden.
           */
          h(
            "div",
            { className: "muse-actions-more" },
            // Verification is available but not advertised: it is a re-check, not a step.
            needsSignIn
              ? null
              : button("verify", pending === "verify" ? t("settings.verifyPending") : t("settings.verify")),
            button("probe", pending === "probe" ? t("settings.testPending") : t("settings.test")),
            account.selected ? null : button("select", t("settings.select")),
            account.running ? button("quit-browser", t("settings.quit")) : null,
          ),
          h("span", { className: "muse-spacer" }),
          confirming
            ? h(
                React.Fragment,
                null,
                h("span", { className: "muse-meta" }, t("settings.removeConfirm", { label: account.label })),
                h(
                  "button",
                  {
                    type: "button",
                    className: "muse-btn muse-btn--danger",
                    disabled: disabled || busy,
                    onClick: () => {
                      setConfirming(false);
                      onAction("remove", account.id);
                    },
                  },
                  t("settings.remove"),
                ),
                h(
                  "button",
                  { type: "button", className: "muse-btn", onClick: () => setConfirming(false) },
                  "\u00D7",
                ),
              )
            : h(
                "button",
                {
                  type: "button",
                  // Quiet by default: deletion is not a peer of "sign in".
                  className: "muse-btn muse-btn--quiet muse-btn--danger-quiet",
                  disabled: disabled || busy,
                  onClick: () => setConfirming(true),
                },
                t("settings.remove"),
              ),
        ),
      );
    }

    /**
     * What the account has been generating, and what it cost.
     *
     * The journal already held this; the page never showed it, so a user could not
     * see which account paid for which picture, or what a video costs relative to an
     * image. Costs are shown per task and summarised for the last week, because the
     * weekly allowance is the budget that expires.
     */
    function HistorySection({ history, t, locale }) {
      const [expandedAll, setExpandedAll] = useState(false);
      const shown = expandedAll ? history : history.slice(0, 5);

      /**
       * Cost of one task, when both readings exist.
       *
       * New tasks receive both readings together when one submission can be
       * attributed to their interval. Older or unmeasured tasks may lack either.
       */
      const cost = (task) =>
        typeof task.quotaBefore === "number" && typeof task.quotaAfter === "number"
          ? Math.max(0, task.quotaAfter - task.quotaBefore)
          : undefined;

      // A week is the allowance's own period.
      const weekAgo = Date.now() - 7 * 24 * 3600_000;
      const weekTasks = history.filter((task) => (task.at ?? 0) >= weekAgo);
      const weekCost = weekTasks.reduce((sum, task) => sum + (cost(task) ?? 0), 0);
      const weekImages = weekTasks.filter((task) => task.kind === "image").length;
      const weekVideos = weekTasks.filter((task) => task.kind === "video").length;

      return h(
        "div",
        { className: "muse-section" },
        h("h4", { className: "muse-section-title" }, t("settings.history")),
        h(
          "div",
          { className: "muse-facts" },
          h(
            "span",
            { className: "muse-fact" },
            h("strong", null, String(weekImages)),
            h("span", null, t("settings.historyImages")),
          ),
          h(
            "span",
            { className: "muse-fact" },
            h("strong", null, String(weekVideos)),
            h("span", null, t("settings.historyVideos")),
          ),
          h(
            "span",
            { className: "muse-fact" },
            h("strong", null, weekCost > 0 ? `+${weekCost}%` : "—"),
            h("span", null, t("settings.historyCost")),
          ),
        ),
        h(
          "div",
          { className: "muse-history" },
          shown.map((task) =>
            h(
              "div",
              { className: "muse-history-row", key: task.id, "data-state": task.state },
              h("span", { className: "muse-history-kind" }, task.kind === "video" ? "\u25B6" : "\u25A0"),
              h(
                "span",
                { className: "muse-history-main" },
                h("span", { className: "muse-history-when" }, relativeTime(task.at, locale)),
                task.account === undefined ? null : h("span", { className: "muse-history-acct" }, task.account),
              ),
              h(
                "span",
                { className: "muse-history-meta" },
                [
                  task.durationMs === undefined ? undefined : `${Math.round(task.durationMs / 1000)}s`,
                  cost(task) === undefined ? undefined : `+${cost(task)}%`,
                ]
                  .filter(Boolean)
                  .join(" \u00B7 ") || "\u2014",
              ),
              // A task that did not deliver says so, because "silent absence" and
              // "did not finish" are different and only one needs attention.
              task.state === "delivered"
                ? null
                : task.state === "generated-unsaved"
                ? h("span", { className: "muse-tag muse-tag--warn", title: task.note }, t("settings.stateUnsaved"))
                : h("span", { className: `muse-tag muse-tag--${task.state === "unknown" ? "warn" : "bad"}`, title: task.note },
                    task.state === "unknown" ? t("settings.stateUnknown") : t("settings.stateFailed")),
            ),
          ),
        ),
        history.length > 5
          ? h(
              "button",
              {
                type: "button",
                className: "muse-btn muse-btn--quiet muse-btn--tiny",
                onClick: () => setExpandedAll((open) => open !== true),
              },
              expandedAll ? t("settings.less") : t("settings.showAll"),
            )
          : null,
      );
    }

    /**
     * The settings that shape how the browser and the timeouts behave.
     *
     * Held as local draft state and written on one button, because these are values
     * whose effect the user cannot see immediately — a slider that saves on every
     * keystroke would restart the browser mid-typing.
     */
    function SettingsSection({ settings, diagnostics, t, pending, onSave }) {
      const [draft, setDraft] = useState({});
      const value = (key) => (key in draft ? draft[key] : settings[key]);
      const dirty = Object.keys(draft).some((key) => draft[key] !== settings[key]);

      const fieldCopy = (label, hint) =>
        h(
          "span",
          { className: "muse-field-copy" },
          h("span", { className: "muse-field-label" }, label),
          hint === undefined ? null : h("span", { className: "muse-field-hint" }, hint),
        );

      const toggle = (key, label, hint) =>
        h(
          "label",
          { className: "muse-field" },
          fieldCopy(label, hint),
          h("input", {
            type: "checkbox",
            role: "switch",
            className: "muse-switch",
            checked: value(key) === true,
            onChange: (event) => setDraft({ ...draft, [key]: event.target.checked }),
          }),
        );

      const numberField = (key, label, hint, min, max) =>
        h(
          "label",
          { className: "muse-field" },
          fieldCopy(label, hint),
          h("input", {
            type: "number",
            className: "muse-input muse-input--num",
            value: String(value(key) ?? ""),
            min,
            max,
            onChange: (event) =>
              setDraft({ ...draft, [key]: event.target.value === "" ? "" : Number(event.target.value) }),
          }),
        );

      return h(
        "div",
        { className: "muse-section muse-section--settings" },
        h("h4", { className: "muse-section-title" }, t("settings.advanced")),
        h(
          "div",
          { className: "muse-fields" },
          toggle("headlessAfterLogin", t("settings.fieldHeadless"), t("settings.fieldHeadlessHint")),
          toggle("showQuotaInComposer", t("settings.fieldPill"), t("settings.fieldPillHint")),
          numberField("idleReapSeconds", t("settings.fieldIdle"), t("settings.fieldIdleHint"), 0, 86400),
          numberField("maxLiveBrowsers", t("settings.fieldConcurrent"), t("settings.fieldConcurrentHint"), 0, 8),
          numberField("autoRefreshQuotaSeconds", t("settings.fieldRefresh"), t("settings.fieldRefreshHint"), 0, 86400),
          numberField("imageTimeoutSeconds", t("settings.fieldImageTimeout"), undefined, 30, 1800),
          numberField("videoTimeoutSeconds", t("settings.fieldVideoTimeout"), undefined, 60, 3600),
        ),
        h(
          "div",
          { className: "muse-card-actions" },
          h(
            "button",
            {
              type: "button",
              className: "muse-btn muse-btn--primary",
              disabled: !dirty || pending !== undefined,
              onClick: () => {
                onSave(draft);
                setDraft({});
              },
            },
            dirty ? t("settings.save") : t("settings.saved"),
          ),
          dirty
            ? h(
                "button",
                { type: "button", className: "muse-btn muse-btn--quiet", onClick: () => setDraft({}) },
                t("settings.discard"),
              )
            : null,
          h("span", { className: "muse-spacer" }),
          h(
            "span",
            { className: "muse-field-hint" },
            t("settings.needsRestartHint"),
          ),
        ),
        /**
         * Diagnostics: read-only facts that make a bug report actionable without
         * asking the user to hunt through `~/.dsh`.
         */
        diagnostics === undefined
          ? null
          : h(
              "div",
              { className: "muse-diag" },
              h("h5", null, t("settings.diagnostics")),
              h(
                "dl",
                null,
                [
                  [t("settings.diagState"), diagnostics.stateRoot],
                  [t("settings.diagTasks"), String(diagnostics.taskCount ?? 0)],
                  [t("settings.diagMedia"), String(diagnostics.mediaCount ?? 0)],
                  [t("settings.diagBrowsers"), String(diagnostics.browserRunning ?? 0)],
                  [
                    t("settings.diagChrome"),
                    diagnostics.chromeSource === "config" ? t("settings.diagChromeConfig") : t("settings.diagChromeAuto"),
                  ],
                ].map(([key, val]) =>
                  h(
                    React.Fragment,
                    { key },
                    h("dt", null, key),
                    h("dd", null, String(val ?? "—")),
                  ),
                ),
              ),
            ),
      );
    }

    /**
     * Disk usage and the one destructive action on this page.
     *
     * Split out because it belongs with the accounts — they are what fill the disk — and
     * because the clear action needs its own confirmation state, which should not sit in
     * the card's state next to the account form.
     */
    function DiskFooter({ snapshot, t, pending, confirmingMedia, setConfirmingMedia, onClear }) {
      if (snapshot === undefined || snapshot.browser?.path === undefined) return null;
      const profileTotal = Object.values(snapshot.profileBytes ?? {}).reduce(
        (sum, value) => sum + (value ?? 0),
        0,
      );
      const hasMedia = (snapshot.mediaBytes ?? 0) > 0;

      return h(
        "div",
        { className: "muse-foot" },
        h(
          "div",
          { className: "muse-foot-row" },
          h(
            "div",
            { className: "muse-foot-figs" },
            snapshot.profileBytes === undefined
              ? null
              : h(
                  "span",
                  { className: "muse-foot-fig" },
                  h("strong", null, formatBytes(profileTotal)),
                  h("span", null, t("settings.diskProfiles")),
                ),
            snapshot.mediaBytes === undefined
              ? null
              : h(
                  "span",
                  { className: "muse-foot-fig" },
                  h("strong", null, formatBytes(snapshot.mediaBytes)),
                  h("span", null, t("settings.diskMedia")),
                ),
          ),
          /**
           * Clearing media is offered, never automatic.
           *
           * The plugin does not delete delivered files on its own: each one cost real
           * quota and is linked from the conversation message that announced it, so
           * removing one breaks that message. The user decides — and since the action
           * cannot be undone, it takes a second click.
           */
          hasMedia
            ? h(
                "div",
                { className: "muse-foot-actions" },
                confirmingMedia
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        "button",
                        {
                          type: "button",
                          className: "muse-btn muse-btn--danger",
                          disabled: pending !== undefined,
                          onClick: () => {
                            setConfirmingMedia(false);
                            onClear();
                          },
                        },
                        t("settings.clearMediaConfirm"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "muse-btn muse-btn--quiet",
                          onClick: () => setConfirmingMedia(false),
                        },
                        t("settings.cancel"),
                      ),
                    )
                  : h(
                      "button",
                      {
                        type: "button",
                        className: "muse-btn muse-btn--quiet",
                        disabled: pending !== undefined,
                        title: t("settings.clearMediaHint"),
                        onClick: () => setConfirmingMedia(true),
                      },
                      t("settings.clearMedia"),
                    ),
              )
            : null,
        ),
        h("div", { className: "muse-foot-paths" }, `${t("settings.browser")}: ${snapshot.browser.path}`),
        h("div", { className: "muse-foot-paths" }, `${t("settings.profiles")}: ${snapshot.paths.profiles}`),
      );
    }

    function MuseSettingsCard({ ctx }) {
      useStyleTag();
      const locale = useLocale(ctx);
      const t = makeTranslate(locale);
      const [snapshot, setSnapshot] = useState(undefined);
      const [label, setLabel] = useState("");
      const [pending, setPending] = useState(undefined);
      const [notice, setNotice] = useState(undefined);
      /** Account whose sign-in window is open and whose session is being watched. */
      const [watching, setWatching] = useState(undefined);
      /** Media clearing is destructive and irreversible, so it takes two clicks. */
      const [confirmingMedia, setConfirmingMedia] = useState(false);
      /** The label field is hidden until someone asks to add an account. */
      const [adding, setAdding] = useState(false);
      /**
       * Which pane is showing.
       *
       * Everything used to be one column — accounts, history, settings, diagnostics,
       * footer — separated by rules. That reads as a single very long form, and on a
       * 700px-wide settings panel it buries the account list under three sections a
       * user only visits occasionally. `settings.section` gives one page, so the split
       * has to live inside the component: three panes with one always visible.
       *
       * Accounts is the default because adding and signing in is what people open
       * this page to do.
       */
      const [pane, setPane] = useState("accounts");

      const load = useCallback(
        async () => {
          try {
            setSnapshot(await fetchJson(ACCOUNTS_PATH));
          } catch (error) {
            setNotice({ kind: "error", text: `${t("settings.readFailed")}${String(error)}` });
          }
        },
        [t],
      );

      useEffect(() => {
        void load();
      }, [load]);

      /**
       * Watch an open sign-in window.
       *
       * The Host's `login` answers as soon as the window exists, because a
       * person may need minutes. So the card asks the Host's own authenticated
       * check every few seconds instead of leaving the user to press "verify"
       * after they already signed in.
       *
       * Two stopping conditions, both required:
       *   - the account turns usable, or
       *   - the window is gone. A person who closed the sign-in window decided
       *     not to sign in; the Host's `verify` never launches a browser, so
       *     continuing to poll cannot resurrect the window either.
       */
      useEffect(() => {
        if (watching === undefined) return undefined;
        let live = true;
        let tries = 0;
        let timer;
        const tick = async () => {
          if (!live) return;
          tries += 1;
          try {
            const result = await fetchJson(ACTION_PATH, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "verify", accountId: watching }),
            });
            if (!live) return;
            if (result?.snapshot !== undefined) setSnapshot(result.snapshot);
            if (result?.ok === true) {
              setNotice({ kind: "ok", text: t("settings.status.ready") });
              setWatching(undefined);
              return;
            }
            const row = (result?.snapshot?.accounts ?? []).find((entry) => entry.id === watching);
            if (row !== undefined && row.running !== true) {
              setNotice({ kind: "warn", text: t("settings.loginClosed") });
              setWatching(undefined);
              return;
            }
          } catch {
            /* the user may still be on the sign-in page; keep waiting */
          }
          if (!live) return;
          if (tries >= LOGIN_WATCH_TRIES) {
            setWatching(undefined);
            return;
          }
          timer = setTimeout(tick, LOGIN_WATCH_INTERVAL_MS);
        };
        timer = setTimeout(tick, 2_500);
        return () => {
          live = false;
          clearTimeout(timer);
        };
      }, [watching, t]);

      const runAction = useCallback(
        async (action, accountId, extra) => {
          setPending(action);
          setNotice(undefined);
          try {
            const result = await fetchJson(ACTION_PATH, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action, accountId, ...(extra ?? {}) }),
            });
            if (result?.snapshot !== undefined) setSnapshot(result.snapshot);
            /**
             * A settings save reports which keys landed.
             *
             * The Host validates and clamps each value, so a rejected field must not
             * look identical to a successful save.
             */
            if (action === "save-settings" && result !== undefined) {
              setNotice(
                result.ok === true
                  ? {
                      kind: "ok",
                      text: t("settings.savedKeys", {
                        keys: (result.changed ?? []).join(", "),
                      }),
                    }
                  : { kind: "error", text: result.error ?? t("settings.actionFailed") },
              );
            } else if (action === "clear-media" && result !== undefined) {
              /**
               * Clearing media reports what happened, in numbers.
               *
               * "Nothing happened" and "it failed" must not look the same, and the
               * user needs to know their old links stopped working.
               */
              if (result.ok === false) {
                setNotice({
                  kind: "error",
                  text: t("settings.clearMediaFailed", {
                    removed: String(result.removed ?? 0),
                    failed: String(result.failed ?? 0),
                    error: String(result.error ?? ""),
                  }),
                });
              } else {
                setNotice({
                  kind: "ok",
                  text: t("settings.clearMediaDone", {
                    removed: String(result.removed ?? 0),
                    size: formatBytes(result.bytes ?? 0),
                  }),
                });
              }
            } else if (result !== undefined && result.ok === false) {
              setNotice({ kind: "error", text: result.error ?? t("settings.actionFailed") });
            } else if (action === "probe" && result !== undefined) {
              setNotice({
                kind: result.ok === true ? (result.formatMismatch ? "warn" : "ok") : "error",
                text:
                  result.ok === true
                    ? `${result.formatMismatch ? t("settings.probe.format") : t("settings.probe.ok")} ${
                        Math.round((result.elapsedMs ?? 0) / 1000)
                      }${t("settings.seconds")}`
                    : result.note ?? t("settings.probe.failed"),
              });
            } else if (action === "login" && result !== undefined) {
              setNotice(
                result.ok === true
                  ? { kind: "ok", text: t("settings.status.ready") }
                  : { kind: "warn", text: result.note ?? t("settings.loginPending") },
              );
              // The window is up; watch it instead of asking the user to come
              // back and press a button.
              setWatching(result.ok === true ? undefined : accountId);
            } else if (action === "verify" && result !== undefined && result.verdict === "no-window") {
              setNotice({ kind: "warn", text: t("settings.loginClosed") });
            }
            await load();
          } catch (error) {
            setNotice({ kind: "error", text: String(error) });
          } finally {
            setPending(undefined);
          }
        },
        [load, t],
      );

      const busy = snapshot !== undefined && snapshot.busy !== undefined && snapshot.busy !== null;
      const accounts = snapshot === undefined ? [] : snapshot.accounts ?? [];

      return h(
        "div",
        { className: "muse-card" },
        h(
          "div",
          { className: "muse-head" },
          /**
           * The section heading belongs here.
           *
           * I removed it assuming the settings shell prints the section title above this slot.
           * It does not: the "Codex 订阅" line at the top of that page is drawn by that plugin
           * itself. So with no heading here, switching from another section into Muse lost a
           * line, and the pane started straight at the tabs.
           */
          h("h3", null, t("settings.nav")),
        /**
         * Three panes, one visible.
         *
         * The page used to be a single column: accounts, then history, then settings,
         * then diagnostics, then the disk footer. On a settings panel that is one long
         * scroll, and the account list — the reason to open this page at all — ended up
         * above three sections most people visit once. Tabs keep the default view to
         * the thing that changes: which account runs.
         */
        snapshot === undefined
          ? null
          : h(
              "div",
              { className: "muse-tabs", role: "tablist" },
              [
                { id: "accounts", label: t("settings.paneAccounts") },
                { id: "history", label: t("settings.paneHistory") },
                { id: "advanced", label: t("settings.paneAdvanced") },
              ].map((entry) =>
                h(
                  "button",
                  {
                    key: entry.id,
                    type: "button",
                    role: "tab",
                    className: "muse-tab",
                    "aria-selected": pane === entry.id,
                    "data-active": pane === entry.id,
                    onClick: () => setPane(entry.id),
                  },
                  entry.label,
                ),
              ),
            ),
        ),
        /**
         * Setup guidance shown only when it is actionable.
         *
         * With no usable account it explains the four steps, because nothing else on the page
         * can work yet. Once one is signed in it disappears: repeating installation notes on
         * every visit is what made the page feel like a manual.
         */
        snapshot === undefined
          ? null
          : accounts.some((entry) => entry.status === "ready")
            ? null
            : h(
                "div",
                { className: "muse-section" },
                h("p", null, t("settings.intro")),
                h(
                  "ol",
                  { className: "muse-steps" },
                  [t("settings.step1"), t("settings.step2"), t("settings.step3"), t("settings.step4")].map(
                    (step, index) => h("li", { key: `step-${index}` }, step),
                  ),
                ),
              ),
        busy ? h("div", { className: "muse-notice", "data-kind": "warn" }, t("settings.busy")) : null,
        notice !== undefined
          ? h("div", { className: "muse-notice", "data-kind": notice.kind }, notice.text)
          : null,
        snapshot !== undefined && (snapshot.unsent ?? []).length > 0
          ? h(
              "div",
              { className: "muse-notice", "data-kind": "warn" },
              `${t("settings.unsent")}: ${snapshot.unsent
                .map((task) => `${task.id} \u00B7 ${task.accountLabel ?? "?"} \u00B7 ${task.note ?? task.state}`)
                .join("; ")}`,
            )
          : null,
        /* ---- accounts pane ---- */
        pane !== "accounts"
          ? null
          : h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "muse-section" },
                /**
                 * A header row, not a form.
                 *
                 * The label input used to sit permanently at the top of this pane, so opening
                 * the page to read the current account meant meeting an empty text field
                 * first. Adding an account is occasional; the list is what people come for.
                 * "New account" reveals the field in place, so the flow costs the same and the
                 * default view is the list.
                 */
                h(
                  "div",
                  { className: "muse-list-head" },
                  h("h4", { className: "muse-list-title" }, t("settings.accountsTitle")),
                  h(
                    "button",
                    {
                      type: "button",
                      className: adding ? "muse-btn muse-btn--quiet" : "muse-btn",
                      disabled: pending !== undefined || busy,
                      "aria-expanded": adding === true,
                      onClick: () => {
                        setAdding((open) => open !== true);
                        setLabel("");
                      },
                    },
                    adding ? t("settings.cancel") : t("settings.addAccount"),
                  ),
                ),
                adding
                  ? h(
                      "div",
                      { className: "muse-card-actions" },
                      h("input", {
                        className: "muse-input",
                        value: label,
                        placeholder: t("settings.addHint"),
                        "aria-label": t("settings.label"),
                        autoFocus: true,
                        onChange: (event) => setLabel(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key !== "Enter" || pending !== undefined || busy) return;
                          void runAction("add", undefined, label.trim() === "" ? {} : { label });
                          setLabel("");
                          setAdding(false);
                        },
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "muse-btn muse-btn--primary",
                          /**
                           * The label is optional, so this button is never disabled for being
                           * empty. Requiring a name made it grey and inert on a fresh card —
                           * the only state a new user sees first — while the Host derives
                           * `acc-N` anyway.
                           */
                          disabled: pending !== undefined || busy,
                          onClick: () => {
                            void runAction("add", undefined, label.trim() === "" ? {} : { label });
                            setLabel("");
                            setAdding(false);
                          },
                        },
                        pending === "add" ? t("settings.addPending") : t("settings.addAccount"),
                      ),
                    )
                  : null,
                snapshot === undefined
                ? h("p", null, "\u2026")
                : accounts.length === 0
                  ? // The steps live in the page head; repeating them here said the same
                    // thing twice in one screen.
                    h("p", { className: "muse-meta" }, t("settings.empty"))
                  : h(
                      "div",
                      { className: "muse-list" },
                      accounts.map((account) =>
                        h(AccountRow, {
                          key: account.id,
                          account,
                          t,
                          locale,
                          busy,
                          pending,
                          onAction: (action, accountId) => void runAction(action, accountId),
                        }),
                      ),
                    ),
              ),
            ),
        /* ---- history pane ---- */
        pane !== "history"
          ? null
          : snapshot === undefined || (snapshot.history ?? []).length === 0
            ? h("p", { className: "muse-meta" }, t("settings.historyEmpty"))
            : h(HistorySection, { history: snapshot.history, t, locale }),
        /* ---- advanced pane ---- */
        pane !== "advanced"
          ? null
          : snapshot === undefined || snapshot.settings === undefined
            ? h("p", { className: "muse-meta" }, "\u2026")
            : h(
                React.Fragment,
                null,
                h(SettingsSection, {
                  settings: snapshot.settings,
                  diagnostics: snapshot.diagnostics,
                  t,
                  pending,
                  onSave: (patch) => void runAction("save-settings", undefined, { settings: patch }),
                }),
                /** Disk, clearing and paths: maintenance, so they live with maintenance. */
                h(DiskFooter, {
                  snapshot,
                  t,
                  pending,
                  confirmingMedia,
                  setConfirmingMedia,
                  onClear: () => void runAction("clear-media"),
                }),
              ),
        /**
         * A missing browser is stated on every pane: without one, nothing on this page
         * can work, so hiding it behind a tab would be the wrong trade.
         */
        snapshot !== undefined && snapshot.browser?.error !== undefined
          ? h(
              "div",
              { className: "muse-notice", "data-kind": "error" },
              h("strong", null, t("settings.noBrowser")),
              h("div", null, snapshot.browser.error),
              h("div", null, t("settings.noBrowserFix")),
            )
          : null,
      );
    }

    /* ---------------- plugin entry ---------------- */

    /**
     * Register both surfaces, plus the same card as its own settings page.
     *
     * `slots.inject` is the documented form: the callback's registrations are
     * disposed when the owning declaration collapses and reinstalled when it
     * returns, so the plugin survives a session switch in the composer.
     */
    function apply(ctx) {
      const Pill = (props) => h(MuseQuotaPill, { ...props, ctx });
      const Card = (props) => h(MuseSettingsCard, { ...props, ctx });

      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          { name: "conversation.composer.dock", id: "dsh-muse-media-quota", order: 12 },
          Pill,
        ),
      );

      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register({ name: "plugins.bundle.config", key: SECTION_ID }, Card),
      );

      // The same card in the Plugins settings section, which is where a user
      // looks for a plugin's configuration without hunting for its bundle page.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: SECTION_ID,
            order: 36,
            label: () => makeTranslate(readLocale(ctx))("settings.nav"),
          },
          Card,
        ),
      );

      /**
       * The nav glyph, under the same id as the section.
       *
       * `settings.section.icon` is addressed by id — the shell renders it with
       * `{ only: row.id }` and silently keeps its default glyph when nothing matches
       * — so registering the section without an icon is why this plugin's entry
       * looked like every other unconfigured row. Both registrations are made in one
       * place so the id cannot drift apart.
       *
       * The mark is a simple aperture/iris: a ring with three blades, which reads at
       * 16px and does not collide with the shipped gear, key, or grid glyphs.
       */
      ctx.slots.inject("settings.section.icon", () =>
        ctx.slots.register(
          {
            name: "settings.section.icon",
            id: SECTION_ID,
            order: 36,
          },
          MuseNavIcon,
        ),
      );
    }

    return { inject: ["slots", "locale"], apply };
  },
});
