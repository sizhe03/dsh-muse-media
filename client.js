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
      "settings.manage": "管理账号",
      "settings.closeDetails": "收起管理",
      "settings.availability": "暂不可用",
      "settings.generationSettings": "生成与显示",
      "settings.execution": "浏览器与等待时间",
      "settings.retryAccounts": "每项任务最多尝试的账号数",
      "settings.retryHint": "仅在确认登录失效时切换账号。",
      "settings.accountCount": "已添加 {count} 个账号",
      "settings.image": "图片",
      "settings.video": "视频",
      "settings.all": "全部",
      "settings.delivered": "已交付",
      "settings.unsaved": "本地保存失败",
      "settings.quotaHigh": "接近用完",
      "settings.quotaFull": "已用完",
      "settings.preview": "预览",
      "settings.hidePreview": "收起预览",
      "settings.zeroFilter": "没有这类生成记录。",
      "settings.refs": "参考素材",
      "settings.scope": "周额度",
      "settings.pendingChanges": "有未保存的更改",
      "settings.emptyAccount": "添加 Muse 账号后，打开登录窗口完成首次登录。",
      "settings.mediaMissing": "媒体文件不可用",
      "settings.updated": "额度更新",
      "settings.historyCount": "最近 {count} 条",
      "pill.label": "Muse",
      "pill.used": "周额度已用 {pct}%",
      "pill.unknown": "周额度待刷新",
      "pill.busy": "处理中",
      "pill.failed": "额度读取失败",
      "pill.previous": "上次已用 {pct}%",
      "pill.plan": "套餐",
      "pill.reset": "重置日期",
      "pill.updated": "最近更新",
      "pill.accountViewing": "查看账号",
      "pill.accountRunning": "本次操作账号",
      "pill.extra": "额外额度",
      "pill.usedShort": "已用 {pct}%",
      "pill.activity": "当前操作",
      "pill.error": "读取提示",

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
      "settings.showAll": "显示全部",
      "settings.stateUnknown": "结果未知",
      "settings.stateFailed": "未完成",
      "settings.stateUnsaved": "已生成，本地保存失败；请到该账号的 Muse 会话取回",
      "settings.save": "保存",
      "settings.saved": "已保存",
      "settings.discard": "放弃",
      "settings.fieldHeadless": "生成时不显示窗口",
      "settings.fieldHeadlessHint": "关掉会弹出浏览器窗口，只在首次登录时才有必要。",
      "settings.openBrowser": "打开浏览器",
      "settings.opening": "正在打开…",
      "settings.openMediaDir": "打开媒体文件夹",
      "settings.fieldIndependent": "独立生成",
      "settings.fieldIndependentHint":
        "生成时提醒 Muse 以本次描述和参考素材为准。长期记忆仍然开启。",
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
      "settings.test": "测试连通性",
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
      "settings.manage": "Manage account",
      "settings.closeDetails": "Close controls",
      "settings.availability": "Unavailable",
      "settings.generationSettings": "Generation & display",
      "settings.execution": "Browser & timeouts",
      "settings.retryAccounts": "Account attempts per task",
      "settings.retryHint": "Switches accounts only after a confirmed sign-out.",
      "settings.accountCount": "{count} accounts added",
      "settings.image": "Image",
      "settings.video": "Video",
      "settings.all": "All",
      "settings.delivered": "Delivered",
      "settings.unsaved": "Local save failed",
      "settings.quotaHigh": "Nearly used up",
      "settings.quotaFull": "Fully used",
      "settings.preview": "Preview",
      "settings.hidePreview": "Hide preview",
      "settings.zeroFilter": "No generations of this type.",
      "settings.refs": "References",
      "settings.scope": "Weekly allowance",
      "settings.pendingChanges": "Unsaved changes",
      "settings.emptyAccount": "Add a Muse account, then open its browser to sign in.",
      "settings.mediaMissing": "Media unavailable",
      "settings.updated": "Usage updated",
      "settings.historyCount": "{count} recent tasks",
      "pill.label": "Muse",
      "pill.used": "{pct}% weekly used",
      "pill.unknown": "Awaiting quota",
      "pill.busy": "In progress",
      "pill.failed": "Quota unavailable",
      "pill.previous": "Last reading: {pct}% used",
      "pill.plan": "Plan",
      "pill.reset": "Resets",
      "pill.updated": "Updated",
      "pill.accountViewing": "Viewing account",
      "pill.accountRunning": "Account in use",
      "pill.extra": "Extra allowance",
      "pill.usedShort": "{pct}% used",
      "pill.activity": "Activity",
      "pill.error": "Read error",

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
      "settings.showAll": "Show all",
      "settings.stateUnknown": "unknown",
      "settings.stateFailed": "did not finish",
      "settings.stateUnsaved": "Generated, local save failed. Retrieve it from this account’s Muse chat.",
      "settings.save": "Save",
      "settings.saved": "Saved",
      "settings.discard": "Discard",
      "settings.fieldHeadless": "Run generations headless",
      "settings.fieldHeadlessHint": "Turning this off opens a browser window for every generation.",
      "settings.openBrowser": "Open browser",
      "settings.opening": "Opening…",
      "settings.openMediaDir": "Open the media folder",
      "settings.fieldIndependent": "Ask for an independent generation each time",
      "settings.fieldIndependentHint":
        "When on, every generation is prefixed with ‘use this description and these references; do not carry over characters, scenes, composition or style from earlier conversations or work'. Muse's long-term memory stays on — this only stops it continuing from last time.",
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
      "settings.test": "Test connection",
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

    const MEDIA_BASE = "/plugins/dsh-muse-media/media/";

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
.muse-pill,.muse-tip{--muse-meter:var(--dsw-alias-state-business-primary);--muse-track:var(--dsw-alias-border-l2);}
.muse-pill[data-state="high"],.muse-tip[data-state="high"],
.muse-pill[data-state="full"],.muse-tip[data-state="full"]{--muse-meter:var(--dsw-alias-state-warn-primary);}
.muse-pill[data-state="stale"],.muse-tip[data-state="stale"]{--muse-meter:var(--dsw-alias-label-secondary);}
.muse-pill{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;padding:3px 5px;
  border-radius:5px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.25;white-space:nowrap;}
