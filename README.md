# Muse 媒体 · DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/dsh-muse-media.svg)](https://www.npmjs.com/package/dsh-muse-media)
[![npm downloads](https://img.shields.io/npm/dm/dsh-muse-media.svg)](https://www.npmjs.com/package/dsh-muse-media)
[![license](https://img.shields.io/npm/l/dsh-muse-media.svg)](./LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2f6fed)](#安装与登录)

用自己的 Muse 账号，在 DSH 对话里生成图片和视频。想改刚才的作品，直接说要改哪里；想找原文件，去生成记录里点一下就能定位。

[English](README.en.md) · [安装与登录](#安装与登录) · [版本说明](https://github.com/sizhe03/dsh-muse-media/releases/latest) · [报告问题](https://github.com/sizhe03/dsh-muse-media/issues/new/choose)

![同一条 Muse 对话的两次生成：左边是青釉咖啡杯，右边是改成深红釉后的结果](docs/muse-cover.png)

> 「把杯子的釉色改成深红色，其他一切保持不变。」上图是这次续改前后实际保存的两张预览。

## 安装与登录

1. 在 DSH 插件市场搜索 **Muse 媒体** 并安装。如果搜索不到，在市场中添加 [Muse 插件索引](https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json) 后刷新。
2. 打开 **设置 → Muse → 新增账号 → 打开登录窗口**，在弹出的浏览器里登录自己的 Muse 账号。
3. 回到 DSH，试试「用 Muse 画一只青釉咖啡杯，白色背景」。每次生成会消耗该 Muse 账号的额度。插件使用本机的 Chrome、Chromium 或 Edge。

适用版本见 [插件清单](package.json)。通过市场安装后，可在 DSH 中接收更新。本地开发也可以通过 [npm](https://www.npmjs.com/package/dsh-muse-media) 安装。

```bash
npm install dsh-muse-media
```

## 接着改一张图或一段视频

刚画完杯子，直接说「把釉色改成深红色，保留杯形和光线」，就能在原 Muse 对话里接着改。默认的「自动选择」会为新作品开新对话，续改则沿用原作品的账号和对话。

想改几天前的作品，点 DSH 输入框旁的 **Muse**，按标题或账号搜索，再选中那条对话。此后，**当前 DSH 聊天**里的 Muse 生图和视频都会接到所选对话的最新一轮。选回「自动选择」即可解除固定。列表里找不到的作品，可以展开「通过 Muse 对话链接添加」，选择原账号并粘贴网页地址。

<img src="docs/thread-picker-zh.png" width="390" alt="输入框旁的 Muse 菜单已展开，可选自动选择、陶瓷咖啡杯或通过 Muse 对话链接添加">

*插件的对话选择器，使用示例账号和标题。*

## 找到原图和原视频

打开 **设置 → Muse → 生成记录**，找到对应作品，点 **打开文件所在位置**。Windows 会在资源管理器里直接选中那一份文件。也可以在记录里下载图片或视频，展开查看完整路径。

如果记录标为 **仅预览**，下载按钮保存的是这张预览图。点 **打开 Muse 原对话** 查找上游可下载的原图，无需再次生成。缺少链接的旧记录可以从 Muse 的历史对话找回。

## 账号、额度与旁聊

- **看额度。** 输入框旁的「周额度已用」属于显示的 Muse 账号。空闲时是当前查看的账号，生成时是本次使用的账号。悬停可看重置时间，在账号页点「刷新」可读取新数据。
- **选账号。** 独立生成优先使用周额度最早重置的可用账号。「同条件时优先」用于条件相同的账号。额度耗尽或上游限流时，本次任务停止。
- **减少不同作品互相干扰。** 默认在新账号首次验证登录后，插件向 **Muse 主聊天**发送一次长期规则，请 Muse 只沿用当前旁聊的内容。设置页可展开阅读规则全文。已有账号可手动设置，关闭自动设置只影响后续新账号。
- **核对或移除规则。** 展开账号可看设置或移除请求的时间和 Muse 实际回复。「待确认」时点「重新读取回执」会再读主聊天，无需重发。移除时只指明规则名 `DSH-Muse-旁聊独立-v1` 并请 Muse 避免复述。回执能确认 Muse 如何回应，实际生成效果仍取决于 Muse。

<details>
<summary>查看额度示意图和常用设置</summary>

![三个账号的周额度和输入框旁的额度提示](docs/preview.svg)

在 **设置 → Muse → 设置** 中调整后点「保存」。

| 设置项 | 默认值 | 用途 |
| --- | --- | --- |
| `headlessAfterLogin` | `true` | 登录后在后台生成 |
| `idleReapSeconds` | `600` | 浏览器闲置多少秒后关闭，`0` 表示保持打开 |
| `maxLiveBrowsers` | `2` | 同时运行的浏览器数，`0` 表示不限 |
| `imageTimeoutSeconds` | `300` | 等待图片的秒数 |
| `videoTimeoutSeconds` | `780` | 等待视频的秒数 |

</details>

<details>
<summary>生成工具与原文提示词</summary>

| 工具 | 用法 |
| --- | --- |
| `muse_draw_image` | 从文字生图，或通过 `image` 提供最多 10 张参考图。支持本机路径、`file://`、data URL 和对话附件的 `attachmentId`。 |
| `muse_draw_video` | 描述时长、镜头和动作。要从指定画面开始，把首帧放在第一张参考图。 |
| `muse_quota` | 读取 Muse 计划、本周已用比例、重置时间和额外额度。 |

图片和视频工具都接受完整的 `prompt`。需要逐字使用当前 DSH 聊天里的原文时，可用 `promptSource` 指定含首尾标点的起止短句，新增要求写入 `promptAmendment`。如果范围缺失或有多处匹配，插件会在创建任务前要求修正。

</details>

## 帮助与反馈

尺寸偏小、内容被拒、账号所在地区无法生成视频，或发送后结果未知时，先按现象查[排查指南](docs/TROUBLESHOOTING.md#中文)。报告问题时附上插件版本和页面提示即可，账号凭据请留在本机。

[提交问题](https://github.com/sizhe03/dsh-muse-media/issues/new/choose) · [安全说明](SECURITY.md) · [设计说明](docs/DESIGN.md) · [参与贡献](CONTRIBUTING.md) · [第三方来源](THIRD_PARTY_NOTICES.md) · [MIT 许可](LICENSE)
