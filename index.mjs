import { createHash } from "node:crypto";

const provider = "apiconnect";
const modelBase = "https://apiconnect.lol/v1";
const anthropic = "@ai-sdk/anthropic";
const site = "https://apiconnect.lol";
const day = 86400000;
const pluginVersion = "0.4.1";
const responses = "@ai-sdk/openai";
const linePrompt = { type: "text", key: "line", message: "线路名（如 daily、backup；同名更新，留空自动命名）" };

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function lineName(inputs, key) {
  const name = inputs.line?.trim();
  if (!name) return "Key-" + fingerprint(key);
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name) || name === key || /^(?:sk-|Bearer)/i.test(name)) {
    throw new Error("线路名请用 1 至 32 个字母、汉字、数字、短横线或下划线。请勿填写密钥。");
  }
  return name;
}

async function request(path, { bearer, body, signal } = {}) {
  let response;
  try {
    response = await fetch(site + path, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new Error("无法连接 APIConnect，请检查网络后重试。");
  }
  if (!response.ok) {
    const status = response.status;
    const subject = path.startsWith("/v1/") ? "模型 Key" : path.endsWith("/login") ? "邮箱或密码" : "官网会话";
    const hint = { 400: "请求未被接受，请检查填写的信息。", 401: subject + "无效，请重新验证。", 403: "当前凭据无权访问，请检查分组和权限。", 429: "请求过于频繁，请稍后重试。" };
    const error = new Error("APIConnect HTTP " + status + "，" + (hint[status] || "服务暂不可用，请稍后重试。"));
    error.status = status;
    if (status === 401 && path === "/v1/models") error.signIn = "expired";
    throw error;
  }
  const payload = await response.json().catch(() => { throw new Error("APIConnect 未返回 JSON 数据。"); });
  if (path.startsWith("/api/")) {
    if (payload?.code !== 0) throw new Error("APIConnect 未接受这次请求，请检查登录状态。");
    return payload.data;
  }
  return payload;
}

function session(data, previousRefresh) {
  if (data?.requires_2fa) throw new Error("该账号启用了二次验证。请使用 API Key 登录；需要查看其他订阅时可打开官网「我的订阅」。");
  const refresh = data?.refresh_token || previousRefresh;
  if (!data?.access_token || !refresh || !(data.expires_in > 0)) {
    throw new Error("APIConnect 未返回可续期的登录信息。");
  }
  return { access: data.access_token, refresh, expires: Date.now() + data.expires_in * 1000 };
}

function groupIds(row) {
  return [row.group_id, row.group?.id, ...(Array.isArray(row.group_ids) ? row.group_ids : [])]
    .filter(id => (typeof id === "string" && id.trim()) || Number.isSafeInteger(id)).map(String);
}

const money = n => Number(n.toFixed(4)).toString();

function subscriptionUsage(records, fallbackName = "APIConnect 订阅", boundGroup) {
  const windows = [];
  const names = [];
  for (const row of records) {
    const limits = row.group ?? row;
    const name = row.group_names?.join(" / ") || limits.name || fallbackName;
    names.push(name);
    const aside = boundGroup !== undefined && !groupIds(row).includes(boundGroup);
    const prefix = (aside ? "其他订阅 · " : "") + (records.length > 1 || aside ? name + " · " : "");
    const before = windows.length;
    const termDays = Number(row.quota_period_days);
    for (const [period, label, days] of [
      ["daily", "每日", null], ["weekly", "每周", 7], ["monthly", "本期", termDays || null],
    ]) {
      const limit = row[period + "_limit_usd"] ?? limits[period + "_limit_usd"];
      if (!Number.isFinite(limit) || limit <= 0) continue;
      const amount = row[period + "_usage_usd"];
      if (!Number.isFinite(amount) || amount < 0) {
        windows.push({ name: prefix + label, display: "本次未取得用量", aside: true });
        continue;
      }
      // Magpie sums numeric limits across accounts. Multiple keys can spend the
      // same subscription. Keep the routing percentage and show its dollars verbatim.
      const display = `已用 $${money(amount)} / $${money(limit)}，剩余 $${money(Math.max(0, limit - amount))}`;
      const window = { name: prefix + label, used: 100 * amount / limit, display, aside };
      const start = Date.parse(row[period + "_window_start"]);
      const end = Date.parse(row.expires_at);
      const reportedReset = Date.parse(row[period + "_reset_at"]);
      const reset = Number.isFinite(reportedReset) ? reportedReset : days && Number.isFinite(start) ? start + days * day : NaN;
      if (reset > Date.now() && (!Number.isFinite(end) || reset < end)) {
        window.resetsAt = new Date(reset).toISOString();
        if (Number.isFinite(start) && reset > start) window.span = (reset - start) / 1000;
      }
      windows.push(window);
    }
    if (before === windows.length) windows.push({ name, display: "暂无订阅额度明细", aside: true });
  }
  const current = boundGroup === undefined ? records : records.filter(row => groupIds(row).includes(boundGroup));
  return { plan: names.join("；") || fallbackName, windows, ...(current.length === 1 && current[0].expires_at ? { until: current[0].expires_at } : {}) };
}

function modelKey(auth) {
  const key = auth?.type === "api" ? auth.key : auth?.modelKey;
  if (!key) throw new Error("此账号尚未绑定模型 API Key。");
  return key;
}

async function listModels(auth, signal) {
  const result = await request("/v1/models", { bearer: modelKey(auth), signal });
  if (!Array.isArray(result?.data)) throw new Error("APIConnect 未返回模型列表。");
  const models = result.data.filter(model => {
    if (typeof model?.id !== "string" || !/^[\w.-]+$/.test(model.id)) return false;
    const endpoints = model.supported_endpoint_types;
    if (endpoints == null) return /^claude-/i.test(model.id);
    if (!Array.isArray(endpoints)) return false;
    return endpoints.includes("messages") || endpoints.includes("responses");
  });
  return { total: result.data.length, models };
}

function catalogSummary(catalog) {
  if (!catalog) return "模型列表暂不可查，请稍后刷新。";
  if (!catalog.total) return "上游返回空列表，请检查 Key 的分组是否开放模型。";
  if (!catalog.models.length) return "上游返回 " + catalog.total + " 个模型，兼容 0 个。请检查线路是否提供 Messages 或 Responses 模型。";
  return "上游返回 " + catalog.total + " 个模型，兼容 " + catalog.models.length + " 个。请在供应商中重新获取并勾选模型。";
}

async function lookupGroup(access, key, signal) {
  for (let page = 1; ; page++) {
    const result = await request("/api/v1/keys?page_size=100&page=" + page, { bearer: access, signal });
    const rows = result?.items;
    if (!Array.isArray(rows)) throw new Error("无法核对 API Key 的订阅分组。");
    const match = rows.find(row => row.key === key);
    if (match && ["disabled", "revoked", "expired"].includes(match.status)) {
      throw Object.assign(new Error("官网报告此线路的模型 Key 已停用或过期，请更换 Key。"), { signIn: "expired" });
    }
    if (match?.status === "active") {
      const [group] = groupIds(match);
      if (group !== undefined) return group;
    }
    if (match || rows.length < 100 || page * 100 >= result.total) break;
  }
  throw new Error("请填写此账号有效订阅分组里的 API Key。");
}

async function sendModel(input, init, getAuth) {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url.origin !== site || url.username || url.password || method !== "POST" ||
      !["/v1/messages", "/v1/messages/count_tokens", "/v1/responses"].includes(url.pathname)) {
    throw new Error("APIConnect 仅接受本站已支持的模型接口。");
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const name of ["authorization", "cookie", "proxy-authorization", "x-goog-api-key", "x-api-key"]) headers.delete(name);
  const key = modelKey(await getAuth());
  if (url.pathname === "/v1/responses") {
    headers.set("authorization", "Bearer " + key);
    headers.delete("anthropic-version");
  } else {
    headers.set("x-api-key", key);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  }
  let response;
  try {
    response = await fetch(input, { ...init, headers, redirect: "error" });
  } catch (cause) {
    if (init?.signal?.aborted || input?.signal?.aborted) throw cause;
    throw new Error("无法连接 APIConnect 模型服务，请检查网络和代理。");
  }
  if (response.ok) return response;
  const hints = {
    401: "模型请求认证失败，请检查这条线路的 Key。",
    403: "当前 Key 无权调用，请检查模型所属分组。",
    404: "该线路没有这个模型，请刷新列表并核对模型 ID。",
    429: "该线路暂时限流，请稍后重试。",
  };
  if (!hints[response.status]) return response;
  const detail = await response.json().catch(() => ({}));
  const modelDenied = /model_not_found|model_not_available|model.{0,64}not (?:available|found)|模型不支持/i.test(
    [detail?.error?.type, detail?.error?.code, detail?.error?.message].join(" "));
  const message = modelDenied ? hints[404] : hints[response.status];
  const out = new Headers({ "content-type": "application/json" });
  if (response.headers.has("retry-after")) out.set("retry-after", response.headers.get("retry-after"));
  if (modelDenied && response.status === 401) out.set("x-magpie-sign-in", "kept");
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), { status: response.status, headers: out });
}

