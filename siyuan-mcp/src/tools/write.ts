import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as siyuan from "../siyuanClient.js";
import { checkWriteScope, checkRawIngestMarker, isFactCardShaped, findBareHashCorruptionRisk } from "../scope.js";
import { scanForCorruptionSignature } from "../corruption.js";

const BLOCK_ID_RE = /^\d{14}-[0-9a-z]{7}$/;

function requireValidBlockId(id: string): void {
  if (!BLOCK_ID_RE.test(id)) {
    throw new Error(`"${id}" doesn't look like a SiYuan block/doc ID (expected format like 20260901140545-1vmnvz1).`);
  }
}

function rejectUnsafeContent(markdown: string): void {
  if (isFactCardShaped(markdown)) {
    throw new Error(
      "Refused: this content is shaped like a Fact Card (content/type/entities/confidence/importance/source/relations fields). Fact-card content is gclobster's pipeline territory, never written here regardless of target path."
    );
  }
  const findings = findBareHashCorruptionRisk(markdown);
  if (findings.length > 0) {
    throw new Error(
      "Refused: at least one block contains more than one bare #-prefixed reference, which risks the vendor-confirmed tag-misparse corruption bug (CLAUDE.md §3, siyuan-note/siyuan#19052). " +
        "Reword so each block has at most one bare # reference (e.g. drop the leading # on the second mention: \"card 113\" instead of \"card #113\"), or split across multiple blocks. " +
        `Offending block(s): ${JSON.stringify(findings)}`
    );
  }
}

async function resolveBlock(id: string): Promise<{ id: string; box: string; hpath: string; type: string }> {
  requireValidBlockId(id);
  const rows = await siyuan.sqlQuery(`select id, box, hpath, type from blocks where id = '${id}'`);
  if (rows.length === 0) {
    throw new Error(`Block ${id} not found.`);
  }
  return rows[0] as { id: string; box: string; hpath: string; type: string };
}

