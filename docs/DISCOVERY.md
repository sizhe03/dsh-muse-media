# 让别人发现这个插件

这份文件记**具体怎么做**，按投入产出排序。

---

## 一、DSH 插件市场（最直接，做一次就够）

DSH 有一个「发现」标签页，它读**插件市场索引**——一个 JSON 文件，列出一批可安装的插件。

关键在于：**索引是一份你能自己托管的文件**，不需要任何审批或收录流程。你把它放到网上，任何人把 URL 加进 DSH 就能看到你的插件。

### 已经准备好了

仓库根目录的 `market-index.json` 就是索引，已通过 DSH 自带校验器验证。

```json
{
  "format": 1,
  "title": { "en": "Muse media", "zh": "Muse 媒体" },
  "plugins": [
    {
      "name": "dsh-muse-media",
      "versions": [ ... ]
    }
  ]
}
```

### 怎么让别人用上

**方式一（推荐）：让别人一行命令加进来**

告诉他们索引地址，在 DSH 里配置：

```
https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json
```

配置位置在 **发现 → 添加索引源**，或者写进 `cordis.patch.yml` 里 `plugin-market` 行的 `indexes` 字段。

**方式二：自己做一个「插件集合」索引**

如果你以后做第二个插件，把两个都放进同一个 `market-index.json`，别人加一次就有全套。这是这个机制的设计意图。

### ⚠️ 每次发新版要更新索引

`market-index.json` 里的版本列表必须包含最新版本。忘了更新，别人在 Discover 里看到的还是旧版本。

这条有测试守护（`test/market-index.test.mjs` 最后一项），忘了会测试失败。

---

## 二、npm 上的可见性

npm 自己的搜索靠这几个字段：

| 字段 | 现状 | 说明 |
|---|---|---|
| `keywords` | 7 个 | `dsh-plugin`、`deepseek-harness`、`muse`、`image-generation` 等 |
| `description` | 180 字符 | 出现在搜索结果里 |
| README | 有 | 包的页面主体 |

**`dsh-plugin` 这个关键词是关键**——别人搜 DSH 插件时会用到。同类插件（`dsh-connect-trae`、`dsh-connect-workbuddy`）也用它。

想更显眼，可以加几个：`deepseek`、`ai-tool`、`video-generation`、`browser-automation`。

---

## 项目的公开入口

| 入口 | 用户能找到什么 |
| --- | --- |
| [GitHub 首页](https://github.com/sizhe03/dsh-muse-media#readme) · [English](../README.en.md) | 实测续改对比、安装步骤、作品下载和设置说明 |
| [GitHub Releases](https://github.com/sizhe03/dsh-muse-media/releases) | 每版改动、升级提示和实测记录 |
| [插件市场索引](https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json) | DSH 可以安装的 npm 版本、插件图标和双语简介 |
| [npm](https://www.npmjs.com/package/dsh-muse-media) | 已发布的安装包、版本历史和随包 README |
| [反馈入口](https://github.com/sizhe03/dsh-muse-media/issues/new/choose) | 附版本和复现步骤提交问题 |

修改仓库文档和在线市场索引后，访客可以直接看到更新。npm 页面和已安装插件中的介绍随包发布。更换 GitHub 分享图时，在仓库设置的「社交预览」中上传[公开封面](muse-cover.png)。
