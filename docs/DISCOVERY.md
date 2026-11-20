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

## 三、GitHub 上的可见性

已有：

- `description` —— 一句话说明
- `topics` —— 8 个标签，含 `dsh-plugin`、`deepseek-harness`
- `homepage` —— 指向 npm 页面
- 5 个 release，版本历史完整

**可以再加的**：

1. **`README.md` 首屏的预览图** —— 已有，访客第一眼看到插件长什么样。
2. **GitHub 的「About」区块里加一句「为什么用这个而不是别的」** —— 目前没写。但这一句要真的能说服人，空话反而减分。
3. **仓库的 Social preview 图片** —— Settings → Social preview，别人分享链接时显示。可以用 `docs/preview.svg` 转成 PNG 上传。

---

## 四、真正有效的：出现在别人会看的地方

以上都是「让人能找到」。但**没人会主动搜一个还不知名的插件**。实际起作用的通常是：

### 1. 在同类项目的讨论里出现

如果你看到有人在讨论「DSH 怎么生图」「Muse 有没有 API」，那里就是最有效的投放点。**不要发广告式链接**，而是回答具体问题，需要时提一句「我做过一个」。

### 2. 写一次实现过程

「我怎么用 CDP 驱动 Muse 网页做插件」这类文章，会被搜到，也会被转发。技术细节比功能列表更有传播力。

你手上现成的素材很多：发送边界为什么先写日志、为什么周额度最早重置的账号优先、为什么限流不换号。这些都是真问题，写出来有人会读。

### 3. 让插件本身值得推荐

这一点最慢但最有效。现在有的：

- 49 项测试
- 完整的中英文 README
- 五个版本的 release 说明
- 诚实的边界说明（不做什么、为什么）

**别人推荐一个插件时，通常是因为「它没坑我」**，而不是因为功能多。

---

## 五、按性价比排序的建议

| 优先级 | 做什么 | 工作量 |
|---|---|---|
| 1 | 确认 `market-index.json` 在 GitHub 上可访问（现在就能做） | 1 分钟 |
| 2 | 加几个 npm keyword | 5 分钟 |
| 3 | 上传 Social preview 图 | 10 分钟 |
| 4 | 在相关讨论里回答具体问题 | 持续 |
| 5 | 写一篇实现过程 | 半天 |

前两项现在就可以做，第 3 项需要你决定要不要。

---

## 六、不要做的

- **不要刷 star** —— 一眼看得出来，反而降低可信度。
- **不要在所有地方贴链接** —— 会被当成 spam。
- **不要为了显得功能多而加功能** —— 这个插件故意不做的那些（代理、签到、媒体库），恰恰是它可信的原因。

---

## 索引地址（做完后填这里）

```
https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json
```

验证是否可访问：

```powershell
Invoke-RestMethod "https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json"
```
