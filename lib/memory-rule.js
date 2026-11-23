// This name is also the deletion key. Changing the rule requires a new version.
export const RULE_NAME = "DSH-Muse-旁聊独立-v1";
export const RULE_TEXT = "每个旁聊只使用本旁聊中的消息、素材和生成结果。创作时，不主动查找或沿用其他旁聊里的角色、风格、构图、动作或修改要求。在同一个旁聊里，如果我要求继续修改，请以上一版作品和本轮要求为准。如果我希望参考其他作品，我会在当前旁聊里提供。";
export const MAIN_CHAT = "https://muse.ai/";

export function ruleMessage(action, requestId) {
  const receipt = requestId ? `\n本次回执编号：${requestId}（仅用于定位本条消息，请勿写入记忆或回复。）` : "";
  if (action === "set") return `请将以下名为「${RULE_NAME}」的规则写入长期记忆：\n${RULE_TEXT}\n成功后只回复“已设置”；如果无法保存，只回复“无法保存”；如果无法确认，只回复“无法确认”。${receipt}`;
  if (action === "remove") return `请从长期记忆中移除名为「${RULE_NAME}」的规则。只移除这一条，保留其他记忆。不要引用、复述或概括规则内容。完成后只回复“已移除”；如果未找到，请只回复“未找到”；如果无法确认，请只回复“无法确认”。${receipt}`;
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
