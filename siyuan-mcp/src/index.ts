#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerKanbanTools } from "./tools/kanban.js";

if (!process.env.SIYUAN_API_URL || !process.env.SIYUAN_API_TOKEN) {
  console.error(
    "workbuddy-siyuan-mcp: SIYUAN_API_URL and/or SIYUAN_API_TOKEN are not set. " +
      "Set them in this server's env block in WorkBuddy's mcpServers config."
  );
  process.exit(1);
}

const server = new McpServer({
  name: "workbuddy-siyuan-mcp",
  version: "0.1.0",
});

registerReadTools(server);
registerWriteTools(server);
registerKanbanTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