.muse-pill:hover,.muse-pill:focus-visible{background:var(--dsw-alias-interactive-bg-hover);}
.muse-pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
.muse-pill-label{font-weight:600;color:var(--dsw-alias-label-primary);}
.muse-pill-value,.muse-tip-value{font-variant-numeric:tabular-nums;}
.muse-pill-acct{max-width:12ch;overflow:hidden;text-overflow:ellipsis;}
.muse-meter{display:block;height:4px;border-radius:4px;background:var(--muse-track);overflow:hidden;}
.muse-pill .muse-meter{width:24px;flex:none;}
.muse-meter-fill{display:block;height:100%;border-radius:inherit;background:var(--muse-meter);}
.muse-tip{position:fixed;z-index:2147483000;box-sizing:border-box;overflow:auto;padding:12px 14px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 4px 16px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.45;}
.muse-tip-head,.muse-tip-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}
.muse-tip-head strong{font-size:13px;font-weight:600;}
.muse-tip-head span,.muse-tip-key,.muse-tip-foot{color:var(--dsw-alias-label-secondary);}
.muse-tip .muse-meter{margin-top:7px;}
.muse-tip-rows{display:grid;gap:5px;margin-top:10px;}
.muse-tip-key{flex:none;}
.muse-tip-value{text-align:end;min-width:0;overflow-wrap:anywhere;}
.muse-tip-foot{margin-top:9px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l2);}

.muse-card {
  --muse-line:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3));
  --muse-panel:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));
  --muse-ink:var(--dsw-alias-label-primary);
  --muse-sub:var(--dsw-alias-label-secondary);
  --muse-accent:var(--dsw-alias-brand-primary);
  container-type:inline-size;display:flex;flex-direction:column;gap:18px;min-width:0;
  color:var(--muse-ink);font:inherit;font-size:14px;line-height:1.5;padding:6px 0 20px;
}
.muse-card *, .muse-card *::before, .muse-card *::after{box-sizing:border-box;}
.muse-card :is(h3,h4,h5,p,dl,dd){margin:0;}
.muse-card h3{display:flex;align-items:center;gap:9px;font-size:21px;line-height:30px;font-weight:600;letter-spacing:-.02em;}
.muse-card h4{font-size:15px;font-weight:600;line-height:24px;color:var(--muse-ink);}
.muse-head{display:grid;gap:16px;}
.muse-tabs{display:flex;gap:20px;border-bottom:1px solid var(--muse-line);}
.muse-tab,.muse-text-btn,.muse-filter button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;}
.muse-tab{position:relative;padding:0 3px 10px;color:var(--muse-sub);font-weight:500;}
.muse-tab[data-active="true"]{color:var(--muse-ink);}
.muse-tab[data-active="true"]::after{content:"";position:absolute;height:2px;inset:auto 0 -1px;background:var(--muse-accent);border-radius:2px;}
.muse-section,.muse-pane{display:grid;gap:13px;min-width:0;}
.muse-list-head,.muse-account-top,.muse-record-head,.muse-allowance-line,.muse-foot-row,.muse-savebar{display:flex;align-items:center;gap:10px;min-width:0;}
.muse-list-head,.muse-record-head,.muse-foot-row{justify-content:space-between;}
.muse-btn,.muse-input,.muse-filter button{font:inherit;font-size:13px;}
.muse-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;min-height:32px;
  padding:4px 12px;border:1px solid var(--muse-line);border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--muse-ink);}