function wallet(balance) {
  return { name: "钱包余额", display: "$" + balance.toFixed(2), balance, unit: "USD", aside: true };
}

function keyLimits(data) {
  const windows = [];
  function add(name, value, reset) {
    if (!Number.isFinite(value?.limit) || value.limit <= 0) return;
    const amount = Number.isFinite(value.used) ? value.used :
      Number.isFinite(value.remaining) ? value.limit - value.remaining : NaN;
    if (!Number.isFinite(amount) || amount < 0) return;
    const window = { name, amount, limit: value.limit, unit: value.unit || "USD", used: amount / value.limit * 100 };
    const end = Date.parse(reset);
    if (Number.isFinite(end)) window.resetsAt = new Date(end).toISOString();
    windows.push(window);
  }
  add("Key 额度", data?.quota);
  for (const row of Array.isArray(data?.rate_limits) ? data.rate_limits : []) {
    if (typeof row?.window === "string" && row.window) add("Key · " + row.window, row, row.reset_at);
  }
  return windows;
}

function keyQuota(data) {
  if (data?.isValid === false || data?.status === "expired" || Date.parse(data?.expires_at ?? data?.expiresAt) <= Date.now()) {
    throw Object.assign(new Error("APIConnect 报告 Key 已失效，请更换 Key。"), { signIn: "expired" });
  }
  const expiredPlan = Date.parse(data?.subscription?.expires_at) <= Date.now();
  const limits = keyLimits(data);
  let quota;
  if (data?.subscription && !expiredPlan) {
    quota = subscriptionUsage([data.subscription], data.planName);
    quota.source = "订阅";
    quota.windows.push(sharedPlan(data.subscription, data.planName));
  } else {
    const source = Number.isFinite(data?.balance) ? "钱包" : limits.length ? "Key 额度" : "无订阅明细";
    quota = { plan: source, source, windows: [] };
    if (expiredPlan) quota.windows.push({ name: "订阅", display: "套餐已到期", aside: true });
  }
  quota.windows.push(...limits);
  if (Number.isFinite(data?.balance)) quota.windows.push(wallet(data.balance));
  if (!quota.windows.length) quota.windows.push({ name: "额度", display: "当前 Key 未提供明细", aside: true });
  return quota;
}

