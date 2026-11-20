import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.mjs";

const hooks = await plugin();
const auth = { type: "api", key: "example-only" };
const catalog = { data: [{ id: "claude-a" }, { id: "chat-only", supported_endpoint_types: ["chat_completions"] }] };

test("doctor reads only catalog and usage, distinguishes both counts and never reports the key", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    calls.push([new URL(url).pathname, opts.method]);
    return Response.json(url.endsWith("/models") ? catalog : { balance: 4 });
  });
  const q = await hooks.auth.usage(async () => auth);
  const text = q.windows.find(w => w.name === "线路自检").display;
  assert.match(text, /模型 Key 有效.*上游 2 个.*兼容 1 个.*官网会话未绑定.*额度来源：钱包/);
  assert.ok(!text.includes(auth.key));
  assert.deepEqual(calls.sort(), [["/v1/models", "GET"], ["/v1/usage", "GET"]]);
});

test("catalog and usage failures have separate effects on model sign-in", async t => {
  let modelsStatus = 200;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/models")) return Response.json(catalog, { status: modelsStatus });
    return new Response("", { status: 401 });
  });
  for (const [status, expected, keyState] of [[200, undefined, "有效"], [401, "expired", "已失效"], [503, "kept", "暂未核实"]]) {
    modelsStatus = status;
    const q = await hooks.auth.usage(async () => auth);
    assert.equal(q.signIn, expected);
    assert.ok(q.windows.find(w => w.name === "线路自检").display.includes("模型 Key " + keyState));
  }
});

test("a genuine model-key rejection does not start a dashboard renewal", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { type: "authentication_error" } }, { status: 401 }));
  const loader = await hooks.auth.loader(async () => ({ type: "oauth", modelKey: auth.key, access: "separate-dashboard" }));
  const res = await loader.fetch("https://apiconnect.lol/v1/messages", { method: "POST" });
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
});