.muse-card button:not(:disabled):hover,.muse-fold summary:hover{background:var(--dsw-alias-interactive-bg-hover);}
.muse-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;}
.muse-card .muse-btn--primary:hover{background:var(--dsw-alias-button-primary-hover);}
.muse-btn--danger,.muse-danger,.muse-history-error{color:var(--dsw-alias-state-error-primary);}
.muse-btn--quiet{background:transparent;}
.muse-card :is(button,summary,input):focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--muse-accent));outline-offset:2px;}
.muse-card button:disabled{opacity:.48;cursor:default;}
.muse-card-actions,.muse-confirm,.muse-foot-actions,.muse-diag-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.muse-input{min-width:0;border:1px solid var(--muse-line);border-radius:7px;padding:6px 9px;background:var(--dsw-alias-bg-base,transparent);color:var(--muse-ink);}
.muse-meta,.muse-field-hint,.muse-account-meta,.muse-diag dt{font-size:12px;color:var(--muse-sub);line-height:1.55;overflow-wrap:anywhere;}
.muse-list,.muse-records,.muse-fields,.muse-fold,.muse-foot,.muse-empty{border:1px solid var(--muse-line);border-radius:12px;background:var(--muse-panel);}
.muse-account,.muse-record{padding:16px 18px;display:grid;gap:9px;min-width:0;}
.muse-account + .muse-account,.muse-record + .muse-record{border-top:1px solid var(--muse-line);}
.muse-identity,.muse-account-meta,.muse-foot-figs{display:flex;gap:6px 12px;align-items:center;flex-wrap:wrap;min-width:0;}
.muse-identity{flex:1;}
.muse-name,.muse-record-copy strong{font-size:14px;font-weight:600;overflow-wrap:anywhere;}
.muse-chip,.muse-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:18px;}
.muse-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muse-ink);}
.muse-state::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-idle-primary);}
.muse-state[data-tone="ok"]::before{background:var(--dsw-alias-state-success-primary);}
.muse-state[data-tone="bad"]::before{background:var(--dsw-alias-state-error-primary);}
.muse-state[data-tone="warn"]::before{background:var(--dsw-alias-state-warn-primary);}
.muse-tag--warn,.muse-warning{color:var(--dsw-alias-state-warn-primary);}
.muse-tag--bad{color:var(--dsw-alias-state-error-primary);}
.muse-allowance{display:grid;gap:5px;}
.muse-allowance-line{font-size:12px;gap:6px;}
.muse-allowance-line strong{font-weight:550;font-variant-numeric:tabular-nums;}
.muse-text-btn{padding:2px 5px;border-radius:4px;font-size:12px;}
.muse-allowance-line button{margin-left:auto;color:var(--muse-accent);}
.muse-allowance progress{appearance:none;width:100%;height:4px;border:0;border-radius:4px;overflow:hidden;}
.muse-allowance progress::-webkit-progress-bar{background:var(--dsw-alias-border-l2);}
.muse-allowance progress::-webkit-progress-value{background:var(--muse-accent);border-radius:4px;}
.muse-allowance[data-tone="high"] progress::-webkit-progress-value{background:var(--dsw-alias-state-warn-primary);}
.muse-allowance[data-tone="full"] progress::-webkit-progress-value{background:var(--dsw-alias-state-error-primary);}
.muse-account-meta:empty{display:none;}
.muse-account-details{display:grid;gap:10px;padding-top:12px;border-top:1px solid var(--muse-line);}
.muse-confirm p{flex-basis:100%;}
.muse-empty{padding:24px 18px;color:var(--muse-sub);}
.muse-card .muse-warning{color:var(--muse-ink);border-inline-start:2px solid var(--dsw-alias-state-warn-primary);padding-inline-start:8px;}
.muse-warning,.muse-notice{font-size:13px;overflow-wrap:anywhere;}
.muse-notice{padding:9px 12px;border-left:3px solid var(--muse-accent);background:var(--muse-panel);}
.muse-notice[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary);}
.muse-notice[data-kind="warn"]{border-color:var(--dsw-alias-state-warn-primary);}
.muse-filter{display:flex;width:fit-content;gap:2px;padding:3px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);}
.muse-filter button{padding:3px 12px;border-radius:6px;color:var(--muse-sub);}
.muse-filter button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--muse-ink);box-shadow:0 0 0 1px var(--muse-line);}
.muse-record-summary{display:flex;align-items:center;gap:10px;flex:1;min-width:0;}
.muse-record-toggle{appearance:none;border:0;border-radius:6px;padding:0;background:transparent;
  color:inherit;font:inherit;text-align:start;cursor:pointer;}
