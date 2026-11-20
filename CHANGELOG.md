# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.4] — 2026-11-20

把决策层也纳入测试，并修正一个被调用方掩盖的缺陷。

### Added

- `test/pool.test.mjs`：29 项，覆盖选号、冷却、重置日期解析、故障分类、换号预算。
- 测试总数从 20 增至 49。

### Fixed

- **`maySwitchAccount` 对限流和额度耗尽也返回 `true`。**

  这个函数判断的是"能否换另一个账号接着做"。它此前共用 `ACCOUNT_ATTRIBUTABLE`（登录失效、额度耗尽、限流三者都在其中），于是三种情况都允许换号。

  `#runAccountLoop` 在调用它之前用 `failure.kind === FAILURE.SIGNED_OUT` 挡住了另外两种，所以运行时行为一直是对的。但**一个答案只因为调用方忽略才正确的函数，一次重构就可能花掉别人账号的额度**。

  现在拆成两个概念：

  - `accountAttributable`（三种）—— 该账号在本任务中不再尝试。
  - `switchPermitted`（仅登录失效）—— 可以动用另一个账号的额度。

### Notes

测试写对了三处我自己的错误假设，值得记下来：

- `isReadingStale(quota, now)` 收的是 `Date`，不是时间戳。
- `resetOrdinal` 返回的是时间戳，不是 `1122` 这种序号。
- 一条读数的重置日若早于它自己的读取时刻，只会被解释成明年——那种情况不算过期。真正的过期是"读取很久以前、其间重置已经发生"。

## [1.0.3] — 2026-11-20

把此前一次性的验证脚本变成常驻测试，并接进 CI。

### Added

- 	est/manifest.test.mjs：18 项测试，覆盖真正出过的问题和差点出过的问题。
- pm test 脚本；pm run check 把语法检查与测试串起来。
- CI 的 verify job 在每个标签上跑一遍测试。

### Why these tests

每一条都对应一个实际发生过的缺陷：

- 版本号与 CHANGELOG 不一致（本次测试立刻抓到 1.0.2 缺条目）。
- 详情文档不是单图形式，Host 会拒绝渲染。
- 主题变量在 Host 里不存在，曾让所有主按钮变灰。
- 文件编码不是合法 UTF-8，曾让设计文档的中文全部乱码。
- 发布 job 没有凭据就会执行，曾差点让标签推送留下失败记录。

### Changed

- 版本号升至 1.0.3。
## [1.0.2] — 2026-11-20

这一版改的是仓库和 npm 页面的第一印象，以及让打 tag 不再产生失败的 CI。

### Changed

- `package.json` 的 `homepage` 改为指向 npm 包页面。GitHub 侧栏读的是仓库自己的 `homepage` 字段（独立于 `package.json`），两处都已修正。
- README 重写：首屏加预览图、徽章和一行安装命令；新增「账号是怎么选的」「更新」「配置」三节。
- `docs/DETAIL.md` 从 15 KB 设计文档改为规范要求的单图形式；功能与限制移入 `meta.description`（中英各一份）。
- 新增 `docs/preview.svg`（640×300，自包含、无文字、明暗主题通用）。
- 原设计文档移入 `docs/DESIGN.md`，仍随包发布。

### Added

- `CHANGELOG.md`、`CONTRIBUTING.md`。
- `.github/ISSUE_TEMPLATE/bug_report.yml`：结构化 issue 表单，强制填写 Harness 版本、插件版本、Chrome 版本、出现频率和诊断信息。
- `.github/ISSUE_TEMPLATE/config.yml`：指向 npm 页面与 Muse 官方。

### Fixed

- `docs/DESIGN.md` 曾因 PowerShell 重定向写出非 UTF-8 字节，中文全部乱码；已重新导出并加入自动编码校验。
- `.github/workflows/publish.yml` 的发布步骤改为受 `NPM_PUBLISH_ENABLED` 变量控制。此前任何 `v*` 标签都会执行 `npm publish`，而 Trusted Publishing 尚未配置，会留下一个失败的运行记录。

### CI

- 新增 `verify` job，每个标签都跑：标签与 `package.json` 版本一致、两个入口可解析、两个语言文件是合法 JSON 且含 `meta` 字段。
- `publish` job 依赖 `verify`，变量未设置时跳过（`skipped` 不算失败）。
- 开启真正发布：先在 npm 配置 Trusted Publisher，再把仓库变量 `NPM_PUBLISH_ENABLED` 设为 `true`。字段清单写在 workflow 文件顶部。

## [1.0.1] — 2026-11-20

### Changed

- 详情文档改为单图形式；功能、用法与限制移入 `meta.description`。
- 新增 `docs/preview.svg`（640×300，自包含、无文字）。
- 原设计与实现说明移入 `docs/DESIGN.md`。
- README 补「账号怎么选」「更新」「配置」三节。

### Fixed

- 详情文档格式不符合 DSH 插件规范。

## [1.0.0] — 2026-11-20

首个公开版本。

### Added

- 三个工具：`muse_draw_image`、`muse_draw_video`、`muse_quota`。
- 多账号支持，每个账号独立浏览器数据目录。
- 选号按周额度最早重置优先——周额度到期作废，额外额度不过期。
- 设置页三栏：账号 / 记录 / 高级。
- 输入框旁的额度胶囊，空闲与生成中区分账号身份。
- 生成历史，含每次任务的额度消耗与耗时。
- 高级页可在界面内改配置，保存后立即生效。
- 磁盘占用与媒体清理（仅手动触发，不自动删除已交付媒体）。

### Notes

- 发送边界先写日志再点击；回执丢失记 `unknown` 而不是失败，避免用户重复提交。
- 上游限流或额度耗尽时任务停止，不自动换号绕过；只有登录失效才允许换号。
- 无运行时依赖；Chrome 是唯一外部前提。
