#!/usr/bin/env node
/**
 * doctor.mjs — preflight diagnostic for workbuddy-siyuan-mcp.
 *
 * Run this FIRST whenever the connector stops loading in WorkBuddy, and after any
 * macOS migration or Node upgrade:
 *
 *     node doctor.mjs
 *
 * Why this exists: this connector is pure JavaScript and has no native code, so it
 * runs identically on Intel and Apple Silicon. What breaks is the *Node that launches
 * it*. WorkBuddy spawns MCP stdio servers using `CODEBUDDY_NODE_BIN` (falling back to
 * whatever `node` resolves to on PATH). After migrating from an Intel Mac to an Apple
 * Silicon Mac, that binary can still be an x86_64 build — and with no Rosetta 2
 * installed, it fails with "Bad CPU type in executable" *before the server ever
 * starts*. That is a silent failure from WorkBuddy's side: the connector just never
 * appears. This script tells you which of those it is.
 *
 * Exit code 0 = usable, 1 = at least one hard failure.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN_NODE = [18, 17, 0];

const rows = [];
const pass = (label, detail = "") => rows.push({ s: "PASS", label, detail });
const warn = (label, detail = "") => rows.push({ s: "WARN", label, detail });
const fail = (label, detail = "") => rows.push({ s: "FAIL", label, detail });
const info = (label, detail = "") => rows.push({ s: "INFO", label, detail });

/** Run a command, returning trimmed stdout or null on any failure. */
function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Best-effort architecture of a binary via macOS `file(1)`. */
function binaryArch(path) {
  const out = sh("/usr/bin/file", ["-b", path]);
  if (!out) return null;
  for (const a of ["arm64", "x86_64"]) {
    if (out.includes(a)) return a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The runtime this script is executing under
// ---------------------------------------------------------------------------
const [maj, min, pat] = process.versions.node.split(".").map(Number);
if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && (min > MIN_NODE[1] || (min === MIN_NODE[1] && pat >= MIN_NODE[2])))) {
  pass("Node version", `v${process.versions.node} (needs >= ${MIN_NODE.join(".")})`);
} else {
  fail("Node version", `v${process.versions.node} is below the required ${MIN_NODE.join(".")}`);
}
info("Running as", `node ${process.execPath}`);
info("process.arch", `${process.arch}  (platform ${process.platform})`);

