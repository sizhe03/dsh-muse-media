# Muse Media for DeepSeek Harness

Generate images and videos in a DSH conversation with your own Muse account. Ask for a change to revise the last result, or open its saved file directly from History.

[中文](README.md) · [Install and sign in](#install-and-sign-in) · [Release notes](https://github.com/sizhe03/dsh-muse-media/releases/latest) · [Report an issue](https://github.com/sizhe03/dsh-muse-media/issues/new/choose)

![Two results from the same Muse thread: the original teal mug on the left and its deep red revision on the right](docs/muse-cover.png)

> “Change the glaze to deep red and keep everything else the same.” These are the two previews saved during that revision.

## Install and sign in

1. Search for **Muse media** in the DSH plugin market. If it does not appear, add the [Muse market index](https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json) and refresh.
2. Go to **Settings → Muse → New account → Open sign-in window**. Sign in to your Muse account in the browser window.
3. Back in DSH, try “Use Muse to draw a teal ceramic mug on a white background.” Each generation uses that account’s Muse allowance. The plugin uses your installed Chrome, Chromium, or Edge.

You can also install it with [npm](https://www.npmjs.com/package/dsh-muse-media).

```bash
npm install dsh-muse-media
```

## After generating

| What you want to do | How to do it |
| --- | --- |
| Revise the last image or video | Ask “make the glaze deep red” or “slow down the last second of the video.” Each edit continues from the latest version in the original Muse account and thread. |
| Return to an older project | Select **Muse** beside the composer to find and pin a conversation, or add its Muse web link. The selection applies to the current DSH chat. Choose **Automatic** to return to the default. |
| Find the saved image or video | Open **Settings → Muse → History** and choose **Show in folder**. Windows selects the file in Explorer. You can also download it directly. |
| Retrieve an original when only a preview was saved | Open the original Muse conversation from the record to download the available image without spending another generation credit. For older records without a link, use the conversation history on Muse. |

### Side-chat memory rule

Accounts shows the full rule and lets you enable a one-time request in a newly signed-in account’s main Muse chat. It asks Muse to keep different side chats independent while allowing edits in the same chat. Image and video generation no longer prepend an instruction. Existing accounts require a manual action. A previously disabled independence setting carries over as disabled.

Each account shows the last set or removal attempt, its time, Muse’s actual reply and the previous confirmed state when relevant. If a request is unconfirmed, select **Check chat receipt** to read the existing reply from the main chat. Removal refers only to `DSH-Muse-旁聊独立-v1` by name and asks Muse not to repeat its contents. Other rules and the main-chat history remain. Disabling automatic setup only affects future accounts.

## Requirements

1. **Chrome, Chromium, or Edge.** No browser is bundled.
2. **DeepSeek Harness** 0.2.2-rc.5 or the same minor line, Node `^22.19.0 || >=24.0.0`.
3. **Your own free Muse account.** The plugin only drives a browser you signed in to; registration and sign-in are yours.

## Tools

- `muse_draw_image` — text-to-image; pass `image` (local path, `file://`, data URL, or a conversation attachment's `attachmentId`) for image-to-image, up to 10 references.
- `muse_draw_video` — text-to-video; pass `image` to use it as the first frame. Extra references upload fine, but Muse guarantees only the first; the rest is undocumented upstream.
- `muse_quota` — plan name, this week's used percentage, next reset, and the separate extra allowance.

Muse has no separate video mode: the web UI has one composer, and "make a video" lives in the prompt. Put duration and camera direction in `prompt`.

Both generation tools accept `promptSource` to reuse a user-authored brief from the current DSH chat. Its `start` and `end` are exact excerpts delimiting one text range, inclusive. Later runs can reuse the same range and append explicit changes via `promptAmendment`. Select complete sentences or lines, including their original punctuation. A brief can also start after a label such as “Prompt:”. Surrounding conversation can be any length. For a phrase inside a sentence, use `prompt` directly. A missing or ambiguous range stops the call before a task is created. Direct calls can still supply a complete `prompt`.

## The settings page

Three panes, each answering one question:

- **Accounts** shows account status and weekly usage. Select an account name to expand its controls or use Refresh to read usage.
- **History** filters recent generations by media type. Use **Show in folder** to locate the saved file, or download the image or video directly. A preview-only record downloads the preview and links to its original Muse conversation when available. Expand the record for its full local path, preview, duration and usage readings.
- **Settings** groups generation preferences, browser options, timeouts and local storage. Drafts survive tab switches. Select Save to apply them.

The pill beside the composer shows `Muse · 25% weekly · acc-01`; hover it for the plan, reset date, reading time, and which account the figure belongs to.

![Three Muse accounts with their weekly allowance, the usage pill beside the composer, and a generated frame](docs/preview.svg)

## How an account is chosen

With several accounts, the one whose **weekly allowance resets soonest** runs first, then usage, then your "prefer when tied" mark. The reasoning: a weekly allowance is lost on reset while extra credits never expire, so the expiring one is spent first.

While idle the pill shows **the account you are looking at**; the next generation may pick another. The tooltip says so.

## Updating

**Only an npm install receives updates.** Harness asks the registry for newer versions and offers an update in settings — one click, no reinstall.

A copy installed from a local directory (`file:` / `link:`) is never marked updatable, because its code is on your disk. Run `npm install dsh-muse-media` again to move forward.

## When the output size is wrong

**Measure first, read code second.** This is learned the hard way: hours went into reading code without finding it, and one
look at the file header answered it in five seconds.

### 1. Measure the file you actually have

Explorer → right-click → Properties → Details → Frame width / Frame height.

Or by script:

```powershell
python -c "from PIL import Image; im=Image.open(r'path'); print(im.size)"
```

**Do this first: it is the fastest check and it cannot mislead.**

### 2. Confirm the plugin produced that file

```powershell
$tasks = Get-Content "$env:USERPROFILE\.dsh\muse-media\tasks.json" -Raw | ConvertFrom-Json
$tasks.tasks | Where-Object { $_.media } | Select-Object -First 1 -ExpandProperty media
```

That path is what the plugin wrote.

### 3. Compare fingerprints if needed

```powershell
Get-FileHash 'your-file.png' -Algorithm SHA256
Get-FileHash "<the path from step 2>" -Algorithm SHA256
```

### What each result means

| Result | Conclusion | What to do |
|---|---|---|
| The file appears in no task record | The plugin did not produce it | Check your own pipeline for another step |
| Recorded, correct size | The plugin delivered correctly | The problem is downstream (playback, transcoding) |
| Recorded, **smaller than expected** | A preview may have been saved | Check for the original in the corresponding Muse thread |
| Recorded, fingerprints differ | The file was replaced | Check intermediate steps |

**Note the third row**: in that case **the fingerprints match** — the plugin stored exactly what it fetched. So a fingerprint
comparison cannot detect this class of bug; **the size must be measured.**

### Known issue

Earlier releases sometimes saved a 498 × 498 preview. Since v1.3.0 the plugin reloads the thread when it finds a likely preview and checks the downloaded image dimensions. For a previously saved preview, look for the original in the corresponding Muse thread.

**The plugin does not transcode.** It writes the bytes Muse returned, unchanged: no ffmpeg, no resizing, no re-encoding.

## What it costs

Every generation really spends that account's Muse allowance, exactly as clicking in the web UI would. The same prompt produces a different result twice — there is no seed upstream and the plugin does not offer one. A rate limit or an exhausted allowance stops the task; the plugin will not quietly switch accounts, with one exception: an expired sign-in.

## Troubleshooting generation failures

Muse **accepts** the request and then produces nothing. Two causes are known, and they need opposite responses:

### 1. The content was refused

Sexual implication, violence and similar content are declined.

**What to do**: rephrase. **Retrying the same prompt will not work.**

The plugin recognises this reply and says the prompt did not meet Muse's content policy, quoting the page.

### 2. Video generation is restricted by the account's region

**Images are not restricted; video is.** Known-available regions: **United States, Canada, Japan, Singapore**.

This is the one most easily mistaken for a broken plugin. The facts:

- Muse answers **403**, and the decision is based on the account's region.
- **Once an account is flagged, it does not recover.** Measured over two months across seven accounts: six stable; one whose registration IP was outside a supported region still could not generate video two months later, while its image generation kept working the whole time.
- So **changing IP, retrying, or rephrasing will not restore it.** Only a different account will.

**What actually works (measured):**

1. The exit IP **at registration** must be in a supported region.
2. The exit IP **at use time** must also be in a supported region.
3. The exit must genuinely be there — **WebRTC and DNS leaks expose the real location**. Routing traffic through a proxy while WebRTC and DNS stay local is the same as not proxying at all.
4. Switching between servers inside one region (Seattle ↔ Los Angeles) does not affect generation; no failures observed from that.

**The email does not matter.** Any email works; what matters is the region at registration and at use.

The plugin recognises this reply and says the block is bound to the account, that changing IP or retrying will not restore it, and quotes Muse's own words.

### 3. Image generation needs outbound access

Images are not region-restricted, but the plugin operates the muse.ai web app, so **it must be reachable**. With no working connection nothing will generate.

### When the plugin does not recognise it

Muse's wording can change. When neither recogniser fires, the timeout error now **includes the tail of the page** — you see what Muse actually said, rather than only "timed out".

## Boundaries

- Drives only the browser you installed; the debugging port binds `127.0.0.1`.
- On exit, closes only the processes it started.
- Concurrent browsers are capped (2 by default); one headless Muse page uses about 1 GB.
- Delivered media is **never deleted automatically** — it cost allowance and is referenced by the message that announced it.
- Does not provide proxying, daily check-ins, a media library, thumbnails, FFmpeg, canvas, or batch tooling.
- Does not use Muse's chat model.
- Spends only Muse allowance; neither affects nor calls any other installed image or video plugin.

## Configuration

Every value lives in `cordis.patch.yml` and can also be changed in **Settings → Muse → Settings**. The common ones:

| Key | Default | Meaning |
|---|---|---|
| `headlessAfterLogin` | `true` | No window during generation; only first sign-in needs one |
| `idleReapSeconds` | `600` | Close an idle browser after this long; `0` keeps it |
| `maxLiveBrowsers` | `2` | Concurrent browsers; `0` is unlimited |
| `imageTimeoutSeconds` | `300` | Image wait limit |
| `videoTimeoutSeconds` | `780` | Video wait limit |

## CI

Two workflows:

- **`.github/workflows/ci.yml`** — runs the tests on every push and pull request, so a broken test is
  found when the change lands rather than while cutting a release.
- **`.github/workflows/publish.yml`** — runs on `v*` tags only, verifies the tag against the manifest,
  and skips publishing (releases are still made by hand).

### When a release happens

Two conditions, both required:

1. **Enough has accumulated that upgrading is worth someone's time.** A single bug fix, test or documentation
   edit stays a local commit until there is a reason for others to update.
2. **The maintainer agrees first.**

This is not fussiness. The project once shipped 17 versions in six hours — one every 21 minutes on average,
half of them fixing the previous one. That is `0.0.x` behaviour wearing a `1.0.x` number, and it left every
intermediate state permanently downloadable.

Chrome is installed in CI because the page-layer tests drive a real browser. **If Chrome fails to start in
CI the tests fail rather than skip** — a skip would let `npm test` exit 0 with nothing verified. Skipping
happens only on a machine without Chrome, and it says so.

## Development

```bash
npm test        # 178 checks: manifest, index, encoding, theme tokens, CI structure, decision layer, page layer, refusal recognition
npm run check   # syntax plus the tests
```

The suite encodes the defects that actually shipped: a version disagreeing with the changelog, a detail document the Host refuses to render, theme tokens the Host does not define, an encoding corruption, and a publish job that would run without a credential.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the design and implementation notes, and [`SECURITY.md`](SECURITY.md) for what the plugin touches.

## License

MIT. See [`LICENSE`](LICENSE).