.muse-record-toggle::after{content:"";width:7px;height:7px;flex:none;margin:0 6px;
  border:solid var(--muse-sub);border-width:0 1.5px 1.5px 0;transform:rotate(45deg);}
.muse-record-toggle[aria-expanded="true"]::after{transform:rotate(225deg);}
.muse-thumb{display:grid;place-items:center;flex:none;width:42px;height:42px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;overflow:hidden;color:var(--muse-sub);}
.muse-thumb img{width:100%;height:100%;object-fit:cover;}
.muse-record-head{align-items:center;}
.muse-record-copy{flex:1;display:grid;gap:4px;min-width:0;}
.muse-record-head .muse-state{flex:none;}
.muse-preview{padding-inline-start:52px;display:grid;gap:8px;justify-items:start;}
.muse-preview-media{max-width:100%;max-height:min(320px,50vh);border-radius:8px;}
.muse-pane>.muse-btn{justify-self:start;}
.muse-fields{margin:0;padding:0 16px;min-width:0;}
.muse-field{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 0;}
.muse-field+.muse-field{border-top:1px solid var(--muse-line);}
.muse-field-copy{min-width:0;display:grid;gap:2px;}
.muse-field-label{font-size:14px;font-weight:500;color:var(--muse-ink);}
.muse-input--num{width:78px;text-align:end;flex:none;font-variant-numeric:tabular-nums;}
.muse-switch{appearance:none;position:relative;flex:none;width:34px;height:20px;margin:0;border:1px solid var(--dsw-alias-border-l3);
  border-radius:12px;background:var(--dsw-alias-border-l2);cursor:pointer;}
.muse-switch::before{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb);box-shadow:0 1px 2px var(--muse-line);}
.muse-switch:checked{background:var(--dsw-alias-button-primary-fill);border-color:transparent;}
.muse-switch:checked::before{left:16px;background:var(--dsw-alias-label-primary-foreground);}
.muse-fold>summary{padding:13px 16px;cursor:pointer;font-weight:500;border-radius:inherit;}
.muse-fold>summary::marker{color:var(--muse-sub);}
.muse-fold .muse-fields{border:0;background:transparent;}
.muse-savebar{flex-wrap:wrap;justify-content:flex-end;}
.muse-savebar span{margin-right:auto;font-size:13px;}
.muse-diag dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;padding:0 16px 12px;}
.muse-diag dd{font-size:13px;overflow-wrap:anywhere;}
.muse-diag-actions{margin:0 16px 14px;}
.muse-foot{display:grid;padding:14px 16px;gap:8px;}
.muse-foot-row,.muse-account-top{flex-wrap:wrap;}
.muse-foot-fig{display:flex;align-items:baseline;gap:5px;font-size:12px;}
.muse-foot-fig strong{font-size:14px;}
@container(max-width:440px){.muse-account,.muse-record{padding:13px;}
 .muse-account-top{gap:6px;}.muse-identity{flex-basis:100%;}.muse-field{gap:10px;}
 .muse-record-head{align-items:flex-start;flex-wrap:wrap;}.muse-tabs{gap:15px;}}
