import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as siyuan from "../siyuanClient.js";
import { NOTEBOOKS, checkWriteScope, isFactCardShaped, findBareHashCorruptionRisk } from "../scope.js";
import { scanForCorruptionSignature } from "../corruption.js";

// Ground truth per .claude/skills/siyuan-architect/reference/kanban-board.md -- keep in sync by hand.
const BOARD_AV_ID = "20260806134713-qy4xg5x";
const KANBAN_VIEW_ID = "20260806134720-96fjlsi";
const EMBED_BLOCK_ID = "20260806134738-rlcnwm7";
const STATUS_KEY_ID = "20260806134720-vr2p5q9";
const DETAILS_KEY_ID = "20260806140001-abc1234";
const OPEN_BACKLOG_ITEMS_PATH = "/05 Handovers & Reports/Open Backlog Items";
const COUNTER_VALUE_BLOCK_ID = "20260807174031-4ltavv6";
const COUNTER_LOG_LIST_ID = "20260807174031-p4bfmtn";

const STATUS_COLORS: Record<string, string> = {
  "To Do": "3",
  "Blocked/Needs Decision": "1",
  Monitor: "2",
  Closed: "4",
  Rejected: "6",
};

function rejectUnsafeContent(markdown: string): void {
  if (isFactCardShaped(markdown)) {
    throw new Error("Refused: content is shaped like a Fact Card, not a Kanban card body.");
  }
  const findings = findBareHashCorruptionRisk(markdown);
  if (findings.length > 0) {
    throw new Error(`Refused: tag-misparse corruption risk (CLAUDE.md §3). Offending block(s): ${JSON.stringify(findings)}`);
  }
}

async function nextIncidentNumber(): Promise<number> {
  const { kramdown } = await siyuan.getBlockKramdown(COUNTER_VALUE_BLOCK_ID);
  const match = kramdown.match(/current highest number:\*\*\s*(\d+)/i);
  if (!match) {
    throw new Error(`Could not parse the current incident counter from: ${kramdown}`);
  }
  return parseInt(match[1], 10) + 1;
}

