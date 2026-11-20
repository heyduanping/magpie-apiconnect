import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const [bun, host, packageDirectory] = process.argv.slice(2);
if (!bun || !host) throw new Error("Usage: node scripts/host-smoke.mjs <Magpie Bun executable> <Magpie host.js>");
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "apiconnect-smoke-"));
const authPath = path.join(root, "fixture-auth.json");
const localHost = path.join(root, "host.js");
fs.copyFileSync(host, localHost);
const proc = spawn(bun, ["--preload", path.join(repo, "scripts/demo-upstream.mjs"), localHost], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
let sequence = 0;
const pending = new Map();
const chunks = [];
readline.createInterface({ input: proc.stdout }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.event === "chunk") chunks.push(Buffer.from(msg.data, "base64"));
  if (msg.event || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message));
  else resolve(msg.result);
});
const exited = new Promise(resolve => proc.on("close", code => {
  for (const entry of pending.values()) entry.reject(new Error("Host exited " + code));
  resolve();
}));
function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
const timer = setTimeout(() => proc.kill(), 25000);
const provider = "apiconnect";
async function login(method, inputs) {
  const r = await rpc("apiKey", { provider, method, inputs });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.account;
}
try {
  const init = await rpc("init", { directory: root, authPath, plugins: [{ spec: "fixture-local", target: packageDirectory ?? repo }] });
  assert.ok(!init.plugins[0].error, init.plugins[0].error);
  const daily = await login(1, { modelKey: "daily-fixture", email: "demo@example.invalid", password: "fixture-only", line: "daily" });
  const backup = await login(0, { subscriptionKey: "backup-fixture", line: "backup" });
  assert.notEqual(daily, backup);
  assert.equal(await login(0, { subscriptionKey: "replacement-fixture", line: "backup" }), backup);
  const accounts = JSON.parse(fs.readFileSync(authPath));
  assert.equal(Object.keys(accounts).length, 2);
  assert.equal(accounts[daily].modelKey, "daily-fixture");
  assert.equal(accounts[backup].key, "replacement-fixture");
  const [row] = await rpc("providers", {});
  const alias = row.models.find(m => m.name.includes("backup") && m.apiId === "claude-haiku-4-5");
  assert.ok(alias);
  assert.ok(row.accounts.find(a => a.key === backup).models.includes(alias.id));
  assert.ok(!row.accounts.find(a => a.key === daily).models.includes(alias.id));
  const cards = await Promise.all([daily, backup].map(account => rpc("usage", { provider, account })));
  const shared = cards.map(card => card.windows.find(w => w.name === "共享套餐").display);
  assert.equal(shared[0], shared[1]);
  assert.ok(cards[0].windows.some(w => w.balance === 12.5));
  const body = JSON.stringify({ model: alias.apiId, messages: [{ role: "user", content: "Hi" }], max_tokens: 8 });
  await rpc("fetch", { provider, account: backup, model: alias.id, npm: alias.npm, url: "https://apiconnect.lol/v1/messages", method: "POST", body: Buffer.from(body).toString("base64") });
  const reply = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(reply.content[0].text, "OK");
  assert.equal(reply.id, "fixture-message-replacement-fixture");
  console.log("PASS  two sign-ins, isolated models, named key rotation, shared quota, wallet, model response");
} finally {
  clearTimeout(timer);
  proc.stdin.end();
  await exited;
  fs.rmSync(root, { recursive: true, force: true });
}
