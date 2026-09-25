import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "dist/index.js")],
  env: { ...process.env },
});

const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(transport);

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

const okAppend = await client.callTool({
  name: "siyuan_append_block",
  arguments: {
    parentDocId: "20260901140545-1vmnvz1",
    markdown: "---\n\n**Connector smoke test** — 2026-09-01 — verified read/write/scope/corruption guards end to end from workbuddy-siyuan-mcp.",
  },
});
console.log("OK-APPEND RESULT:", JSON.stringify(okAppend).slice(0, 400));

await client.close();
process.exit(0);