export function registerKanbanTools(server: McpServer): void {
  server.registerTool(
    "siyuan_kanban_read_board",
    {
      title: "Read the OpenClaw Open Backlog Kanban board",
      description: "Returns the live board grouped by status column, via renderAttributeView (matches what's shown in the app).",
      inputSchema: {},
    },
    async () => {
      const rendered = await siyuan.renderAttributeView(BOARD_AV_ID, EMBED_BLOCK_ID, KANBAN_VIEW_ID);
      return { content: [{ type: "text", text: JSON.stringify(rendered, null, 2) }] };
    }
  );

  server.registerTool(
    "siyuan_kanban_file_card",
    {
      title: "File a new tracked item on the Kanban board",
      description:
        "Runs the full confirmed-working flow from kanban-board.md: read-increment-verify the shared incident counter, create the card doc under Open Backlog Items, bind it to the board, and optionally set Details/Status. " +
        "IMPORTANT: before calling this, search the board (siyuan_kanban_read_board) and/or full-text search for the topic -- a duplicate card for something already tracked is a real, previously-occurring mistake (CLAUDE.md §7, card 114 vs 113). Do not call this for anything the board already covers.",
      inputSchema: {
        title: z.string().describe('Card title WITHOUT the "#NN — " prefix; this tool prefixes it after reading the counter.'),
        bodyMarkdown: z.string().describe("1-3 sentence description. Reference a fuller writeup elsewhere in SiYuan rather than duplicating it."),
        detailsPath: z.string().optional().describe("Path to a fuller writeup doc elsewhere in SiYuan, if one exists."),
        status: z.enum(["To Do", "Blocked/Needs Decision", "Monitor", "Closed", "Rejected"]).optional(),
      },
    },
    async ({ title, bodyMarkdown, detailsPath, status }) => {
      rejectUnsafeContent(bodyMarkdown);

      const number = await nextIncidentNumber();
      await siyuan.updateBlock(COUNTER_VALUE_BLOCK_ID, `**Current highest number:**  ${number}`);
      const dateStr = new Date().toISOString().slice(0, 10);
      await siyuan.appendBlock(COUNTER_LOG_LIST_ID, `- #${number} — ${title} — ${dateStr} — filed under Open Backlog Items`);

      const counterCheck = await siyuan.getBlockKramdown(COUNTER_VALUE_BLOCK_ID);
      if (!counterCheck.kramdown.includes(`${number}`)) {
        throw new Error(`Counter write did not verify -- expected ${number} in "${counterCheck.kramdown}". Stop; do not create the card until the counter state is confirmed.`);
      }

      const cardTitle = `#${number} — ${title}`;
      const cardPath = `${OPEN_BACKLOG_ITEMS_PATH}/${cardTitle}`;
      const scopeCheck = checkWriteScope(NOTEBOOKS["00_ops"], cardPath);
      if (!scopeCheck.ok) throw new Error(`Refused: ${scopeCheck.reason}`);

      const existing = await siyuan.getIDsByHPath(NOTEBOOKS["00_ops"], cardPath);
      if (existing.length > 0) {
        throw new Error(`A card already exists at "${cardPath}" (id ${existing[0]}). This looks like a duplicate filing.`);
      }

      const markdown = `# ${cardTitle}\n\n${bodyMarkdown}\n`;
      rejectUnsafeContent(markdown);
      const docId = await siyuan.createDocWithMd(NOTEBOOKS["00_ops"], cardPath, markdown);

      const verifyIds = await siyuan.getIDsByHPath(NOTEBOOKS["00_ops"], cardPath);
      if (!verifyIds.includes(docId)) {
        throw new Error(`Created card doc ${docId} but it does not resolve back at "${cardPath}" -- location verification failed.`);
      }
      const { kramdown } = await siyuan.getBlockKramdown(docId);
      const corruptionScan = scanForCorruptionSignature(kramdown);
      if (corruptionScan.corrupted) {
        throw new Error(`Card ${docId} was created but its read-back shows the tag-misparse corruption signature. Do not report this as done -- see CLAUDE.md §3.`);
      }

      await siyuan.addAttributeViewBlocks(BOARD_AV_ID, docId);
      const itemIdMap = await siyuan.getAttributeViewItemIDsByBoundIDs(BOARD_AV_ID, [docId]);
      const itemID = itemIdMap[docId];
      if (!itemID) {
        throw new Error(`Card ${docId} was created but binding to the board failed to produce an itemID -- it may not actually be bound. Check the board manually.`);
      }

      if (detailsPath) {
        await siyuan.setAttributeViewBlockAttr(BOARD_AV_ID, DETAILS_KEY_ID, itemID, { text: { content: detailsPath } });
      }
      if (status && status !== "To Do") {
        await siyuan.setAttributeViewBlockAttr(BOARD_AV_ID, STATUS_KEY_ID, itemID, {
          mSelect: [{ content: status, color: STATUS_COLORS[status] }],
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Filed ${cardTitle} (doc ${docId}, itemID ${itemID}) under Open Backlog Items. Bound to board. Counter now at ${number}, log line appended. Status: ${status ?? "To Do (default)"}.` +
              (detailsPath ? ` Details set to "${detailsPath}".` : ""),
          },
        ],
      };
    }
  );

  server.registerTool(
    "siyuan_kanban_set_status",
    {
      title: "Change an existing Kanban card's status column",
      description: "Resolves the card's real attribute-view itemID (never the Primary Key .id -- that was a confirmed bug) and sets its Select status, then verifies via read-back.",
      inputSchema: {
        cardDocId: z.string().describe("The card's document ID (the bound source block, not the itemID)."),
        status: z.enum(["To Do", "Blocked/Needs Decision", "Monitor", "Closed", "Rejected"]),
      },
    },
    async ({ cardDocId, status }) => {
      const itemIdMap = await siyuan.getAttributeViewItemIDsByBoundIDs(BOARD_AV_ID, [cardDocId]);
      const itemID = itemIdMap[cardDocId];
      if (!itemID) {
        throw new Error(`${cardDocId} does not resolve to a bound board itemID -- it may not be a real Kanban card, or isn't actually bound.`);
      }
      await siyuan.setAttributeViewBlockAttr(BOARD_AV_ID, STATUS_KEY_ID, itemID, {
        mSelect: [{ content: status, color: STATUS_COLORS[status] }],
      });

      const av = (await siyuan.getAttributeView(BOARD_AV_ID)) as {
        keyValues?: Array<{ key: { id: string }; values: Array<{ blockID: string; mSelect?: Array<{ content: string }> }> }>;
      };
      const statusKV = av.keyValues?.find((kv) => kv.key.id === STATUS_KEY_ID);
      const cell = statusKV?.values.find((v) => v.blockID === itemID);
      if (!cell || cell.mSelect?.[0]?.content !== status) {
        throw new Error(`Set status call returned success but read-back via getAttributeView does not confirm "${status}" for ${cardDocId}. Do not report this as done.`);
      }

      return { content: [{ type: "text", text: `${cardDocId} status set to "${status}", verified via getAttributeView read-back.` }] };
    }
  );
}