@media(forced-colors:active){.muse-switch{appearance:auto;}.muse-switch::before{display:none;}}
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
    function UsageMeter({ pct }) {
      if (!Number.isFinite(pct)) return null;
      return h("span", { className: "muse-meter", "aria-hidden": true },
        h("span", { className: "muse-meter-fill", style: { width: Math.max(0, Math.min(100, pct)) + "%" } }),
      );
    }

    function Tooltip({ id, anchor, title, status, pct, state, rows, updated, onMouseEnter, onMouseLeave }) {
      if (!anchor) return null;
      const gap = 6;
      const width = Math.min(280, window.innerWidth - 16);
      const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
      const above = anchor.top >= window.innerHeight - anchor.bottom;
      const position = above ? { bottom: window.innerHeight - anchor.top + gap } : { top: anchor.bottom + gap };
      const available = above ? anchor.top : window.innerHeight - anchor.bottom;
      return require("react-dom").createPortal(
        h("div", { id, role: "tooltip", className: "muse-tip", "data-state": state, onMouseEnter, onMouseLeave,
          style: { ...position, left, width, maxHeight: Math.max(0, available - gap - 8) } },
          h("div", { className: "muse-tip-head" }, h("strong", null, title), h("span", null, status)),
          h(UsageMeter, { pct }),
          rows.length > 0 && h("div", { className: "muse-tip-rows" }, rows.map(([key, value]) =>
            h("div", { className: "muse-tip-row", key },
              h("span", { className: "muse-tip-key" }, key),
              h("span", { className: "muse-tip-value" }, value)))),
          updated && h("div", { className: "muse-tip-foot" }, updated),
        ), document.body,
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
      const tipId = React.useId();
      const trigger = React.useRef(null);
      const closeTimer = React.useRef();
      const cancelClose = () => clearTimeout(closeTimer.current);
      const scheduleClose = () => {
        cancelClose();
        if (document.activeElement !== trigger.current) {
          closeTimer.current = setTimeout(() => setTip(undefined), 140);
        }
      };
      useEffect(() => () => clearTimeout(closeTimer.current), []);
      useEffect(() => {
        if (!tip) return;
        const dismiss = (event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          setTip(undefined);
        };
        document.addEventListener("keydown", dismiss, true);
        return () => document.removeEventListener("keydown", dismiss, true);
      }, [tip]);

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

      const pct = Number.isFinite(live?.usedPct) ? live.usedPct : undefined;
      const error = live?.error || quota.reason;
      let state = "ok";
      if (pct === undefined) state = error || live?.ok === false ? "error" : "waiting";
      else if (live.stale || error) state = "stale";
      else if (pct >= 100) state = "full";
      else if (pct >= 80) state = "high";

      const text = pct !== undefined
        ? t(state === "stale" ? "pill.previous" : "pill.used", { pct })
        : t(state === "error" ? "pill.failed" : "pill.unknown");
      let status = pct === undefined ? text : t("pill.usedShort", { pct });
      if (state === "high" || state === "full") {
        status += " · " + t(state === "full" ? "settings.quotaFull" : "settings.quotaHigh");
      } else if (state === "stale") {
        status = t("pill.previous", { pct });
      }
      const rows = [];
      if (activeAccount) rows.push([t(quota.duringTask ? "pill.accountRunning" : "pill.accountViewing"), activeAccount.label]);
      if (live?.plan) rows.push([t("pill.plan"), live.plan]);
      if (live?.reset) rows.push([t("pill.reset"), live.reset]);
      const extra = [];
      if (Number.isFinite(live?.extraUsedPct)) extra.push(t("pill.usedShort", { pct: live.extraUsedPct }));
      if (live?.extraLeft != null && live.extraLeft !== "") extra.push(live.extraLeft);
      if (extra.length) rows.push([t("pill.extra"), extra.join(" · ")]);
      if (quota.busy) rows.push([t("pill.activity"), quota.busy]);
      if (error) rows.push([t("pill.error"), error]);
      const openTip = (event) => {
        cancelClose();
        setTip(event.currentTarget.getBoundingClientRect());
      };

      return h("span", {
        className: "muse-pill", "data-state": state, tabIndex: 0, ref: trigger,
        "aria-describedby": tip ? tipId : undefined,
        onMouseEnter: openTip, onFocus: openTip, onClick: openTip,
        onMouseLeave: scheduleClose, onBlur: () => setTip(undefined),
      },
        h("span", { className: "muse-pill-label" }, t("pill.label")),
        h(UsageMeter, { pct }),
        h("span", { className: "muse-pill-value" }, text),
        quota.busy && h("span", null, t("pill.busy")),
        quota.showLabel && activeAccount && h("span", { className: "muse-pill-acct" }, "· " + activeAccount.label),
        h(Tooltip, { id: tipId, anchor: tip, title: t("pill.label") + " " + t("settings.scope"),
          status, pct, state, rows, onMouseEnter: cancelClose, onMouseLeave: scheduleClose,
          updated: live?.at && t("pill.updated") + " · " + relativeTime(live.at, locale) }),
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

      const quota = account.quotaLive?.ok ? account.quotaLive : account.quota;
      const hasQuota = Number.isFinite(quota?.usedPct);
      const tone = !hasQuota ? "none" : quota.usedPct >= 100 ? "full" : quota.usedPct >= 80 ? "high" : "ok";
      const [expanded, setExpanded] = useState(false);
      const stateLabel = account.status === "ready" && !account.usable
        ? account.usableReason || t("settings.availability") : statusText;
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

      return h("article", { className: "muse-account" },
        h("div", { className: "muse-account-top" },
          h("div", { className: "muse-identity" },
            h("strong", { className: "muse-name" }, account.label || account.id),
            account.selected && h("span", { className: "muse-chip", title: t("settings.selectedHint") }, t("settings.selected")),
            h("span", { className: "muse-state", "data-tone": statusTone }, stateLabel)),
          primaryAction,
          h("button", { type: "button", className: "muse-btn muse-manage", "aria-expanded": expanded,
            onClick: () => { setExpanded(!expanded); setConfirming(false); } },
            t(expanded ? "settings.closeDetails" : "settings.manage"))),
        h("div", { className: "muse-allowance", "data-tone": tone },
          h("div", { className: "muse-allowance-line" },
            h("span", null, t("settings.scope")),
            h("strong", null, hasQuota ? t("pill.usedShort", { pct: quota.usedPct }) : t("settings.quotaNeverShort")),
            tone === "high" && h("span", { className: "muse-meta" }, t("settings.quotaHigh")),
            tone === "full" && h("span", { className: "muse-meta" }, t("settings.quotaFull")),
            quota?.stale && h("span", { className: "muse-meta" }, t("settings.quotaStale")),
            h("button", { type: "button", className: "muse-text-btn", disabled: disabled || busy,
              onClick: () => onAction("refresh-quota", account.id) }, t("settings.refreshShort"))),
          hasQuota && h("progress", { max: 100, value: quota.usedPct, "aria-label": t("settings.scope") })),
        h("div", { className: "muse-account-meta" },
          quota?.plan && h("span", null, quota.plan),
          quota?.reset && h("span", null, t("settings.quotaReset") + " " + quota.reset),
          account.running && h("span", null, t("settings.running")),
          probe?.checkedAt && probeNode),
        quota?.error && h("p", { className: "muse-warning" }, quota.error),
        expanded && h("div", { className: "muse-account-details" },
          h("div", { className: "muse-account-meta" },
            h("span", null, t("settings.lastUsed") + " " + (account.lastUsedAt ? relativeTime(account.lastUsedAt, locale) : t("settings.never"))),
            quota?.at && h("span", null, t("settings.updated") + " " + relativeTime(quota.at, locale)),
            !probe?.checkedAt && probeNode),
          probe?.note && h("p", { className: "muse-meta" }, probe.note),
          h("div", { className: "muse-card-actions" },
            button("open-browser", t("settings.openBrowser")), !needsSignIn && button("verify", t("settings.verify")),
            button("probe", t("settings.test")), !account.selected && button("select", t("settings.select")),
            account.running && button("quit-browser", t("settings.quit")),
            !confirming && h("button", { type: "button", className: "muse-text-btn muse-danger", disabled: disabled || busy,
              onClick: () => setConfirming(true) }, t("settings.remove"))),
          confirming && h("div", { className: "muse-confirm" },
            h("p", null, t("settings.removeConfirm", { label: account.label })),
            button("remove", t("settings.remove"), { danger: true }),
            h("button", { type: "button", className: "muse-btn", onClick: () => setConfirming(false) }, t("settings.cancel")))),
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
    function RecordThumbnail({ task }) {
      const [unavailable, setUnavailable] = useState(false);
      const video = task.kind === "video";
      return h("span", { className: "muse-thumb", "aria-hidden": "true" },
        !video && task.media && !unavailable
          ? h("img", { src: MEDIA_BASE + encodeURIComponent(task.media), loading: "lazy", alt: "", onError: () => setUnavailable(true) })
          : h("svg", { width: 19, height: 19, viewBox: "0 0 24 24", stroke: "currentColor",
              fill: "none", strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round" },
              video ? h("path", { d: "M3 6h12v12H3z M15 10l6-3v10l-6-3" }) :
                h("path", { d: "M3 4h18v16H3z M4 17l5-5 4 4 3-3 4 4 M15 8h.01" })));
    }

    function HistoryRecord({ task, t, locale }) {
      const [open, setOpen] = useState(false);
      const [failed, setFailed] = useState(false);
      const kind = t("settings." + (task.kind === "video" ? "video" : "image"));
      const title = task.prompt || task.media || kind;
      const cost = Number.isFinite(task.quotaBefore) && Number.isFinite(task.quotaAfter) && task.quotaAfter >= task.quotaBefore
        ? "+" + (task.quotaAfter - task.quotaBefore) + "%" : undefined;
      const meta = [kind, task.account, relativeTime(task.at, locale),
        task.durationMs && Math.round(task.durationMs / 1000) + "s", cost].filter(Boolean);
      const states = { delivered: "delivered", failed: "stateFailed", unknown: "stateUnknown", "generated-unsaved": "unsaved" };
      const summary = [
        h(RecordThumbnail, { key: "thumb", task }),
        h("span", { key: "copy", className: "muse-record-copy" }, h("strong", null, title),
          h("span", { className: "muse-meta" }, meta.join(" · "))),
      ];
      const previewAction = t(open ? "settings.hidePreview" : "settings.preview");
      return h("article", { className: "muse-record" },
        h("div", { className: "muse-record-head" },
          task.media
            ? h("button", { type: "button", className: "muse-record-summary muse-record-toggle",
                "aria-expanded": open, "aria-label": previewAction + " · " + title, title: previewAction,
                onClick: () => { setFailed(false); setOpen(!open); } }, ...summary)
            : h("div", { className: "muse-record-summary" }, ...summary),
          h("span", { className: "muse-state", "data-tone": task.state === "delivered" ? "ok" : task.state === "failed" ? "bad" : "warn" },
            t("settings." + (states[task.state] || "stateUnknown")))),
        task.state !== "delivered" && task.note && h("p", { className: "muse-warning" }, task.note),
        task.references?.length > 0 && h("div", { className: "muse-meta" }, t("settings.refs") + " · " + task.references.join("、")),
        task.media && open && h("div", { className: "muse-preview" },
          failed ? h("span", { role: "status", className: "muse-meta" }, t("settings.mediaMissing")) :
            h(task.kind === "video" ? "video" : "img", {
              className: "muse-preview-media", src: MEDIA_BASE + encodeURIComponent(task.media),
              controls: task.kind === "video", alt: task.kind === "image" ? title : undefined,
              onError: () => setFailed(true),
            })));
    }

    function HistorySection({ history, t, locale }) {
      const [filter, setFilter] = useState("all");
      const [limit, setLimit] = useState(8);
      const filtered = history.filter((task) => filter === "all" || task.kind === filter);
      return h("section", { className: "muse-pane" },
        h("header", { className: "muse-list-head" },
          h("h4", null, t("settings.history")),
          h("span", { className: "muse-meta" }, t("settings.historyCount", { count: history.length }))),
        h("div", { className: "muse-filter", role: "group", "aria-label": t("settings.history") },
          ["all", "image", "video"].map((key) => h("button", { type: "button", key, "aria-pressed": filter === key,
            onClick: () => { setFilter(key); setLimit(8); } }, t("settings." + key)))),
        filtered.length === 0 && h("p", { className: "muse-empty" }, t(history.length ? "settings.zeroFilter" : "settings.historyEmpty")),
        filtered.length > 0 && h("div", { className: "muse-records" }, filtered.slice(0, limit).map((task) =>
          h(HistoryRecord, { key: task.id, task, t, locale }))),
        filtered.length > 8 && h("button", { type: "button", className: "muse-btn", onClick: () => setLimit(limit === 8 ? filtered.length : 8) },
          t(limit === 8 ? "settings.showAll" : "settings.less")));
    }

    /**
     * The settings that shape how the browser and the timeouts behave.
     *
     * Held as local draft state and written on one button, because these are values
     * whose effect the user cannot see immediately — a slider that saves on every
     * keystroke would restart the browser mid-typing.
     */
    function SettingsSection({ settings, diagnostics, paths, browser, t, pending, onSave }) {
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
            required: true,
            onChange: (event) =>
              setDraft({ ...draft, [key]: event.target.value === "" ? "" : Number(event.target.value) }),
          }),
        );

      const [saving, setSaving] = useState(false);
      return h("form", {
        className: "muse-pane",
        onSubmit: async (event) => {
          event.preventDefault();
          if (!dirty || pending || saving) return;
          setSaving(true);
          try {
            if (await onSave(draft)) setDraft({});
          } finally { setSaving(false); }
        },
      },
        h("h4", null, t("settings.generationSettings")),
        h("fieldset", { className: "muse-fields", disabled: saving, "aria-label": t("settings.generationSettings") },
          toggle("independentGeneration", t("settings.fieldIndependent"), t("settings.fieldIndependentHint")),
          toggle("showQuotaInComposer", t("settings.fieldPill"), t("settings.fieldPillHint"))),
        h("details", { className: "muse-fold" },
          h("summary", null, t("settings.execution")),
          h("fieldset", { className: "muse-fields", disabled: saving, "aria-label": t("settings.execution") },
            toggle("headlessAfterLogin", t("settings.fieldHeadless"), t("settings.fieldHeadlessHint")),
            numberField("idleReapSeconds", t("settings.fieldIdle"), t("settings.fieldIdleHint"), 0, 86400),
            numberField("maxLiveBrowsers", t("settings.fieldConcurrent"), t("settings.fieldConcurrentHint"), 0, 8),
            numberField("maxAccountsPerTask", t("settings.retryAccounts"), t("settings.retryHint"), 1, 5),
            numberField("autoRefreshQuotaSeconds", t("settings.fieldRefresh"), t("settings.fieldRefreshHint"), 0, 86400),
            numberField("imageTimeoutSeconds", t("settings.fieldImageTimeout"), undefined, 30, 1800),
            numberField("videoTimeoutSeconds", t("settings.fieldVideoTimeout"), undefined, 60, 3600))),
        dirty && h("div", { className: "muse-savebar" },
          h("span", { role: "status" }, t("settings.pendingChanges")),
          h("button", { type: "button", className: "muse-btn", disabled: saving, onClick: () => setDraft({}) }, t("settings.discard")),
          h("button", { type: "submit", className: "muse-btn muse-btn--primary", disabled: saving || pending !== undefined }, t("settings.save"))),
        diagnostics === undefined
          ? null
          : h(
              "details",
              { className: "muse-fold muse-diag" },
              h("summary", null, t("settings.diagnostics")),
              h(
                "dl",
                null,
                [
                  [t("settings.diagState"), diagnostics.stateRoot],
                  [t("settings.browser"), browser?.path],
                  [t("settings.profiles"), paths?.profiles],
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

    /**
     * Disk usage and the one destructive action on this page.
     *
     * Split out because it belongs with the accounts — they are what fill the disk — and
     * because the clear action needs its own confirmation state, which should not sit in
     * the card's state next to the account form.
     */
    function DiskFooter({ snapshot, t, pending, confirmingMedia, setConfirmingMedia, onClear, onRevealMediaDir }) {
      if (snapshot === undefined) return null;
      const profileTotal = Object.values(snapshot.profileBytes ?? {}).reduce(
        (sum, value) => sum + (value ?? 0),
        0,
      );
      const hasMedia = (snapshot.mediaBytes ?? 0) > 0;

      return h(
        "div",
        { className: "muse-foot" },
        h("div", { className: "muse-list-head" }, h("h4", null, t("settings.disk")),
          h("button", { type: "button", className: "muse-btn", disabled: pending !== undefined, onClick: onRevealMediaDir }, t("settings.openMediaDir"))),
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
                      text: t("settings.saved"),
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
            return result?.ok === true;
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
          h("h3", null, h(MuseNavIcon, { size: 24 }), t("settings.nav")),
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
              { className: "muse-tabs", role: "group", "aria-label": t("settings.nav") },
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

                    className: "muse-tab",
                    "aria-pressed": pane === entry.id,
                    "data-active": pane === entry.id,
                    onClick: () => setPane(entry.id),
                  },
                  entry.label,
                ),
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
                  h("div", null, h("h4", null, t("settings.title")), accounts.length > 0 && h("span", { className: "muse-meta" }, t("settings.accountCount", { count: accounts.length }))),
                  h(
                    "button",
                    {
                      type: "button",
                      className: adding ? "muse-btn muse-btn--quiet" : "muse-btn muse-btn--primary",
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
                    h("p", { className: "muse-empty" }, t("settings.emptyAccount"))
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
        pane === "history" && snapshot ? h(HistorySection, { history: snapshot.history ?? [], t, locale }) : null,
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
                  diagnostics: snapshot.diagnostics, paths: snapshot.paths, browser: snapshot.browser,
                  t,
                  pending,
                  onSave: (patch) => runAction("save-settings", undefined, { settings: patch }),
                }),
                /** Disk, clearing and paths: maintenance, so they live with maintenance. */
                h(DiskFooter, {
                  snapshot,
                  t,
                  pending,
                  confirmingMedia,
                  setConfirmingMedia,
                  onClear: () => void runAction("clear-media"),
                  onRevealMediaDir: () => void runAction("reveal-media"),
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