// ---------------------------------------------------------------------------
// 2. Architecture sanity: is this Node native to this machine?
// ---------------------------------------------------------------------------
const machineArch = sh("/usr/bin/uname", ["-m"]);
const translated = sh("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"]) === "1";
const appleSilicon = sh("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]) === "1";

if (!machineArch) {
  warn("Machine architecture", "could not determine (uname unavailable)");
} else {
  info("Machine architecture", machineArch);
}

if (machineArch === "arm64" && process.arch === "x64") {
  if (translated) {
    warn(
      "Node architecture",
      "Intel build running under Rosetta 2 on Apple Silicon. It works, but is slower " +
        "and one macOS update away from breaking. Prefer a native arm64 Node."
    );
  } else {
    fail(
      "Node architecture",
      "Intel Node on Apple Silicon with NO Rosetta 2. This process should not have " +
        "started at all -- if WorkBuddy reports the connector as missing, this is why."
    );
  }
} else if (machineArch === "arm64" && process.arch === "arm64") {
  pass("Node architecture", "native arm64 on arm64 hardware");
} else if (machineArch && process.arch === "x64") {
  pass("Node architecture", `x64 on ${machineArch} hardware`);
} else {
  info("Node architecture", `${process.arch} on ${machineArch ?? "unknown"}`);
}

if (appleSilicon && !translated && process.arch === "x64") {
  warn("Rosetta 2", "not installed -- x86_64 binaries cannot execute on this machine");
}

// ---------------------------------------------------------------------------
// 3. The Node WorkBuddy will actually spawn (this is the one that matters)
// ---------------------------------------------------------------------------
const nodeBin = process.env.CODEBUDDY_NODE_BIN;
if (!nodeBin) {
  warn(
    "CODEBUDDY_NODE_BIN",
    "not set in this shell. WorkBuddy sets it when it spawns the server; run this " +
      "script from inside WorkBuddy, or set it manually, to test the real binary."
  );
} else if (!existsSync(nodeBin)) {
  fail("CODEBUDDY_NODE_BIN", `${nodeBin} does not exist`);
} else {
  const arch = binaryArch(nodeBin);
  if (!arch) {
    warn("CODEBUDDY_NODE_BIN", `${nodeBin} (could not read architecture)`);
  } else if (machineArch === "arm64" && arch === "x86_64") {
    fail(
      "CODEBUDDY_NODE_BIN",
      `${nodeBin} is x86_64 on arm64 hardware. WorkBuddy will fail to spawn the ` +
        `connector. Point the server's "command" at a universal/native Node instead, ` +
        `e.g. /usr/local/bin/node, or reinstall WorkBuddy's arm64 runtimes.`
    );
  } else {
    pass("CODEBUDDY_NODE_BIN", `${nodeBin} (${arch})`);
  }
}

// ---------------------------------------------------------------------------
// 4. WorkBuddy's mcp.json entry
// ---------------------------------------------------------------------------
const mcpPath = join(homedir(), ".workbuddy-ai", "mcp.json");
if (!existsSync(mcpPath)) {
  warn("mcp.json", `not found at ${mcpPath}`);
} else {
  try {
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8"));
    const entry = cfg?.mcpServers?.siyuan;
    if (!entry) {
      fail("mcp.json", `no "siyuan" server registered in ${mcpPath}`);
    } else {
      const cmd = entry.command ?? "";
      if (cmd === "node") {
        warn(
          "mcp.json command",
          `"node" resolves via PATH and may hit the wrong binary after a machine ` +
            `migration. Prefer an absolute path such as /usr/local/bin/node.`
        );
      } else if (cmd.startsWith("/")) {
        if (!existsSync(cmd)) {
          fail("mcp.json command", `${cmd} does not exist`);
        } else {
          const arch = binaryArch(cmd);
          if (machineArch === "arm64" && arch === "x86_64") {
            fail("mcp.json command", `${cmd} is x86_64 on arm64 hardware`);
          } else {
            pass("mcp.json command", `${cmd}${arch ? ` (${arch})` : ""}`);
          }
        }
      } else {
        info("mcp.json command", cmd);
      }

      const args = entry.args ?? [];
      const entryPoint = args.find((a) => a.endsWith(".js"));
      if (!entryPoint) {
        fail("mcp.json args", "no dist/index.js entry point in args");
      } else if (!existsSync(entryPoint)) {
        fail("mcp.json args", `${entryPoint} does not exist -- run: npm run build`);
      } else {
        pass("mcp.json args", entryPoint);
      }
    }
  } catch (e) {
    fail("mcp.json", `could not parse ${mcpPath}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Credentials and connectivity
// ---------------------------------------------------------------------------
const url = process.env.SIYUAN_API_URL;
const token = process.env.SIYUAN_API_TOKEN;

if (!url || !token) {
  fail(
    "Environment",
    "SIYUAN_API_URL and/or SIYUAN_API_TOKEN are not set. They belong in this " +
      "server's env block in mcp.json."
  );
} else {
  pass("Environment", `${url} (token present, ${token.length} chars)`);

  const call = async (endpoint, body = {}) => {
    const res = await fetch(new URL(endpoint, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return res.json();
  };

  try {
    const ver = await call("/api/system/version");
    if (ver.code === 0) pass("SiYuan reachable", `kernel v${ver.data}`);
    else fail("SiYuan reachable", `HTTP ok but code ${ver.code}: ${ver.msg}`);
  } catch (e) {
    fail("SiYuan reachable", `${url} did not answer: ${e.message}`);
  }

  try {
    const nb = await call("/api/notebook/lsNotebooks");
    if (nb.code === 0) {
      const list = nb.data?.notebooks ?? [];
      pass("Authentication", `${list.length} notebooks visible`);
      const names = list.map((n) => n.name);
      for (const want of ["00_ops", "01_raw", "02_wiki"]) {
        if (names.includes(want)) info("Notebook", `${want} present`);
        else warn("Notebook", `${want} not visible -- is it closed or renamed?`);
      }
    } else {
      fail("Authentication", `token rejected: code ${nb.code} ${nb.msg}`);
    }
  } catch (e) {
    fail("Authentication", `could not list notebooks: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
console.log("\nworkbuddy-siyuan-mcp -- doctor\n" + "=".repeat(64));
for (const r of rows) {
  console.log(`${pad(r.s, 5)} ${pad(r.label, 24)} ${r.detail}`);
}
const failures = rows.filter((r) => r.s === "FAIL").length;
const warnings = rows.filter((r) => r.s === "WARN").length;
console.log("=".repeat(64));
console.log(
  failures
    ? `${failures} failure(s), ${warnings} warning(s) -- connector is NOT usable as configured.`
    : warnings
      ? `No failures, ${warnings} warning(s) -- connector should work.`
      : "All checks passed."
);
console.log(
  "\nNote: this connector contains no native code. The same dist/ runs unchanged on\n" +
    "Intel and Apple Silicon -- only the Node that launches it is architecture-specific.\n"
);
process.exit(failures ? 1 : 0);
