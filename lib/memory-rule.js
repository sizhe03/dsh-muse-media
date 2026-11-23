// This name is also the deletion key. Changing the rule requires a new version.
export const RULE_NAME = "DSH-Muse-旁聊独立-v1";
export const RULE_TEXT = "每个旁聊只使用本旁聊中的消息、素材和生成结果。创作时，不主动查找或沿用其他旁聊里的角色、风格、构图、动作或修改要求。在同一个旁聊里，如果我要求继续修改，请以上一版作品和本轮要求为准。如果我希望参考其他作品，我会在当前旁聊里提供。";
export const MAIN_CHAT = "https://muse.ai/";

export function ruleMessage(action) {
  if (action === "set") return `请将以下名为「${RULE_NAME}」的规则写入长期记忆：\n${RULE_TEXT}\n成功后只回复“已设置”；如果无法保存，只回复“无法保存”；如果无法确认，只回复“无法确认”。`;
  if (action === "remove") return `请从长期记忆中移除名为「${RULE_NAME}」的规则。只移除这一条，保留其他记忆。不要引用、复述或概括规则内容。完成后只回复“已移除”；如果未找到，请只回复“未找到”；如果无法确认，请只回复“无法确认”。`;
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

export async function readRuleReply(page, baseline, prompt, action, deadline) {
  let previous = "", reply = "", stable = 0;
  while (Date.now() < deadline) {
    let snap, matches = false;
    try {
      snap = await page.snapshot(deadline);
      if (snap.href === MAIN_CHAT && snap.users.length === baseline.users.length + 1) {
        matches = !!await page.roundUserAttachments(prompt, true, deadline);
      }
    } catch (error) {
      return { outcome: "unconfirmed", reply, detail: error.message };
    }
    if (snap.href !== MAIN_CHAT || snap.users.length > baseline.users.length + 1) break;
    const user = snap.users.at(-1);
    if (matches && user) {
      reply = snap.agents.filter(row => row.index > user.index).map(row => row.text.trim()).filter(Boolean).join("\n");
      stable = reply && !snap.stop && reply === previous ? stable + 1 : 0;
      const outcome = ruleOutcome(action, reply);
      // Give progress-only bubbles time to be replaced by the actual receipt.
      if (stable >= 3 && Date.now() < deadline && (outcome !== "unconfirmed" || reply.trim() === "无法确认")) {
        return { outcome, reply };
      }
      previous = reply;
    } else { stable = 0; previous = ""; }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))));
  }
  return { outcome: "unconfirmed", reply };
}
