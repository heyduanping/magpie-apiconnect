const provider = "apiconnect";
const modelBase = "https://apiconnect.lol/v1";
const anthropic = "@ai-sdk/anthropic";
const site = "https://apiconnect.lol";
const day = 86400000;

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
    const hint = { 401: subject + "无效，请重新验证。", 403: "当前凭据无权访问，请检查分组和权限。", 429: "请求过于频繁，请稍后重试。" };
    const error = new Error("APIConnect HTTP " + status + "，" + (hint[status] || "服务暂不可用，请稍后重试。"));
    if (response.status === 401) error.signIn = "expired";
    throw error;
  }
  const payload = await response.json().catch(() => { throw new Error("APIConnect 未返回 JSON 数据。"); });
  if (path.startsWith("/api/")) {
    if (payload?.code !== 0) throw new Error("APIConnect 未接受这次请求，请检查登录状态。");
    return payload.data;
  }
  return payload;
}

function session(data) {
  if (data?.requires_2fa) throw new Error("该账号启用了二次验证。请在官网「我的订阅 → 查看可使用套餐的 Key」选择可直接查询订阅的 Key。");
  if (!data?.access_token || !data.refresh_token || !(data.expires_in > 0)) {
    throw new Error("APIConnect 未返回可续期的登录信息。");
  }
  return { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 };
}

function groupIds(row) {
  return [row.group_id, row.group?.id, ...(Array.isArray(row.group_ids) ? row.group_ids : [])]
    .filter(id => typeof id === "string" && id.trim() || Number.isSafeInteger(id)).map(String);
}

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
      const limit = limits[period + "_limit_usd"];
      if (!Number.isFinite(limit) || limit <= 0) continue;
      const amount = row[period + "_usage_usd"];
      if (!Number.isFinite(amount) || amount < 0) {
        windows.push({ name: prefix + label, display: "本次未取得用量", aside: true });
        continue;
      }
      const window = { name: prefix + label, used: 100 * amount / limit, amount, limit, unit: "USD", aside };
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
  return result.data.filter(model => typeof model?.id === "string" && /^[\w.-]+$/.test(model.id));
}

async function lookupGroup(access, key, signal) {
  for (let page = 1; ; page++) {
    const result = await request("/api/v1/keys?page_size=100&page=" + page, { bearer: access, signal });
    const rows = result?.items;
    if (!Array.isArray(rows)) throw new Error("无法核对 API Key 的订阅分组。");
    const match = rows.find(row => row.key === key);
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
      !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
    throw new Error("APIConnect 仅接受本站的 Anthropic Messages 请求。");
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const name of ["authorization", "cookie", "proxy-authorization", "x-goog-api-key", "x-api-key"]) headers.delete(name);
  headers.set("x-api-key", modelKey(await getAuth()));
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  return fetch(input, { ...init, headers, redirect: "error" });
}

async function readQuota(auth, signal) {
  if (auth.type === "api") {
    const data = await request("/v1/usage", { bearer: auth.key, signal });
    if (data?.isValid === false || Date.parse(data?.subscription?.expires_at) <= Date.now()) {
      throw new Error("APIConnect 报告套餐或 Key 已失效。");
    }
    if (!data?.subscription) throw new Error("此 Key 无订阅明细。请从官网「我的订阅 → 查看可使用套餐的 Key」选择能直接查询订阅的 Key。");
    return subscriptionUsage([data.subscription], data.planName);
  }
  const opts = { bearer: auth.access, signal };
  const [rows, user, group] = await Promise.all([
    request("/api/v1/subscriptions", opts),
    request("/api/v1/auth/me", opts).catch(() => null),
    lookupGroup(auth.access, modelKey(auth), signal),
  ]);
  if (!Array.isArray(rows)) throw new Error("APIConnect 的订阅列表格式已变化。");
  const active = rows.filter(row => row && (!row.status || row.status === "active") && !(Date.parse(row.expires_at) <= Date.now()));
  const quota = subscriptionUsage(active, "APIConnect", group);
  if (!active.some(row => groupIds(row).includes(group))) quota.windows.unshift({ name: "当前分组", display: "暂无有效订阅", aside: true });
  if (Number.isFinite(user?.balance)) {
    quota.windows.push({ name: "钱包余额", display: "$" + user.balance.toFixed(2), aside: true });
  }
  return quota;
}

export default async function apiConnectProvider() {
  return {
    config(config) {
      config.provider ??= {};
      config.provider[provider] = { name: "APIConnect", api: modelBase, npm: anthropic, models: {} };
    },
    provider: {
      id: provider,
      async models(info, { auth, signal } = {}) {
        if (!auth) return {};
        const models = await listModels(auth, signal);
        return Object.fromEntries(models.map(({ id, display_name }) => [id, {
          ...info.models?.[id], id, name: display_name || info.models?.[id]?.name || id,
          api: { id, url: modelBase, npm: anthropic },
        }]));
      },
    },
    auth: {
      async loader(getAuth) {
        return { baseURL: modelBase, apiKey: "unused", fetch: (input, init) => sendModel(input, init, getAuth) };
      },
      provider,
      single: true,
      methods: [
        {
          type: "api", label: "官网账号与套餐 API Key",
          prompts: [
            { type: "password", key: "modelKey", message: "同一账号的套餐分组 API Key" },
            { type: "text", key: "email", message: "APIConnect 登录邮箱" },
            { type: "password", key: "password", message: "APIConnect 登录密码" },
          ],
          async authorize(inputs, { signal } = {}) {
            try {
              const key = inputs.modelKey?.trim();
              if (!key) throw new Error("请填写同一账号的套餐分组 API Key。");
              const email = inputs.email?.trim();
              if (!email || !inputs.password) throw new Error("请填写 APIConnect 登录邮箱和密码。");
              const data = await request("/api/v1/auth/login", { body: { email, password: inputs.password }, signal });
              const tokens = session(data);
              const group = await lookupGroup(tokens.access, key, signal);
              const plans = await request("/api/v1/subscriptions/active", { bearer: tokens.access, signal });
              if (!Array.isArray(plans) || !plans.some(row => row && groupIds(row).includes(group))) {
                throw new Error("请填写此账号有效订阅分组里的 API Key。");
              }
              return { type: "success", ...tokens, modelKey: key, groupId: group, accountId: data.user?.email || email };
            } catch (error) {
              return { type: "failed", error: error.message };
            }
          },
        },
        {
          type: "api", label: "套餐 Key（仅适用能查询订阅的 Key）",
          prompts: [{ type: "password", key: "subscriptionKey", message: "APIConnect 套餐 Key" }],
          async authorize(inputs, { signal } = {}) {
            try {
              const key = inputs.subscriptionKey?.trim();
              if (!key) throw new Error("请填写套餐 Key。");
              await readQuota({ type: "api", key }, signal);
              return { type: "success", key, metadata: { email: "APIConnect 套餐" } };
            } catch (error) {
              return { type: "failed", error: error.message };
            }
          },
        },
      ],
      async refresh(auth) {
        return session(await request("/api/v1/auth/refresh", { body: { refresh_token: auth.refresh } }));
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
