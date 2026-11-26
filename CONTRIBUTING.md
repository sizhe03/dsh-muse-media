# 参与贡献

这个插件通过 CDP 驱动真实的 Chrome 操作 muse.ai，所以最需要帮助的地方是**报告哪些情况下它会出错**——尤其是那些看起来像插件坏了、实际是上游改版造成的问题。

## 通过什么方式

- 遇到故障时，请写明操作步骤、实际结果、插件和 DSH 版本。[报告故障](https://github.com/sizhe03/dsh-muse-media/issues/new/choose)
- 使用疑问或功能建议可以在讨论区交流。[参与讨论](https://github.com/sizhe03/dsh-muse-media/discussions)
- **安全漏洞** —— **不要开公开 issue**，走 [`SECURITY.md`](SECURITY.md) 里的私密报告通道。
- **想改代码** —— 直接开 PR，或者先开 issue 说说你的想法。

**这个项目没有客服邮箱。** 所有讨论都留在仓库里，这样别人遇到同样的问题能搜到答案。

## 报告问题前

请先确认这几点，能省掉大量来回：

1. **重启过 Harness 吗？** 插件的 UI 是客户端代码，装完或更新后需要重新加载才生效。
2. **Chrome 能正常打开 muse.ai 并登录吗？** 插件不改网络环境，用的是你自己的浏览器。
3. **设置 → Muse → 设置 → 诊断** 里的信息能贴出来吗？里面是状态目录、任务数、媒体数、浏览器来源，没有凭据。

**不要贴**：账号密码、`.npmrc` 里的 token、Muse 的 cookie 或会话 token。这些插件本身也不读取。

## 报告什么

有用的报告长这样：

```
现象：生视频时任务卡在「已发送」，等了 13 分钟后报超时
账号数：2 个，都是「可用」
额度：acc-01 25%，acc-2 2%
最近成功：2 小时前，同一提示词
Chrome 版本：157.0.0.0
Harness 版本：0.2.2-rc.5
诊断页信息：（贴过来）
```

关键在于**能复现的最小条件**。如果某个提示词必失败、换个说法就成功，把这个差异写出来——那通常指向上游的输入校验，而不是插件逻辑。

## 可以预期我这样处理

- **上游限流或额度耗尽**：任务停止并如实报错，不会自动换号。这是有意设计——换号等于替你从另一个账号花额度，没有你的同意不该做。
- **muse.ai 改版导致页面选择器失效**：这类问题优先级最高，因为整个插件都依赖那几个选择器。
- **新增功能请求**：会评估是否值得做，但不会为了「功能多」而加。这个插件故意不提供代理中转、签到领取、媒体库这些东西——它们是另一个产品的范围。

## 提交代码与发版

在仓库根目录运行 `npm run check` 检查语法并执行测试，用 `npm pack --dry-run` 核对打包内容。分支推送和 PR 会运行 CI。页面测试会在 Chrome 中运行本地测试页面，涉及真实 Muse 网页布局的改动还需要在真实账号验证。

维护者同意发版后，按下面的顺序执行。**顺序不能变**：市场索引记录的是 npm 上的实际发布时间，所以它只能在该版本可以从 npm 下载之后生成；而 npm 上的版本由标签工作流发布，标签又需要先提交好版本号。

1. **更新包版本和 CHANGELOG。** 只改这两个文件，先不碰索引。此时索引落后于 manifest 是正常的。改完先跑一次 `npm test` 确认整个测试集仍然通过。
2. **提交并推送。** 这一次提交只带版本号和更新记录。分支构建会检查「索引必须列出最新版本」，所以这次 CI 会是红的——这是设计允许的短暂状态，会在第 5 步关闭。
3. **打 `v*` 标签并推送。** 标签构建不检查索引（它无法检查：这个版本此刻还不在 npm 上），所以 `verify` 会通过，随后 `publish` 用 OIDC 把包装发到 npm。
4. **等 npm 可安装**，确认版本和来源证明正确。
5. **运行 `node scripts/sync-market-index.mjs`**，把同步后的索引与版本、CHANGELOG 一起提交并推送。这一次 CI 转绿，主分支回到干净状态。

`publish` 作业会先向 registry 查询该版本是否已存在：存在就跳过发布，不存在才发布。所以重复打标签不会造成二次发布。

需要测试 OIDC 本身时，手动触发工作流会运行 `oidc-rehearsal`：它用一个一次性的预发布版本号发布到 `oidc-test` 标签下，不触碰 `latest`，也不影响市场索引。这件事不需要消耗正式版本号。

普通文档更新直接提交即可。

## Development and releases

Run `npm run check` for syntax and tests, then `npm pack --dry-run` to inspect the package. CI runs on branch pushes and pull requests. The browser tests use local fixtures in Chrome. Verify changes that depend on Muse’s live markup against the actual site as well.

A release requires maintainer approval. The order matters and cannot be rearranged: the market index records npm's real publish time, so it can only be built once the version is downloadable, and the version reaches npm through the tag workflow, which needs the version committed first.

1. **Bump the version and update the CHANGELOG.** Do not touch the index yet; it is expected to lag the manifest.
2. **Commit and push.** This commit carries only the version and the changelog. The branch build requires the index to list the newest version, so this CI run is red — a deliberate, bounded window that step 5 closes.
3. **Push the `v*` tag.** A tag build skips the index check (it cannot satisfy it: the version is not on npm yet), so `verify` passes and `publish` ships the package through OIDC.
4. **Wait until npm can serve it**, then confirm the version and its provenance attestation.
5. **Run `node scripts/sync-market-index.mjs`** and commit the synced index together with the version and changelog. CI turns green and the branch is clean.

The `publish` job asks the registry whether the version already exists and publishes only when it does not, so a repeated tag cannot double-publish.

To test OIDC itself, dispatch the workflow by hand: `oidc-rehearsal` publishes a throwaway prerelease under the `oidc-test` tag, leaving `latest` and the market index untouched. It costs no release number.

## 许可

提交的代码按 MIT 授权，与项目一致。