async function assertPostWriteClean(blockId: string): Promise<string> {
  const { kramdown } = await siyuan.getBlockKramdown(blockId);
  const scan = scanForCorruptionSignature(kramdown);
  if (scan.corrupted) {
    throw new Error(
      `Write succeeded but the read-back of ${blockId} shows the tag-misparse corruption signature (${scan.occurrences} occurrence(s) of "#" + U+200B). ` +
        "Do not report this write as done -- per CLAUDE.md §3, reword the corrupted block to at most one bare # reference and updateBlock the targeted child (never the doc root) to fix it."
    );
  }
  return kramdown;
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "siyuan_create_doc",
    {
      title: "Create a brand-new document",
      description:
        "Creates a new doc under an ALREADY-EXISTING parent folder-doc, within this connector's write scope (00_ops's PRD/planning/Kanban/WB Scratchpad subfolders, a 02_wiki root doc matching a known planning-doc naming pattern, or a single top-level doc directly under 01_raw). A 01_raw doc must contain the literal marker \"Status: [Unprocessed]\" (PRD 20260902001622-km01ps3 §8 C2) or the write is refused. Refuses fact-card-shaped content, refuses a guessed/nonexistent parent path, and verifies content + location after writing.",
      inputSchema: {
        notebook: z.string().describe("Notebook ID, e.g. 00_ops's 20260503153537-su0bsif."),
        path: z.string().describe('Full hpath of the new doc, e.g. "/WB Scratchpad/2026-09-01 note". No "/" is allowed inside the title itself.'),
        markdown: z.string().describe("Full markdown content of the new document."),
      },
    },
    async ({ notebook, path, markdown }) => {
      const scopeCheck = checkWriteScope(notebook, path);
      if (!scopeCheck.ok) throw new Error(`Refused: ${scopeCheck.reason}`);
      const markerCheck = checkRawIngestMarker(notebook, markdown);
      if (!markerCheck.ok) throw new Error(`Refused: ${markerCheck.reason}`);
      rejectUnsafeContent(markdown);

      const already = await siyuan.getIDsByHPath(notebook, path);
      if (already.length > 0) {
        throw new Error(`A doc already exists at "${path}" (id ${already[0]}). Use siyuan_append_block or siyuan_update_child_block instead of creating a duplicate.`);
      }

      const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
      const segments = trimmed.split("/");
      if (segments.length > 1) {
        const parentPath = "/" + segments.slice(0, -1).join("/");
        const parentIds = await siyuan.getIDsByHPath(notebook, parentPath);
        if (parentIds.length === 0) {
          throw new Error(
            `Refused: parent path "${parentPath}" doesn't resolve to an existing doc. createDocWithMd does not error on a guessed path -- it silently creates a phantom intermediate doc instead (CLAUDE.md §8 rule 1). Create the parent explicitly first, or fix the path.`
          );
        }
      }

      const newId = await siyuan.createDocWithMd(notebook, path, markdown);

      const verifyIds = await siyuan.getIDsByHPath(notebook, path);
      if (!verifyIds.includes(newId)) {
        throw new Error(`Created doc ${newId} but it does not resolve back at "${path}" -- location verification failed, do not trust this write.`);
      }
      const kramdown = await assertPostWriteClean(newId);

      return {
        content: [
          {
            type: "text",
            text: `Created "${path}" (id ${newId}). Verified location and content. First lines:\n${kramdown.split("\n").slice(0, 5).join("\n")}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "siyuan_append_block",
    {
      title: "Append content to the end of an existing document",
      description:
        "Appends markdown after everything already in a document, using appendBlock (never insertBlock -- see CLAUDE.md §8/append.md). Only accepts a DOCUMENT ID as the target (the simple, safe case) -- resolve up to the doc root first if you only have a child block ID. Enforces this connector's write scope and refuses fact-card/corruption-risk content.",
      inputSchema: {
        parentDocId: z.string().describe("The document's own block ID (not an arbitrary child block)."),
        markdown: z.string(),
      },
    },
    async ({ parentDocId, markdown }) => {
      const block = await resolveBlock(parentDocId);
      if (block.type !== "d") {
        throw new Error(
          `${parentDocId} is a "${block.type}" block, not a document root. This tool only appends to a document's own ID -- call siyuan_get_block_breadcrumb on it and use the first entry's id instead.`
        );
      }
      const scopeCheck = checkWriteScope(block.box, block.hpath);
      if (!scopeCheck.ok) throw new Error(`Refused: ${scopeCheck.reason}`);
      rejectUnsafeContent(markdown);

      await siyuan.appendBlock(parentDocId, markdown);

      const kramdown = await assertPostWriteClean(parentDocId);
      // SiYuan interleaves per-block IAL annotation lines ({: id="..." ...}) into the kramdown,
      // so a fixed-size "tail window" is unreliable -- check the whole doc for the appended
      // content instead of trying to bound where in the tail it should land.
      const normalizedSnippet = markdown.trim().split("\n").find((line) => line.trim().length > 0)?.trim();
      if (normalizedSnippet && !kramdown.includes(normalizedSnippet)) {
        throw new Error(`Append call returned success but the read-back of ${parentDocId} does not appear to contain the new content. Do not report this as done.`);
      }

      return { content: [{ type: "text", text: `Appended to ${parentDocId} ("${block.hpath}"). Verified in read-back tail.` }] };
    }
  );

  server.registerTool(
    "siyuan_update_child_block",
    {
      title: "Replace an existing child block's content (never the document root)",
      description:
        "Targeted content replacement for one existing block. HARD REFUSES any block of type 'd' (document root) -- updateBlock on a doc root wipes the entire body (CLAUDE.md F1 footgun, the 2026-07-23 incident). Enforces this connector's write scope, the heading-prefix gotcha (F6), and refuses fact-card/corruption-risk content.",
      inputSchema: {
        blockId: z.string().describe("The specific child block ID to replace -- never a document's own ID."),
        markdown: z.string(),
      },
    },
    async ({ blockId, markdown }) => {
      const block = await resolveBlock(blockId);
      if (block.type === "d") {
        throw new Error(
          `Refused: ${blockId} is a document ROOT block. updateBlock on a doc root replaces the entire body, wiping every child (this is exactly the 2026-07-23 F1 incident). Resolve the specific child block via siyuan_get_child_blocks instead.`
        );
      }
      const scopeCheck = checkWriteScope(block.box, block.hpath);
      if (!scopeCheck.ok) throw new Error(`Refused: ${scopeCheck.reason}`);
      if (block.type === "h" && !/^#{1,6}\s/.test(markdown)) {
        throw new Error(
          `Refused: target block ${blockId} is a heading, but the replacement text has no leading "#" markdown prefix. Bare text silently demotes a heading to a paragraph (F6 gotcha). Include the "#" prefix at the correct level, e.g. "## Updated heading".`
        );
      }
      rejectUnsafeContent(markdown);

      await siyuan.updateBlock(blockId, markdown);
      const kramdown = await assertPostWriteClean(blockId);

      return { content: [{ type: "text", text: `Updated ${blockId} ("${block.hpath}"). Verified content:\n${kramdown}` }] };
    }
  );
}
