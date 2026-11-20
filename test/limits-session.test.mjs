import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.mjs";

const hooks = await plugin();
const key = { type: "api", key: "fixture" };
const dashboard = { type: "oauth", access: "session", refresh: "renew", modelKey: key.key };

test("a spent rolling window counts independently of a little-used total budget", async t => {
  const reset = "2099-01-01T10:00:00Z";
  t.mock.method(globalThis, "fetch", async () => Response.json({ quota: { used: 5, limit: 100 },
    rate_limits: [{ window: "5h", used: 5, limit: 5, reset_at: reset }, { window: "7d", limit: 40, remaining: 30 }] }));
  const quota = await hooks.auth.usage(async () => key);
  assert.deepEqual(quota.windows.filter(w => !w.aside).map(w => w.used), [5, 100, 25]);
  assert.equal(quota.windows[1].resetsAt, new Date(reset).toISOString());
});

test("expired plan and funded wallet have a single consistent source", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ subscription: { id: 1, expires_at: "2000-01-01" }, balance: 12 }));
  const quota = await hooks.auth.usage(async () => key);
  assert.equal(quota.plan, "钱包");
  assert.ok(quota.windows.some(w => w.display === "套餐已到期"));
  assert.ok(quota.windows.some(w => w.balance === 12));
  assert.ok(!quota.windows.some(w => w.name === "共享套餐"));
  assert.match(quota.windows.find(w => w.name === "接入诊断").display, /钱包/);
});

test("dashboard or refresh 401 preserves a working model key and its own budget", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/usage")) return Response.json({ balance: 4 });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "claude-fixture" }] });
    if (url.endsWith("/messages")) return Response.json({ ok: true });
    return new Response(null, { status: 401 });
  });
  const renewed = await hooks.auth.refresh(dashboard);
  assert.equal(renewed.expires, 0);
  for (const auth of [dashboard, { ...dashboard, ...renewed }]) {
    const q = await hooks.auth.usage(async () => auth);
    assert.notEqual(q.signIn, "expired");
    assert.ok(q.windows.some(w => w.name === "官网会话" && w.display.includes("过期")));
    assert.ok(q.windows.some(w => w.balance === 4));
    assert.ok((await hooks.provider.models({}, { auth }))["claude-fixture"]);
    const loader = await hooks.auth.loader(async () => auth);
    assert.ok((await loader.fetch("https://apiconnect.lol/v1/messages", { method: "POST" })).ok);
  }
});

test("empty vendor list and unsupported catalog give different login instructions", async t => {
  const data = [];
  const notices = [];
  const p = await plugin({ client: { tui: { showToast: async ({ body }) => notices.push(body.message) } } });
  t.mock.method(globalThis, "fetch", async url => Response.json(url.endsWith("/models") ? { data } : { balance: 1 }));
  for (const expected of [/空列表/, /兼容 0 个/]) {
    const result = await p.auth.methods[0].authorize({ subscriptionKey: key.key });
    assert.equal(result.type, "success");
    assert.match(notices.at(-1), expected);
    assert.doesNotMatch(notices.at(-1), /勾选/);
    data.push({ id: "chat-only", supported_endpoint_types: ["chat_completions"] });
  }
});
