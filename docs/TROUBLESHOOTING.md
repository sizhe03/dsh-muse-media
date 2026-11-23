# 生成问题排查 · Troubleshooting

[中文](#中文) · [English](#english)

## 中文

| 遇到的情况 | 怎么查 |
| --- | --- |
| 图片比预期小 | 去「设置 → Muse → 生成记录」，找到本次任务，点「打开文件所在位置」。在 Windows 文件属性的「详细信息」里查看实际宽高。若显示「仅预览」，打开该条记录的 Muse 原对话，检查可下载的原图。旧版曾保存过 498 × 498 的小图。 |
| 下载的文件和发送给别人的文件看起来不同 | 插件将取回的媒体字节直接写盘。用 PowerShell 对两个文件分别执行 `Get-FileHash -Algorithm SHA256 -LiteralPath '文件路径'`。相同的哈希说明两份文件内容一致。原图和预览的判断还要看实际像素。 |
| 发送后显示「结果未知」 | 先到该账号的 Muse 原对话查看作品是否已经生成。再次提交是一次新的生成，可能再次消耗额度。 |
| Muse 提示内容不符合政策 | 查看插件附带的 Muse 原话，按具体原因调整描述。若显示超时，错误里的页面末尾文字有助于判断 Muse 当时返回了什么。 |
| 额度耗尽或限流 | 查看该账号的额度读数和上游给出的重置或重试时间。任务遇到这两类限制会停止。 |
| 页面打不开或登录失效 | 在该账号的浏览器窗口打开 muse.ai，确认网页可达并重新验证登录。插件用本机的 Chrome、Chromium 或 Edge，为每个账号单独保存浏览器配置。 |
| 旁聊规则显示「待确认」 | 展开账号查看时间和回执，点「重新读取回执」。连通测试会向 Muse 发送测试消息，设置和移除规则会在主聊天发送请求，重读回执仅查看已有回复。 |

### 视频提示地区不可用

维护者记录过来自美国、加拿大、日本、新加坡的成功案例。在七个账号、两个月的观察中，一个账号在观察期结束时仍无法生成视频，同一账号的图片生成正常。该账号换 IP 后仍受限。注册邮箱、WebRTC 和 DNS 是当时排查的线索，单凭这些信息无法判定其他账号是否可用，也无法推断限制会持续多久。请记录 Muse 给该账号的原话。

[返回插件首页](../README.md)

## English

| Symptom | What to check |
| --- | --- |
| An image is smaller than expected | Find this specific task under Settings → Muse → History and select **Show in folder**. On Windows, check the pixel dimensions under Properties → Details. If the record says **Preview only**, open its Muse conversation and look for a full-size download. Some older versions saved 498 × 498 previews. |
| Two copies look different | The plugin saves the bytes it retrieves. Run `Get-FileHash -Algorithm SHA256 -LiteralPath 'file path'` on each copy in PowerShell. Matching hashes establish that the bytes match. Check the dimensions to distinguish a preview from a full-size image. |
| The outcome is unknown after sending | Check the conversation on the original Muse account for a result before submitting again. Another generation can spend more allowance. |
| Muse declined the content | Read Muse’s quoted reply and revise the prompt accordingly. A timeout may include the last text from the page, which can help identify the upstream response. |
| The account is out of allowance or rate-limited | Check the account reading and any reset or retry time supplied by Muse. Either limit stops the task. |
| Muse is unreachable or the sign-in expired | Open muse.ai in that account’s browser window, check connectivity, then verify sign-in. The plugin uses the local Chrome, Chromium or Edge installation and a separate browser profile per account. |
| A side-chat rule is unconfirmed | Expand the account, review the timestamp and select **Check chat receipt**. The connectivity test sends a test message. Setting or removing a rule sends a request in the main chat. Checking its receipt only reads existing replies. |

### Muse reports video is unavailable in this region

The maintainer recorded successful runs in the United States, Canada, Japan and Singapore. Across seven accounts observed for two months, one still could not generate video at the end of the observation. Image generation kept working on that account. Changing IP did not restore video for that account. The investigation considered the registration email, WebRTC and DNS. These observations do not establish eligibility for other accounts or the duration of a restriction. Keep Muse’s reply for the affected account.

[Back to the plugin](../README.en.md)
