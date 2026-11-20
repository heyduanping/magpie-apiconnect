import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.mjs";

const hooks = await plugin();
const auth = { type: "api", key: "demo-key" };

for (const [name, value, expected] of [
  ["wallet", { balance: 0 }, "钱包"],
  ["key budget", { quota: { limit: 3, used: 1 } }, "Key 额度"],
  ["no details", { remaining: 100 }, "无订阅明细"],
  ["usage service unavailable", new Response("", { status: 503 }), "额度暂不可查"],
]) {
  test("scoped key login and diagnostics: " + name, async t => {
    t.mock.method(globalThis, "fetch", async url => {
      if (new URL(url).pathname === "/v1/models") return Response.json({ data: [{ id: "claude-example" }] });
      return value instanceof Response ? value.clone() : Response.json(value);
    });
    const r = await hooks.auth.methods[0].authorize({ subscriptionKey: auth.key });
    assert.equal(r.type, "success");
    assert.equal(r.metadata.modelCount, 1);
    const q = await hooks.auth.usage(async () => ({ ...auth, metadata: r.metadata }));
    assert.equal(q.plan, expected);
    assert.ok(!q.windows.at(-1).display.includes(auth.key));
    if (name === "wallet") assert.equal(q.windows[0].balance, 0);
  });
}

test("model failure preserves retry timing and omits upstream secrets", async t => {
  t.mock.method(globalThis, "fetch", () => Response.json({ error: { message: auth.key } }, { status: 429, headers: { "retry-after": "5" } }));
  const loader = await hooks.auth.loader(async () => auth);
  const res = await loader.fetch("https://apiconnect.lol/v1/messages", { method: "POST" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "5");
  const body = await res.text();
  assert.match(body, /限流/);
  assert.ok(!body.includes(auth.key));
});
