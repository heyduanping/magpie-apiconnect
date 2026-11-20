import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.mjs";

const hooks = await plugin();
const key = "test-only-key";
const dashboard = { type: "oauth", access: "example-access", modelKey: key };
const accountMethod = hooks.auth.methods.find(m => m.prompts.some(p => p.key === "email"));
const keyMethod = hooks.auth.methods.find(m => m !== accountMethod);
const plan = (id, used) => ({ group_id: id, group: { name: "Plan " + id, weekly_limit_usd: 100 }, weekly_usage_usd: used });
const groupKeys = { items: [{ key, status: "active", group_id: 1 }], total: 1 };
const login = { access_token: "example-access", refresh_token: "example-refresh", expires_in: 3600 };
const dashboardInputs = { modelKey: key, email: "demo@example.invalid", password: "example-password" };

function fixture(t, routes) {
  t.mock.method(globalThis, "fetch", async url => {
    const { pathname } = new URL(url);
    assert.ok(Object.hasOwn(routes, pathname), "unexpected fixture request " + pathname);
    const value = routes[pathname];
    if (value instanceof Response) return value.clone();
    return Response.json(pathname.startsWith("/api/") ? { code: 0, data: value } : value);
  });
}

test("dashboard login binds the verified active group", async t => {
  fixture(t, { "/api/v1/auth/login": login, "/api/v1/keys": groupKeys, "/api/v1/subscriptions/active": [plan(1, 20)], "/v1/models": { data: [{ id: "claude-example" }] } });
  const result = await accountMethod.authorize(dashboardInputs);
  assert.equal(result.type, "success");
  assert.equal(result.groupId, "1");
  assert.equal(result.modelCount, 1);
  assert.ok(!Object.values(result).includes(dashboardInputs.password));
});

test("legacy account resolves its key group and isolates unrelated or partial quotas", async t => {
  fixture(t, {
    "/api/v1/keys": groupKeys, "/api/v1/auth/me": { balance: 12 },
    "/api/v1/subscriptions": [plan(1, 20), plan(2, 100), plan(3, null)],
  });
  const q = await hooks.auth.usage(async () => dashboard);
  assert.deepEqual(q.windows.filter(w => !w.aside).map(w => w.used), [20]);
  assert.ok(q.windows.some(w => w.used === 100 && w.aside));
  assert.ok(q.windows.some(w => w.display?.includes("本次未取得")));
  assert.ok(q.windows.some(w => w.display === "$12.00"));
  assert.ok(q.windows.some(w => w.used === 20 && w.display.includes("$100") && w.limit === undefined));
});

test("unverified group leaves amounts visible without assigning them to this key", async t => {
  fixture(t, { "/api/v1/keys": new Response("", { status: 503 }), "/api/v1/auth/me": { balance: 12 },
    "/api/v1/subscriptions": [plan(1, 20), plan(2, 100)] });
  const q = await hooks.auth.usage(async () => dashboard);
  assert.ok(q.windows.every(w => w.aside));
  assert.ok(q.windows.some(w => w.display.includes("分组暂未核实")));
  assert.ok(q.windows.some(w => w.balance === 12));
});

test("refresh preserves the previous renewal token if upstream omits a new one", async t => {
  fixture(t, { "/api/v1/auth/refresh": { access_token: "next-access", expires_in: 300 } });
  const r = await hooks.auth.refresh({ refresh: "first-renewal" });
  assert.equal(r.refresh, "first-renewal");
  assert.equal(r.access, "next-access");
});

test("two-factor guidance points to a usable key", async t => {
  fixture(t, { "/api/v1/auth/login": { requires_2fa: true } });
  assert.match((await accountMethod.authorize(dashboardInputs)).error, /二次验证/);
});

test("invalid key is reported before missing subscription", async t => {
  fixture(t, { "/v1/models": { data: [{ id: "claude-example" }] }, "/v1/usage": { isValid: false } });
  const result = await keyMethod.authorize({ subscriptionKey: key });
  assert.equal(result.type, "failed");
  assert.match(result.error, /失效/);
});
