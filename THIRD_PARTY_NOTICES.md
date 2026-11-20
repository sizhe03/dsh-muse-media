# 第三方来源声明

本插件自行实现。下列项目仅作为**行为参照**被阅读，未将代码复制、摘录或改写进本包。

| 项目 | 版本 / 提交 | 参照范围 | 实际纳入的材料 |
|---|---|---|---|
| [muse2api](https://github.com/czg86389-hub/muse2api) | `19db32a`（2026-11-16，MIT） | `engine.py` 的页面自动化流程（就绪判定、输入框定位、上传控件定位、附件就绪判据、额度面板遍历与解析、附件提取、发送动作）、`cdp.py` 的协议用法、`store.py` 的选号策略、`config.py` 的浏览器探测路径 | 无。仅取值与流程参照，代码按本包结构重写 |
| Trae 连接插件（本机已安装的第三方 DSH 插件） | 本机安装版本 | `settings.section` 的注册方式：`id` 由插件自己拥有，图标按同一 `id` 寻址 | 无。仅参照 DSH 的插槽用法 |
| WorkBuddy 连接插件（本机已安装的第三方 DSH 插件） | 本机安装版本 | Loopback/Origin 请求门禁的判定思路（`Host` 与实际落地地址比对，`Origin` 双检） | 无。判定条件按本插件需要重新编写 |
| DSH 官方文档与内置包源码 | 随本机 DSH 安装 | 插槽契约、`ToolDefinition`/`ToolOutputDefinition` 形状、`attachments.saveImage` 用法、主题 token | 无。接口按文档使用 |

## 文本比对结果

按目标书 G4 的要求，对本包源码与 `muse2api` 的 `engine.py`、`cdp.py`、`store.py`、`config.py` 做了逐行比对：

- 候选行：2,733 行（长度 ≥ 30 字符的行，以及长度 ≥ 6 且含中文的行）
- 参考文件：4 个
- 完全相同的行：**3 行**，全部是有意义的固定取值，不是逻辑代码：

| 本包位置 | 参考位置 | 内容 | 说明 |
|---|---|---|---|
| `lib/browser.js:43` | `engine.py` | `--autoplay-policy=no-user-gesture-required` | Chromium 启动开关，公开文档中的固定拼写 |
| `lib/browser.js:58` | `config.py` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | macOS 上 Chrome 的标准安装路径 |
| `lib/browser.js:64` | `config.py` | `/usr/bin/google-chrome-stable` | Linux 上 Chrome 的标准安装路径 |

三行都是浏览器自身的固定常量（一个官方命令行开关、两个官方安装路径），不构成可主张著作权的表达，也不需要随附许可声明。除此之外没有任何长行或中文注释与本包重合。

比对脚本与结果可用提交 `_compare.mjs`（开发期临时文件，不入包）复现。

## 许可

本包采用 MIT 许可，全文见 [`LICENSE`](LICENSE)。
上表所列项目均采用允许参照的许可（muse2api 为 MIT），但由于**未纳入任何代码**，本包不附带它们的许可声明。

## 商标

"Muse" 仅用于说明本插件兼容的产品（muse.ai）。本插件与该产品无隶属或授权关系，不使用其官方标识、品牌配色，也不做任何授权暗示。图标为本包自绘的几何图形。
