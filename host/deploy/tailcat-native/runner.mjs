#!/usr/bin/env node
// Native launcher for rokbot-tailcat serve mode (replaces the in-container child that Host spawns).
// Deployment notes: see README.md in this directory (host/deploy/tailcat-native/).
// TAILCAT_DIR, TAILCAT_STATE, TAILCAT_BINARY, TAILCAT_TARGET and TAILCAT_PORT are set by the
// generated launchd plist (templates/dev.rokbot.tailcat.plist.tmpl); defaults below are only fallbacks.
// - Config/identity come from $TAILCAT_DIR/state/tailcat.json (same format as Host /data/tailcat.json).
// - Secrets are written to the helper over stdin only; stdout lines carrying the identity are never logged.
// - Only whitelisted, key-free diagnostic lines (endpoints / netcheck) reach the log.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.TAILCAT_DIR || new URL(".", import.meta.url).pathname;
const stateDir = join(dir, process.env.TAILCAT_STATE || "state");
const configFile = join(stateDir, "tailcat.json");
const binary = process.env.TAILCAT_BINARY || join(dir, "bin/rokbot-tailcat");
const target = process.env.TAILCAT_TARGET || "127.0.0.1:18080";
const port = Number(process.env.TAILCAT_PORT || 8000);
const log = msg => process.stderr.write(`${new Date().toISOString()} [runner] ${msg}\n`);
const writePrivate = (file, text) => { const tmp = `${file}.tmp-${process.pid}`; writeFileSync(tmp, text, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file); };
const redact = s => s.replace(/(nodekey|discokey|privkey|nlpub|tc)[:A-Za-z0-9_-]{20,}/g, "$1:<redacted>").replace(/[A-Za-z0-9+\/_-]{40,}/g, "<redacted>");

const stored = JSON.parse(readFileSync(configFile, "utf8"));
if (stored.enabled === false && process.env.TAILCAT_IGNORE_DISABLED !== "1") { log("state file says enabled=false (rolled back); refusing to start"); process.exit(0); } // exit 0: launchd KeepAlive(SuccessfulExit=false) will not respawn
const config = { mode: "serve", target, port, identity: stored.identity ?? undefined, derpMapURL: stored.derpMapURL || "", relay: stored.relay || "" };

const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ROKBOT_TAILCAT_DEBUG: "1" } });
log(`started helper pid=${child.pid} target=${target} port=${port} relay=${config.relay || "(derp map)"}`);
child.stdin.write(JSON.stringify(config) + "\n"); // stdin stays open: helper exits when it closes
let last = "", endpoints = [], netcheck = "", lastNetcheck = "", stopping = false;
const writeStatus = status => {
  const out = { pid: child.pid, updatedAt: new Date().toISOString(), state: status.state, path: status.path, listening: status.listening,
    accepted: status.accepted, forwarded: status.forwarded, error: status.error || "", publicKey: status.publicKey, endpoints, netcheck };
  writePrivate(join(stateDir, "status.json"), JSON.stringify(out, null, 1) + "\n");
  const summary = `${status.state}/${status.listening ? "listening" : "not-listening"}${status.error ? " error=" + status.error : ""}`;
  if (summary !== last) { log(`status ${summary}`); last = summary; }
};
createInterface({ input: child.stdout }).on("line", line => {
  let value; try { value = JSON.parse(line); } catch { log("helper printed non-JSON output (suppressed)"); return; }
  if (value.error) { log(`helper error: ${redact(String(value.error))}`); return; }
  if (value.ready) {
    const before = JSON.stringify(stored.identity ?? null), after = JSON.stringify(value.identity ?? null);
    if (before !== after) { stored.identity = value.identity; writePrivate(configFile, JSON.stringify(stored)); log(`identity ${before === "null" ? "created" : "public info updated"} and saved (contents not logged)`); }
    else log("identity unchanged");
    if (value.status?.link) writePrivate(join(stateDir, "link"), value.status.link + "\n");
  }
  if (value.status) writeStatus(value.status);
});
// Helper debug output: only key-free endpoint/netcheck lines are kept.
createInterface({ input: child.stderr }).on("line", line => {
  let m;
  if ((m = line.match(/endpoints changed: (.*)$/))) { endpoints = m[1].split(/,\s*/).map(s => s.trim()).filter(Boolean); log(`endpoints ${redact(m[1])}`); }
  else if ((m = line.match(/netcheck: (?:\[v\d\] )?report: (.*)$/))) { netcheck = redact(m[1]).slice(0, 600); const key = netcheck.replace(/ derpdist=\S*/, ""); if (key !== lastNetcheck) { lastNetcheck = key; log(`netcheck ${netcheck}`); } }
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopping = true; log(`${sig}: stopping helper`); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); });
child.on("exit", (code, signal) => { log(`helper exited code=${code} signal=${signal}`); process.exit(stopping ? 0 : 1); }); // unexpected helper exit => non-zero => launchd restarts
