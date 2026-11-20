# 安全策略

## 报告漏洞

如果你发现安全问题，**请不要开公开 issue**。

用 GitHub 的私密报告通道：

https://github.com/sizhe03/dsh-muse-media/security/advisories/new

在报告里写清：影响范围、复现步骤、你观察到的实际行为。如果涉及凭据，只说明「泄露了什么类型」，不要附上真实的 token 值。

## 这个插件会接触什么

理解边界有助于判断一个问题是否严重。

**插件读取：**

- 你本机 Chrome 的调试端口（仅 `127.0.0.1`），用来驱动页面
- muse.ai 页面上显示的文字（额度百分比、重置日期、生成结果）

**插件写入：**

- `<DSH_HOME>/muse-media/profiles/<accountId>/` —— 每个账号独立的浏览器配置目录，由 Chrome 自己维护
- `<DSH_HOME>/muse-media/state.json` —— 账号索引：标签、状态、额度读数、任务记录
- `<DSH_HOME>/muse-media/media/` —— 已下载的生成结果

**插件不读取也不存储：**

- 你的 Muse 密码
- Cookie、会话 token 或任何凭证 —— 登录完全由 Chrome 完成，凭据存在 Chrome 自己的配置目录里，插件不解析
- 你的 npm token 或任何构建凭据

## 本地服务

插件在 Host 进程里注册了四条路由：

| 路由 | 用途 | 访问限制 |
|---|---|---|
| `/plugins/dsh-muse-media/quota` | 额度读数 | 仅 loopback |
| `/plugins/dsh-muse-media/accounts` | 账号列表与状态 | 同源 |
| `/plugins/dsh-muse-media/accounts/action` | 账号操作（增删、登录、刷新） | 仅同机 |
| `/plugins/dsh-muse-media/media/<file>` | 已下载媒体 | 同源 |

`media` 路由只读、只服务插件自己下载的文件，路径按文件 ID 查表，不接受任意路径拼接。

浏览器调试端口由插件启动时随机选定（默认从 `19220` 起找空闲端口），只绑 `127.0.0.1`，不对局域网开放。

## 已知的设计取舍

这些不是漏洞，是有意的选择，但值得你知道：

- **无头浏览器占内存**：一个 Muse 页面约 1 GB。默认最多同时 2 个，可在高级设置里调低。
- **插件会启动真实 Chrome 进程**：它无法用别的方式登录 Muse。退出时只关闭自己启动的进程，通过 `--user-data-dir` 是否为插件目录来判断。
- **额度读数来自页面文字解析**，不是 API。muse.ai 改版会导致读数失败（但不会导致误操作——读不到就显示「未读取」）。

## 支持范围

只支持最新发布版本。旧版本的安全问题会通过发新版本修，不为旧版本单独打补丁。
