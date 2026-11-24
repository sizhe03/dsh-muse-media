// This name is also the deletion key. Changing the rule requires a new version.
export const RULE_NAME = "DSH-Muse-旁聊独立-v1";
export const RULE_TEXT = "每个旁聊只使用本旁聊中的消息、素材和生成结果。创作时，不主动查找或沿用其他旁聊里的角色、风格、构图、动作或修改要求。在同一个旁聊里，如果我要求继续修改，请以上一版作品和本轮要求为准。如果我希望参考其他作品，我会在当前旁聊里提供。";
export const SIDE_CHAT_RULE = {
  name: RULE_NAME, text: RULE_TEXT, state: "memoryRule",
  eligible: "autoRuleEligible", setting: "autoSetMemoryRule",
};
export const VIDEO_RULE = {
  name: "DSH-Muse-视频原片优先-v1",
  text: "每次生成视频（包括按我要求续改）时，本轮一旦生成可交付的视频，请先把本轮首次生成的原始视频文件或可下载链接直接发给我，即使它有瑕疵或未达到预期也要保留并交付。可以在原片旁简短指出偏差，然后停下等我决定。不要因为你自己的质量判断而重生成、修补、剪辑、转码、调整速度、拼接首尾，或用处理版替换或隐藏原片。我明确要求修改、后期或重做时，再按该次指令执行，保留已有原片。如果确实没有生成可交付的文件，如实说明。此规则仅用于视频，保留已有的旁聊独立规则。",
  state: "videoRule", eligible: "autoVideoRuleEligible", setting: "autoSetVideoRule",
};
export const MAIN_CHAT = "https://muse.ai/";

export function ruleMessage(action, requestId, rule = SIDE_CHAT_RULE) {
  const receipt = requestId ? `\n本次回执编号：${requestId}（仅用于定位本条消息，请勿写入记忆或回复。）` : "";
  if (action === "set") return `请将以下名为「${rule.name}」的规则写入长期记忆：\n${rule.text}\n成功后只回复“已设置”；如果无法保存，只回复“无法保存”；如果无法确认，只回复“无法确认”。${receipt}`;
  if (action === "remove") return `请从长期记忆中移除名为「${rule.name}」的规则。只移除这一条，保留其他记忆。不要引用、复述或概括规则内容。完成后只回复“已移除”；如果未找到，请只回复“未找到”；如果无法确认，请只回复“无法确认”。${receipt}`;
  throw new Error("未知规则操作");
}

// Exact, completed replies only. Other wording remains available to the user as a receipt.
export function ruleOutcome(action, reply) {
  const text = reply.trim().replace(/[。.!！]$/, "");
  if (action === "set" && text === "已设置") return "set";
  if (action === "set" && text === "无法保存") return "refused";
  if (action === "remove" && text === "已移除") return "removed";
  if (action === "remove" && text === "未找到") return "absent";
  return "unconfirmed";
}

export async function readyRuleChat(page) {
  // The hydrated shell can appear before the user's message history and saved draft.
  const deadline = Date.now() + 5000;
  let previous, stable = 0;
  while (Date.now() < deadline) {
    const snap = await page.snapshot(deadline);
    if (snap.href !== MAIN_CHAT) throw new Error("页面已离开 Muse 主聊天。");
    const signature = JSON.stringify([snap.users.length, snap.users.at(-1), snap.agents.at(-1), snap.composer, snap.stop]);
    stable = signature === previous ? stable + 1 : 0;
    if (stable >= 3) return snap;
    previous = signature;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Muse 主聊天仍在加载或回复，请稍后再操作。");
}

const normalText = value => String(value ?? "").replace(/\s+/g, " ").trim();
const userText = row => normalText(row.text).replace(/^(?:你|您|我|You)\s*[:：]\s*/i, "");

// The first manual rollout used these two request formats before a plugin receipt existed.
function rolloutMessage(id, verifyFirst) {
  const name = VIDEO_RULE.name;
  const instruction = verifyFirst
    ? `请先核对本账号是否已有名为「${name}」的长期记忆。若已有以下完整约定，请直接确认；若缺失，请按同一个名字补存，只保留一条。用于以后新建和已有的旁聊。`
    : `请将以下名为「${name}」的规则写入这个账号的长期记忆，对以后新建和已有的旁聊生效。`;
  return `${instruction}\n${VIDEO_RULE.text}\n实际保存成功后只回复“已设置”，无法保存请回复“无法保存”，无法确认请回复“无法确认”。\n本次回执编号：${id}（仅用于定位本条消息，不写入记忆或回复。）`;
}

export function findVideoRequest(snapshot) {
  const text = snapshot.users.map(userText).findLast(value => value.includes(VIDEO_RULE.name));
  const requestId = text?.match(/本次回执编号：([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})（/i)?.[1];
  if (!requestId) return;
  for (const action of ["set", "remove"]) {
    if (text === normalText(ruleMessage(action, requestId, VIDEO_RULE))) return { action, requestId, prompt: text };
  }
  if ([false, true].some(verify => text === normalText(rolloutMessage(requestId, verify)))) {
    return { action: "set", requestId, prompt: text };
  }
}

export async function readRuleReply(page, prompt, action, deadline, { legacy = false } = {}) {
  const wanted = normalText(prompt);
  const commands = legacy ? ["set", "remove"].map(a => normalText(ruleMessage(a))) : [];
  let previous = "", reply = "", stable = 0, delivered = false, messageId;
  let detail;
  while (Date.now() < deadline) {
    let snap;
    try { snap = await page.snapshot(deadline); }
    catch (error) { detail = error.message; break; }
    if (snap.href !== MAIN_CHAT) { detail = "页面已离开 Muse 主聊天。"; break; }
    const matches = snap.users.filter(row => userText(row) === wanted);
    const user = matches[0];
    if (matches.length > 1 || (legacy && user && snap.users.some(row =>
      row.index > user.index && commands.some(command => userText(row).startsWith(command))))) {
      detail = "主聊天中有多条规则操作，无法唯一核对此次回执。";
      break;
    }
    if (user) {
      delivered = true;
      messageId = user.id ?? messageId;
      const next = snap.users.find(row => row.index > user.index);
      reply = snap.agents.filter(row => row.index > user.index && (!next || row.index < next.index))
        .map(row => row.text.trim()).filter(Boolean).join("\n");
      stable = reply && (!snap.stop || next) && previous === reply ? stable + 1 : 0;
      const outcome = ruleOutcome(action, reply);
      if (stable >= 3 && Date.now() < deadline && (outcome !== "unconfirmed" || reply === "无法确认")) {
        return { outcome, reply, delivered, messageId };
      }
      previous = reply;
    } else { stable = 0; previous = ""; }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))));
  }
  detail ??= delivered ? "已在主聊天看到规则请求，尚未取得明确回执。" : "在主聊天中未找到这条规则请求，送达情况待确认。";
  return { outcome: "unconfirmed", reply, delivered, messageId, detail };
}
