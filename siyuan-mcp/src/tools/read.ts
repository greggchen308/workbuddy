import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as siyuan from "../siyuanClient.js";

// Read access is unrestricted everywhere in the vault -- per write-scope.md, the boundary
// this connector enforces is on writes, not reads.
export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "siyuan_sql_query",
    {
      title: "Run a read-only SQL query against the SiYuan vault",
      description:
        "Executes a SELECT statement via /api/query/sql. Read-only -- use this to resolve doc IDs, list recent docs, or cross-check the block table directly. Do not attempt writes through this endpoint.",
      inputSchema: { stmt: z.string().describe("A SELECT statement against SiYuan's blocks table.") },
    },
    async ({ stmt }) => {
      if (!/^\s*select\s/i.test(stmt)) {
        throw new Error("Only SELECT statements are allowed through this tool.");
      }
      const rows = await siyuan.sqlQuery(stmt);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    "siyuan_get_block_kramdown",
    {
      title: "Read a block or document's full content",
      description: "Returns the kramdown source of a block (a document ID returns the whole doc).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const result = await siyuan.getBlockKramdown(id);
      return { content: [{ type: "text", text: result.kramdown }] };
    }
  );

  server.registerTool(
    "siyuan_get_child_blocks",
    {
      title: "List a document's direct child blocks",
      description: "Returns structure (id, type, content preview) of a doc's children -- use before any targeted edit.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const children = await siyuan.getChildBlocks(id);
      return { content: [{ type: "text", text: JSON.stringify(children, null, 2) }] };
    }
  );

  server.registerTool(
    "siyuan_get_ids_by_hpath",
    {
      title: "Resolve a human-readable path to a document ID",
      description: "Given a notebook ID and an hpath like \"/01 PRDs & Reviews/My Doc\", returns matching doc IDs (empty array if none).",
      inputSchema: { notebook: z.string(), path: z.string() },
    },
    async ({ notebook, path }) => {
      const ids = await siyuan.getIDsByHPath(notebook, path);
      return { content: [{ type: "text", text: JSON.stringify(ids) }] };
    }
  );

  server.registerTool(
    "siyuan_full_text_search",
    {
      title: "Full-text search across the vault",
      description: "Search for a term across all documents, headings, and paragraphs.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const results = await siyuan.fullTextSearchBlock(query);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.registerTool(
    "siyuan_list_notebooks",
    {
      title: "List all notebooks in the vault",
      description: "Returns every notebook and its ID -- use to confirm the live notebook map rather than trusting a hardcoded one.",
      inputSchema: {},
    },
    async () => {
      const notebooks = await siyuan.lsNotebooks();
      return { content: [{ type: "text", text: JSON.stringify(notebooks, null, 2) }] };
    }
  );

  server.registerTool(
    "siyuan_export_md",
    {
      title: "Export a document as plain Markdown",
      description: "Returns the rendered Markdown export of a document (its hPath and content).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const result = await siyuan.exportMdContent(id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
