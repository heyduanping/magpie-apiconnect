import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const provider = "apiconnect";
const rotationLabel = "换 Key 预览（已有线路）";
const failed = error => ({ type: "failed", error });
const keyOf = auth => auth.type === "api" ? auth.key : auth.modelKey;
const nameOf = auth => auth.accountId ?? auth.metadata?.email ?? auth.line ?? auth.metadata?.line;
const revision = auth => createHash("sha256").update(JSON.stringify([auth.type, nameOf(auth), keyOf(auth)])).digest("hex");

// The host owns all writes, locking, and account settlement. Look up only
// APIConnect slots, using the same account identity as Magpie's sign-in flow.
async function existingRoute(context, line) {
  if (!context.directory) return null;
  let accounts;
  try {
    accounts = JSON.parse(await readFile(join(context.directory, "plugin-auth.json"), "utf8"));
    if (!accounts || Array.isArray(accounts) || typeof accounts !== "object") throw new Error();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("暂时无法核对 Magpie 的现有线路，请稍后重试。");
  }
  const selected = context.selectedSlot?.();
  const apiSlots = Object.keys(accounts).filter(slot => slot === provider || slot.startsWith(provider + "#"));
  if (apiSlots.includes(selected) && nameOf(accounts[selected]) !== line) {
    throw new Error("请填写所选账号原有的线路名，或从「添加另一个账号」建立新线路。");
  }
  const match = apiSlots.find(slot => accounts[slot] && nameOf(accounts[slot]) === line);
  return match ? accounts[match] : null;
}

function snapshot(auth) {
  const data = auth.metadata ?? auth;
  return { ids: data.modelIds, source: data.quotaSource, plan: data.planLabel };
}

function describe(snapshot) {
  return [...new Set([snapshot.source, snapshot.plan].filter(Boolean))].join(" / ") || "未知";
}

function differences(before, after) {
  if (!before || !after) return "新增和移除暂不可核对。新 Key 可见模型：" + (after ? after.join("、") || "无" : "暂不可查");
  const oldIds = new Set(before);
  const newIds = new Set(after);
  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));
  return "新增：" + (added.join("、") || "无") + "\n移除：" + (removed.join("、") || "无");
}

export function loginMethods(methods, context) {
  const normal = methods.map(method => ({
    ...method,
    async authorize(inputs, options) {
      try {
        const dashboard = "modelKey" in inputs;
        const key = (dashboard ? inputs.modelKey : inputs.subscriptionKey)?.trim();
        if (!key) return failed("请填写 API Key。");
        const line = context.lineName(inputs, key);
        const old = await existingRoute(context, line);
        if (old && (keyOf(old) !== key || old.type !== (dashboard ? "oauth" : "api"))) {
          return failed("此线路已绑定其他凭据。请选择「" + rotationLabel + "」查看差异并确认替换。");
        }
        return await method.authorize(inputs, options);
      } catch (error) {
        return failed(error.message);
      }
    },
  }));
  if (!context.directory) return normal;
  const dashboardOnly = { key: "mode", op: "eq", value: "dashboard" };
  return [...normal, {
    type: "oauth", label: rotationLabel,
    prompts: [
      { type: "text", key: "line", message: "要替换的原线路名" },
      { type: "select", key: "mode", message: "新 Key 使用哪种登录方式？", options: [
        { label: "API Key", value: "api" }, { label: "官网账号与套餐 API Key", value: "dashboard" },
      ] },
      { type: "password", key: "newKey", message: "新的 APIConnect Key" },
      ...methods[1].prompts.filter(p => ["email", "password"].includes(p.key)).map(p => ({ ...p, when: dashboardOnly })),
    ],
    async authorize(inputs, { signal } = {}) {
      try {
        const line = inputs.line?.trim();
        const key = inputs.newKey?.trim();
        if (!line || !key || !["api", "dashboard"].includes(inputs.mode)) return failed("请填写原线路名、新 Key 并选择登录方式。");
        const old = await existingRoute(context, line);
        if (!old) return failed("找不到这条线路。请用 Magpie 账号卡上的原名称重试。");
        const wantDashboard = inputs.mode === "dashboard";
        // Legacy account IDs can be emails. Preserve the host's identity without
        // turning a legacy ID into a public model alias.
        const named = (old.namedLine ?? old.metadata?.namedLine) !== false && !!(old.line ?? old.metadata?.line);
        const args = { ...inputs, line: named ? line : "", [wantDashboard ? "modelKey" : "subscriptionKey"]: key };
        const candidate = await methods[wantDashboard ? 1 : 0].authorize(args, { signal, preview: true });
        if (candidate.type !== "success") return candidate;
        const fields = candidate.metadata ?? candidate;
        fields.line = line;
        fields.namedLine = named;
        if (candidate.metadata) fields.email = line;
        else fields.accountId = line;

        const checked = await context.inspectRoute(old, signal);
        const previous = snapshot(old);
        const cached = !checked.catalog;
        if (!cached) previous.ids = checked.catalog.models.map(m => m.id);
        if (checked.quota.source && checked.quota.plan !== "额度暂不可查") {
          previous.source = checked.quota.source;
          previous.plan = checked.quota.currentPlan ?? checked.quota.plan;
        }
        const next = snapshot(candidate);
        const expected = revision(old);
        const instructions = [
          "换 Key 预览", "原登录方式：" + (old.type === "api" ? "API Key" : "官网账号") + " → " + (wantDashboard ? "官网账号" : "API Key"),
          "原额度来源（最近可得读数）：" + describe(previous), "新额度来源：" + describe(next),
          cached ? "原模型列表暂不可读取，使用上次记录（如有）。" : "已读取原线路的兼容模型。",
          differences(previous.ids, next.ids),
          "输入 YES 确认替换；关闭、Ctrl+C 或输入其他文字均保留原线路。",
        ].join("\n");
        return { method: "code", url: "", instructions, async callback(code) {
          if (code?.trim() !== "YES") return failed("已取消，原线路仍可使用。");
          try {
            const current = await existingRoute(context, line);
            if (!current || revision(current) !== expected) return failed("这条线路在预览后已变更，请重新预览。");
            return candidate;
          } catch (error) {
            return failed(error.message);
          }
        } };
      } catch (error) {
        return failed(error.message);
      }
    },
  }];
}
