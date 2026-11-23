# 参与贡献

这个插件通过 CDP 驱动真实的 Chrome 操作 muse.ai，所以最需要帮助的地方是**报告哪些情况下它会出错**——尤其是那些看起来像插件坏了、实际是上游改版造成的问题。

## 通过什么方式

- **报错、功能问题、使用疑问** —— [提交问题报告](https://github.com/sizhe03/dsh-muse-media/issues/new/choose)。模板会问版本号和复现步骤，这些信息决定了能不能查下去。
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

维护者同意发版后，按当前手动流程更新包版本和 CHANGELOG。市场索引使用 npm 的实际发布时间，须在该版本可从 npm 安装后运行 `node scripts/sync-market-index.mjs`。将版本、更新记录和同步后的索引一起提交，运行 `npm test`，再打对应的 `v*` 标签。普通文档更新直接提交即可。

标签会触发发布工作流校验版本，工作流也支持手动触发。仅在仓库变量 `NPM_PUBLISH_ENABLED` 为 `true` 时，工作流才会执行 npm 发布。手动发布与工作流发布应择一执行。

## Development and releases

Run `npm run check` for syntax and tests, then `npm pack --dry-run` to inspect the package. CI runs on branch pushes and pull requests. The browser tests use local fixtures in Chrome. Verify changes that depend on Muse’s live markup against the actual site as well.

A release requires maintainer approval. In the manual process, update the package version and changelog, publish the approved package, then run `node scripts/sync-market-index.mjs` once the registry serves the new version. Commit the manifest, changelog and index together, run `npm test`, and tag the verified commit. The tag workflow verifies the version. Its npm publish step is gated by `NPM_PUBLISH_ENABLED` and should only be used as the publishing method for a version that has yet to ship.

## 许可

提交的代码按 MIT 授权，与项目一致。
