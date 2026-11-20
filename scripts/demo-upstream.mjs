// Offline vendor responses for the integration test and the README screenshots.
const plan = {
  id: 42, group_id: 7, group_names: ["Demo Pro"], group: { id: 7, name: "Demo Pro", weekly_limit_usd: 100, monthly_limit_usd: 300 },
  weekly_usage_usd: 20, monthly_usage_usd: 65, status: "active", expires_at: "2099-12-01T00:00:00Z",
};
const demoModel = { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", supported_endpoint_types: ["messages", "responses"] };
const routes = {
  "/api/v1/auth/login": { access_token: "fixture-access", refresh_token: "fixture-renew", expires_in: 86400 },
  "/api/v1/auth/refresh": { access_token: "fixture-access", refresh_token: "fixture-renew", expires_in: 86400 },
  "/api/v1/keys": { items: ["daily-fixture", "backup-fixture", "replacement-fixture"].map(key => ({ key, status: "active", group_id: 7 })), total: 3 },
  "/api/v1/subscriptions/active": [plan], "/api/v1/subscriptions": [plan], "/api/v1/auth/me": { balance: 12.50 },
  "/v1/models": { data: [demoModel, { ...demoModel, id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }] },
  "/v1/usage": { isValid: true, planName: "Demo Pro", subscription: plan },
};
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url instanceof Request ? url.url : url);
  if (target.origin !== "https://apiconnect.lol") throw new Error("Offline fixture");
  const endpoint = target.pathname;
  if (endpoint === "/v1/messages" || endpoint === "/v1/responses") {
    const headers = new Headers(init.headers);
    const key = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "");
    if (!routes["/api/v1/keys"].items.some(k => k.key === key)) return new Response("Unknown fixture key", { status: 401 });
    const body = JSON.parse(init.body);
    if (!routes["/v1/models"].data.some(model => model.id === body.model)) return new Response("Unknown model", { status: 404 });
    if (endpoint === "/v1/responses") return Response.json({ id: "fixture-response", object: "response",
      status: "completed", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] });
    return Response.json({ id: "fixture-message-" + key, type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (endpoint === "/v1/messages/count_tokens") return Response.json({ input_tokens: 1 });
  if (!Object.hasOwn(routes, endpoint)) throw new Error("Unknown fixture endpoint");
  return Response.json(endpoint.startsWith("/api/") ? { code: 0, data: routes[endpoint] } : routes[endpoint]);
};
