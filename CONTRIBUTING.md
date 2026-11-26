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

维护者同意发版后，按下面的顺序执行。**顺序不能变**：市场索引记录的是 npm 上的实际发布时间，只能在该版本可从 npm 下载之后生成；而 npm 上的版本由标签工作流发布。

1. **更新包版本和 CHANGELOG**，跑一次 `npm test` 确认整个测试集通过，然后提交。
2. **给这个提交打 `v*` 标签，只推标签**（`git push origin v1.3.4`，不要同时推 `main`）。工作流开始验证并用 OIDC 发布。**此时远端 `main` 仍停在上一版，所以分支 CI 保持绿色。**
3. **确认 npm 能安装这个确切版本**，并核对来源证明。
4. **运行 `node scripts/sync-market-index.mjs`**，提交更新后的索引，然后把这两个提交一起推到 `main`。

第 4 步容易被忽略，因为前三步都不需要它。**漏掉它，安装不受影响，但插件市场和 Discover 会一直展示旧版本**——索引不会自己变。

`publish` 作业只在**推送版本标签**时执行；手动触发只运行演练，不会进入发布作业。即使重复推送同一个标签，registry 检查也会拦下二次发布。

需要单独验证 OIDC 通路时，手动触发工作流运行 `oidc-rehearsal`：它用一个一次性的预发布版本号发布到 `oidc-test` 标签下，不触碰 `latest`，不影响市场索引，也不消耗正式版本号。

普通文档更新直接提交即可。

## Development and releases

Run `npm run check` for syntax and tests, then `npm pack --dry-run` to inspect the package. CI runs on branch pushes and pull requests. The browser tests use local fixtures in Chrome. Verify changes that depend on Muse’s live markup against the actual site as well.

A release requires maintainer approval. The order matters: the market index records npm's real publish time, so it can only be built once the version is downloadable, and the version reaches npm through the tag workflow.

1. **Bump the version, update the CHANGELOG, run `npm test`, and commit.**
2. **Tag that commit and push only the tag** (`git push origin v1.3.4`, not `main` alongside it). The workflow verifies and publishes through OIDC. Remote `main` still points at the previous release, so branch CI stays green throughout.
3. **Confirm npm can serve that exact version**, and check its provenance attestation.
4. **Run `node scripts/sync-market-index.mjs`**, commit the synced index, and push both commits to `main`.

Step 4 is the one that gets forgotten, because nothing before it needs it. Skip it and installs still work, but the plugin market and Discover keep advertising the previous version — the index does not update itself.

The `publish` job runs only when a version tag is pushed; a manual dispatch rehearses and never enters it. Re-pushing the same tag cannot double-publish, because the job asks the registry first.

To exercise OIDC on its own, dispatch the workflow: `oidc-rehearsal` publishes a throwaway prerelease under the `oidc-test` tag, leaving `latest` and the market index untouched, and costing no release number.

## 许可

提交的代码按 MIT 授权，与项目一致。
