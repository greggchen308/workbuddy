import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve dist/index.js relative to this file so the smoke test runs anywhere (the VPS and a
// local checkout), instead of hardcoding one machine's absolute path.
const HERE = dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: "node",
  args: [join(HERE, "dist", "index.js")],
  env: { ...process.env },
});

const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(transport);

// ---------------------------------------------------------------------------
// Live-write gate — added 2026-09-24.
//
// A default run must leave the vault EXACTLY as it found it. The connector has no delete tool by
// design, so a happy-path siyuan_append_block cannot be undone: it appends a `---` thematic break
// PLUS a paragraph to the live WB Scratchpad doc (20260901140545-1vmnvz1), and accumulates stray
// blocks on every run. Five runs had left ten stray blocks (five paragraph + five thematic break)
// before this was fixed.
//
// So the happy-path append is OFF by default. Pass --live-write to run it, accepting that the run
// leaves residue only a human can remove in the SiYuan UI.
//
// Everything else in this file is either a read, or a refusal asserted against a guard that throws
// BEFORE any write reaches the kernel. The asset round trip below still runs by default: it removes
// the file it created in the same run via /api/file/removeFile, verified by SHA-256 and confirmed by
// re-listing /data/assets. That is the only delete this harness may make, and only on its own
// artifact.
// ---------------------------------------------------------------------------
const LIVE_WRITE = process.argv.includes("--live-write");
if (LIVE_WRITE) {
  console.log(
    "!! --live-write is ON. This run WILL append a block to the live WB Scratchpad doc " +
      "(20260901140545-1vmnvz1). The connector has no delete tool, so this script CANNOT remove it " +
      "afterwards — expect stray residue a human has to clean up by hand."
  );
} else {
  console.log("DEFAULT RUN: write-free. Happy-path append skipped (pass --live-write to exercise it).");
}

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const notebooks = await client.callTool({
  name: "siyuan_list_notebooks",
  arguments: {},
});
console.log("NOTEBOOKS RESULT:", JSON.stringify(notebooks).slice(0, 500));

const scratchpadRead = await client.callTool({
  name: "siyuan_get_block_kramdown",
  arguments: { id: "20260901140545-1vmnvz1" },
});
console.log("SCRATCHPAD READ:", JSON.stringify(scratchpadRead).slice(0, 500));

// Negative test: attempt a write outside scope, must be refused.
const blocked = await client.callTool({
  name: "siyuan_create_doc",
  arguments: {
    notebook: "20260429072933-078h2m9",
    path: "/Entity/Should Not Be Created",
    markdown: "# Should Not Be Created\n",
  },
});
console.log("BLOCKED-SCOPE RESULT:", JSON.stringify(blocked).slice(0, 500));

// Negative test: corruption-risk content, must be refused.
const corrupt = await client.callTool({
  name: "siyuan_append_block",
  arguments: {
    parentDocId: "20260901140545-1vmnvz1",
    markdown: 'See "card #113" and also #113 again in the same block.',
  },
});
console.log("BLOCKED-CORRUPTION RESULT:", JSON.stringify(corrupt).slice(0, 500));

// ---------------------------------------------------------------------------
// Guard-only write-path checks — added 2026-09-24, replacing the coverage lost by skipping the
// happy-path append. Every case below must be refused by a guard that throws BEFORE the kernel write
// call, so a default run writes nothing. Verified by the before/after block-list comparison in the
// run report, not just by reading the source.
// ---------------------------------------------------------------------------
const guardOnlyRefusals = [
  [
    "update_child_block on a doc root (F1)",
    { name: "siyuan_update_child_block", arguments: { blockId: "20260901140545-1vmnvz1", markdown: "# nope" } },
    "document ROOT",
  ],
  [
    "update_child_block heading with bare text (F6)",
    { name: "siyuan_update_child_block", arguments: { blockId: "20260901140545-2svruqu", markdown: "Updated heading" } },
    'no leading "#"',
  ],
  [
    "append_block to a non-document block",
    { name: "siyuan_append_block", arguments: { parentDocId: "20260901140545-f88rblh", markdown: "nope" } },
    "not a document root",
  ],
];
for (const [label, call, expect] of guardOnlyRefusals) {
  const r = await client.callTool(call);
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log(`GUARD-REFUSED (${label}): ${r.isError && text.includes(expect) ? "OK" : "UNEXPECTED"} — ${text.slice(0, 160)}`);
}

if (LIVE_WRITE) {
  const okAppend = await client.callTool({
    name: "siyuan_append_block",
    arguments: {
      parentDocId: "20260901140545-1vmnvz1",
      markdown: "---\n\n**Connector smoke test** — 2026-09-01 — verified read/write/scope/corruption guards end to end from workbuddy-siyuan-mcp.",
    },
  });
  console.log("OK-APPEND RESULT:", JSON.stringify(okAppend).slice(0, 400));
  console.log("OK-APPEND WARNING: that block is now stranded in WB Scratchpad — no delete tool exists.");
} else {
  console.log("OK-APPEND: SKIPPED — default run is write-free (pass --live-write to exercise the happy path).");
}

// ---------------------------------------------------------------------------
// siyuan_write_asset — added 2026-09-17.
//
// Regression cover for the putFile path. /api/asset/upload is a confirmed silent no-op on
// this deployment, so this tool wraps /api/file/putFile instead and refuses to trust code:0:
// every write is hash-verified by reading the file back. See SiYuan doc 20260917130056-wxxj67h.
// ---------------------------------------------------------------------------