function diagnostic(mode, count, kind) {
  const models = Number.isInteger(count) ? " / 登录时模型 " + count + " 个" : "";
  return "APIConnect " + pluginVersion + " / " + mode + models + " / " + kind;
}

function sharedPlan(row, fallback) {
  const name = row.group_names?.join(" / ") || row.group?.name || fallback || "套餐";
  const id = row.subscription_id ?? row.id;
  const identity = id != null ? " #" + fingerprint("subscription:" + id) : "";
  return { name: "共享套餐", display: name + identity + " · 同一订阅下的 Key 共用额度，只计一次", aside: true };
}

async function keyReading(auth, signal) {
  let data;
  try {
    data = await request("/v1/usage", { bearer: modelKey(auth), signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { plan: "额度暂不可查", source: "额度接口：" + error.message, windows: [] };
  }
  return keyQuota(data);
}

async function readQuota(auth, signal) {
  if (auth.type === "api" || auth.dashboardExpired) {
    const quota = await keyReading(auth, signal);
    quota.windows.push({ name: "接入诊断", display: diagnostic("API Key", auth.metadata?.modelCount, quota.source), aside: true });
    if (auth.dashboardExpired) quota.windows.push({ name: "官网会话", display: "已过期，请重新登录官网账号恢复订阅读数", aside: true });
    return quota;
  }
  const opts = { bearer: auth.access, signal };
  let sessionExpired = false;
  function optional(error) {
    if (signal?.aborted || error.signIn) throw error;
    if (error.status === 401) sessionExpired = true;
    return null;
  }
  const [rows, user, group, keyUsage] = await Promise.all([
    request("/api/v1/subscriptions", opts).catch(optional),
    request("/api/v1/auth/me", opts).catch(optional),
    lookupGroup(auth.access, modelKey(auth), signal).catch(optional),
    keyReading(auth, signal),
  ]);
  if (sessionExpired) {
    keyUsage.windows.push({ name: "官网会话", display: "已过期，请重新登录官网账号恢复订阅读数", aside: true });
    keyUsage.windows.push({ name: "接入诊断", display: diagnostic("官网账号", auth.modelCount, "官网会话过期 / Key 额度来源：" + keyUsage.source), aside: true });
    return keyUsage;
  }
  const available = Array.isArray(rows);
  const active = (available ? rows : []).filter(row => row && (!row.status || row.status === "active") && !(Date.parse(row.expires_at) <= Date.now()));
  const quota = subscriptionUsage(active, "APIConnect", group);
  quota.source = available && active.some(row => groupIds(row).includes(group)) ? "订阅" : keyUsage.source;
  quota.windows.push(...keyUsage.windows.filter(w => w.name === "Key 额度" || w.name.startsWith("Key · ")));
  for (const row of active.filter(row => groupIds(row).includes(group))) quota.windows.push(sharedPlan(row));
  const groupStatus = !available ? "订阅列表暂不可查" : group === null ? "分组暂未核实，订阅仅供查看" : "已核对分组";
  if (!active.some(row => groupIds(row).includes(group))) quota.windows.unshift({ name: "当前分组", display: available && group !== null ? "暂无有效订阅" : groupStatus, aside: true });
  if (Number.isFinite(user?.balance)) {
    quota.windows.push(wallet(user.balance));
  }
  quota.windows.push({ name: "接入诊断", display: diagnostic("官网账号", auth.modelCount, groupStatus), aside: true });
  return quota;
}

export default async function apiConnectProvider(input) {
  return {
    config(config) {
      config.provider ??= {};
      config.provider[provider] = { name: "APIConnect", api: modelBase, npm: anthropic, models: {} };
    },
    provider: {
      id: provider,
      async models(info, { auth, signal } = {}) {
        if (!auth) return {};
        const { models } = await listModels(auth, signal);
        const result = Object.create(null);
        const aliases = Object.create(null);
        const line = auth.line ?? auth.metadata?.line;
        const plan = auth.planLabel ?? auth.metadata?.planLabel;
        const upstreamIds = new Set(models.map(model => model.id));
        for (const { id, display_name, supported_endpoint_types: endpoints } of models) {
          const messages = !Array.isArray(endpoints) || endpoints.includes("messages");
          const model = {
            ...info.models?.[id], id, name: display_name || info.models?.[id]?.name || id,
            api: { id, url: modelBase, npm: messages ? anthropic : responses },
            also: messages && endpoints?.includes("responses") ? [responses] : [],
          };
          result[id] = model;
          if (line && (auth.namedLine ?? auth.metadata?.namedLine)) {
            const alias = id + "--line-" + fingerprint(line);
            if (!upstreamIds.has(alias)) aliases[alias] = { ...model, id: alias, name: [model.name, line, plan].filter(Boolean).join(" · ") };
          }
        }
        return { ...result, ...aliases };
      },
    },
    auth: {
      async loader(getAuth) {
        return { baseURL: modelBase, apiKey: "unused", fetch: (input, init) => sendModel(input, init, getAuth) };
      },
      provider,
      methods: [
        {
          type: "api", label: "API Key（充值或套餐）",
          prompts: [{ type: "password", key: "subscriptionKey", message: "APIConnect API Key" }, linePrompt],
          async authorize(inputs, { signal } = {}) {
            try {
              const key = inputs.subscriptionKey?.trim();
              if (!key) throw new Error("请填写 API Key。");
              const line = lineName(inputs, key);
              const auth = { type: "api", key };
              const catalog = await listModels(auth, signal);
              const quota = await readQuota(auth, signal);
              const message = catalogSummary(catalog) + " 额度类型：" + quota.plan;
              await input?.client?.tui?.showToast?.({ body: { message, variant: "info" } });
              return { type: "success", key, metadata: { email: line, line, namedLine: !!inputs.line?.trim(), modelCount: catalog.models.length, planLabel: quota.plan } };
            } catch (error) {
              return { type: "failed", error: error.message };
            }
          },
        },
        {
          type: "api", label: "官网账号与套餐 API Key",
          prompts: [
            { type: "password", key: "modelKey", message: "同一账号的套餐分组 API Key" },
            { type: "text", key: "email", message: "APIConnect 登录邮箱" },
            { type: "password", key: "password", message: "APIConnect 登录密码" },
            linePrompt,
          ],
          async authorize(inputs, { signal } = {}) {
            try {
              const key = inputs.modelKey?.trim();
              if (!key) throw new Error("请填写同一账号的套餐分组 API Key。");
              const line = lineName(inputs, key);
              const email = inputs.email?.trim();
              if (!email || !inputs.password) throw new Error("请填写 APIConnect 登录邮箱和密码。");
              const data = await request("/api/v1/auth/login", { body: { email, password: inputs.password }, signal });
              const tokens = session(data);
              const group = await lookupGroup(tokens.access, key, signal);
              const plans = await request("/api/v1/subscriptions/active", { bearer: tokens.access, signal });
              const plan = Array.isArray(plans) && plans.find(row => row && groupIds(row).includes(group));
              if (!plan) {
                throw new Error("请填写此账号有效订阅分组里的 API Key。");
              }
              const planLabel = plan.group_names?.join(" / ") || plan.group?.name || "订阅";
              const listed = await listModels({ type: "api", key }, signal).catch(error => {
                if (signal?.aborted || error.signIn) throw error;
                return null;
              });
              const message = "已绑定订阅分组。" + catalogSummary(listed);
              await input?.client?.tui?.showToast?.({ body: { message, variant: "info" } });
              return { type: "success", ...tokens, modelKey: key, groupId: group, line, namedLine: !!inputs.line?.trim(), planLabel, accountId: line, modelCount: listed?.models.length };
            } catch (error) {
              return { type: "failed", error: error.message };
            }
          },
        },
      ],
      async refresh(auth) {
        try {
          const tokens = session(await request("/api/v1/auth/refresh", { body: { refresh_token: auth.refresh }, signal: AbortSignal.timeout(15000) }), auth.refresh);
          return { ...tokens, dashboardExpired: false };
        } catch (error) {
          if (error.status === 401) return { dashboardExpired: true, expires: 0 };
          throw error;
        }
      },
      async usage(getAuth, _provider, { signal } = {}) {
        try {
          return await readQuota(await getAuth(), signal);
        } catch (error) {
          return { error: error.message, ...(error.signIn ? { signIn: error.signIn } : {}) };
        }
      },
    },
  };
}
