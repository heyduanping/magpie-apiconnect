import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.mjs";

const hooks = await plugin();
const auth = { type: "api", key: "demo-only" };

test("only compatible advertised models appear, named copies keep the vendor model ID", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "responses-only", supported_endpoint_types: ["responses"] },
    { id: "both", supported_endpoint_types: ["messages", "responses"] },
    { id: "chat-only", supported_endpoint_types: ["chat_completions"] },
    { id: "claude-legacy" }, { id: "unspecified" },
  ] }));
  const list = await hooks.provider.models({}, { auth });
  assert.deepEqual(Object.keys(list), ["responses-only", "both", "claude-legacy"]);
  assert.equal(list["responses-only"].api.npm, "@ai-sdk/openai");
  assert.deepEqual(list.both.also, ["@ai-sdk/openai"]);
  const named = await hooks.provider.models({}, { auth: { ...auth, metadata: { line: "backup", namedLine: true, planLabel: "Demo" } } });
  const alias = Object.values(named).find(m => m.id !== m.api.id && m.api.id === "both");
  assert.equal(alias.name, "both · backup · Demo");
});

test("selects the right upstream credential header and streams the response unchanged", async t => {
  let seen;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    seen = init.headers;
    return new Response("data: demo\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const loader = await hooks.auth.loader(async () => auth);
  for (const endpoint of ["messages", "messages/count_tokens", "responses"]) {
    const r = await loader.fetch("https://apiconnect.lol/v1/" + endpoint, { method: "POST", headers: { authorization: "from-client", "x-api-key": "from-client" } });
    assert.equal(await r.text(), "data: demo\n\n");
    assert.equal(seen.get("authorization"), endpoint === "responses" ? "Bearer demo-only" : null);
    assert.equal(seen.get("x-api-key"), endpoint === "responses" ? null : auth.key);
  }
});

test("automatic names are stable per key and distinct between keys", async t => {
  t.mock.method(globalThis, "fetch", async url => Response.json(url.endsWith("/models") ? { data: [] } : { balance: 4 }));
  const login = async key => (await hooks.auth.methods[0].authorize({ subscriptionKey: key })).metadata;
  const a = await login("first-fixture");
  assert.equal(a.namedLine, false);
  assert.equal(a.email, (await login("first-fixture")).email);
  assert.notEqual(a.email, (await login("second-fixture")).email);
});