// Negative tests — all must be refused, none of these writes anything.
const assetRefusals = [
  ["path traversal", { filename: "../evil.png", contentBase64: "AA==" }, "contains"],
  ["svg is excluded", { filename: "diagram.svg", contentBase64: "AA==" }, "not in this tool's allowed extension"],
  ["no extension", { filename: "noext", contentBase64: "AA==" }, "has no extension"],
  ["both inputs given", { filename: "x.png", contentBase64: "AA==", localPath: "/etc/hosts" }, "not both"],
];
for (const [label, args, expect] of assetRefusals) {
  const r = await client.callTool({ name: "siyuan_write_asset", arguments: args });
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log(`ASSET-REFUSED (${label}): ${r.isError && text.includes(expect) ? "OK" : "UNEXPECTED"} — ${text.slice(0, 160)}`);
}

// Positive round trip: a 74-byte 8x8 PNG. Cleans up after itself so the vault doesn't
// accumulate test assets (the connector deliberately exposes no delete tool).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=";
const testAsset = `zz-smoketest-${Date.now()}.png`;
const wrote = await client.callTool({
  name: "siyuan_write_asset",
  arguments: { filename: testAsset, contentBase64: TINY_PNG_B64 },
});
const wroteText = (wrote.content ?? []).map((c) => c.text ?? "").join("\n");
console.log("ASSET-WRITE RESULT:", wroteText.slice(0, 400));

// Verify independently of the tool's own claim, then clean up via a direct kernel call.
const ASSET_PATH = `/data/assets/${testAsset}`;
const readBack = await fetch(`${process.env.SIYUAN_API_URL}/api/file/getFile`, {
  method: "POST",
  headers: { Authorization: `Token ${process.env.SIYUAN_API_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ path: ASSET_PATH }),
}).then((r) => r.arrayBuffer());
const { createHash } = await import("node:crypto");
const sourceSha = createHash("sha256").update(Buffer.from(TINY_PNG_B64, "base64")).digest("hex");
const readBackSha = createHash("sha256").update(Buffer.from(readBack)).digest("hex");
console.log(`ASSET-INDEPENDENT-VERIFY: ${sourceSha === readBackSha ? "OK (hashes match)" : "MISMATCH — do not trust"}`);

const cleanup = await fetch(`${process.env.SIYUAN_API_URL}/api/file/removeFile`, {
  method: "POST",
  headers: { Authorization: `Token ${process.env.SIYUAN_API_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ path: ASSET_PATH }),
}).then((r) => r.json());
console.log(`ASSET-CLEANUP: ${cleanup.code === 0 ? "OK (test asset removed)" : JSON.stringify(cleanup)}`);

// ---------------------------------------------------------------------------
// siyuan_sql_query must flush the SQLite index before it queries — added 2026-09-25.
//
// Maintainer 88250 confirmed on siyuan-note/siyuan#19841 that SQL indexing is asynchronous for
// EVERY block-writing API, so /api/query/sql has to be preceded by POST
// /api/sqlite/flushTransaction. Measured on this instance 2026-09-25: immediately after a write,
// SQL saw append 9/30, update 6/20, delete-gone 5/10; after a flush, 30/30, 20/20, 10/10.
//
// This assertion is deterministic and can FAIL. It imports the compiled client IN-PROCESS and
// swaps globalThis.fetch for a recorder, so it observes the exact request sequence without
// touching the live vault. If the flush is dropped, reordered, or a flush failure is swallowed,
// the case prints FAIL and the script exits non-zero.
// ---------------------------------------------------------------------------
const FLUSH_EP = "/api/sqlite/flushTransaction";
const QUERY_EP = "/api/query/sql";
const realFetch = globalThis.fetch;
let flushAssertionsFailed = 0;

function stubFetch(seq, flushCode) {
  globalThis.fetch = async (url) => {
    const ep = new URL(String(url)).pathname;
    seq.push(ep);
    const body =
      ep === FLUSH_EP
        ? { code: flushCode, msg: flushCode === 0 ? "" : "stub flush failure", data: null }
        : { code: 0, msg: "", data: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const clientMod = await import(join(HERE, "dist", "siyuanClient.js"));

// Case 1 — the flush happens, and happens BEFORE the query.
{
  const seq = [];
  stubFetch(seq, 0);
  let err = "";
  try {
    await clientMod.sqlQuery("select 1");
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  globalThis.fetch = realFetch;
  const ok = seq.length === 2 && seq[0] === FLUSH_EP && seq[1] === QUERY_EP;
  if (!ok) flushAssertionsFailed++;
  console.log(
    `SQLQUERY-FLUSH-ORDER: ${ok ? "OK" : "FAIL"} — sequence ${JSON.stringify(seq)}, want ${JSON.stringify([FLUSH_EP, QUERY_EP])}${err ? ` (threw: ${err.slice(0, 120)})` : ""}`
  );
}

// Case 2 — a non-zero flush must THROW, never be skipped silently.
{
  const seq = [];
  stubFetch(seq, 1);
  let threw = "";
  try {
    await clientMod.sqlQuery("select 1");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  globalThis.fetch = realFetch;
  const ok = threw.includes("flush") && !seq.includes(QUERY_EP);
  if (!ok) flushAssertionsFailed++;
  console.log(
    `SQLQUERY-FLUSH-FAILURE-THROWS: ${ok ? "OK" : "FAIL"} — sequence ${JSON.stringify(seq)} (query must not be reached), error ${JSON.stringify(threw.slice(0, 140))}`
  );
}

console.log(
  `FLUSH ASSERTIONS: ${flushAssertionsFailed === 0 ? "all passed" : `${flushAssertionsFailed} FAILED`}`
);

await client.close();
process.exit(flushAssertionsFailed > 0 ? 1 : 0);
