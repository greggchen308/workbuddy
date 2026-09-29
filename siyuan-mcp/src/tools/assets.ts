import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as siyuan from "../siyuanClient.js";

/**
 * Asset writing for the SiYuan vault.
 *
 * Background: getting an image into a note used to require ad-hoc inline Python against
 * /api/file/putFile, because /api/asset/upload silently writes nothing on this deployment
 * (see the putFile doc comment in siyuanClient.ts). This tool exists so future sessions don't
 * have to reconstruct that, and don't have to rediscover that asset/upload is a dead end.
 */

const ASSET_DIR = "/data/assets";
const REF_PREFIX = "assets/";

/**
 * Extensions this tool will write. Deliberately an allowlist rather than a denylist.
 *
 * `svg` is intentionally EXCLUDED even though it is a normal SiYuan asset type: assets are
 * served from the vault's own origin, and an SVG can carry script, so writing one is a
 * stored-XSS vector into Gregg's vault. Add it here only if that tradeoff is revisited.
 * Extend the list if a legitimate non-media asset type is needed.
 */
const ALLOWED_EXTENSIONS = new Set([
  // images
  "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "heif",
  // documents
  "pdf",
  // audio
  "mp3", "m4a", "wav", "ogg", "oga", "flac", "aac",
  // video
  "mp4", "mov", "m4v", "webm",
]);

const MAX_FILENAME_LENGTH = 200;
const NON_ASCII_RE = /[^\x20-\x7E]/;

function validateFilename(filename: string): string[] {
  const warnings: string[] = [];

  if (filename.trim().length === 0) {
    throw new Error("Refused: filename is empty.");
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new Error(
      `Refused: filename is ${filename.length} characters; the limit is ${MAX_FILENAME_LENGTH}.`
    );
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new Error(
      `Refused: filename "${filename}" contains a path separator. Pass a bare filename only -- ` +
        `this tool always writes into ${ASSET_DIR}/.`
    );
  }
  if (filename.includes("..")) {
    throw new Error(`Refused: filename "${filename}" contains "..".`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(filename)) {
    throw new Error(`Refused: filename "${filename}" contains control characters.`);
  }
  if (filename.startsWith(".")) {
    throw new Error(`Refused: filename "${filename}" starts with a dot.`);
  }

  const ext = extname(filename).replace(/^\./, "").toLowerCase();
  if (!ext) {
    throw new Error(
      `Refused: filename "${filename}" has no extension. A correct extension is required -- ` +
        `SiYuan serves assets by type. Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(", ")}.`
    );
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Refused: ".${ext}" is not in this tool's allowed extension list. Allowed: ` +
        `${[...ALLOWED_EXTENSIONS].sort().join(", ")}. ` +
        `(svg is deliberately excluded -- assets are served from the vault's own origin and SVG ` +
        `can carry script. Extend ALLOWED_EXTENSIONS in src/tools/assets.ts if a new type is needed.)`
    );
  }

  if (NON_ASCII_RE.test(filename)) {
    warnings.push(
      `Filename "${filename}" contains non-ASCII characters. These were tested and DO work on ` +
        `this deployment, but ASCII-only names are preferred -- they survive URL-encoding, ` +
        `shell quoting, and any future export or sync path without surprises.`
    );
  }
  if (/\s/.test(filename)) {
    warnings.push(
      `Filename "${filename}" contains whitespace. It will work, but hyphens are safer in ` +
        `asset names.`
    );
  }

  return warnings;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatBytes(n: number): string {
  return n.toLocaleString("en-US");
}

export function registerAssetTools(server: McpServer): void {
  server.registerTool(
    "siyuan_write_asset",
    {
      title: "Write an image or media file into the vault's asset store",
      description:
        "Writes a file into /data/assets/ and returns the `assets/<name>` reference string to drop " +
        "into markdown. Wraps POST /api/file/putFile (multipart: path, isDir=false, file) -- " +
        "deliberately NOT /api/asset/upload, which is a confirmed silent no-op on this deployment " +
        "(HTTP 200, code:0, succFiles: [], no error ever surfaced; see SiYuan doc " +
        "20260917130056-wxxj67h). Provide the bytes either as base64 (`contentBase64`) or as a " +
        "local file path (`localPath`) -- exactly one of the two. " +
        "Every write is verified by reading the file back with /api/file/getFile and comparing " +
        "SHA-256, falling back to a /api/file/readDir presence check only if the read-back call " +
        "itself fails; the response says which verification was used. A code:0 from putFile is " +
        "never treated as success on its own -- this deployment has two confirmed silent-no-op " +
        "endpoints (asset/upload and filetree/removeDoc). " +
        "Refuses path separators, traversal, control characters, leading dots, and extensions " +
        "outside a media allowlist (svg excluded as a stored-XSS vector). Refuses to overwrite an " +
        "existing asset unless overwrite=true, because other docs may already reference it. " +
        "Warns (does not refuse) on non-ASCII or whitespace-containing filenames. " +
        "Note: assets are global to the vault, not notebook-scoped, so this tool does not run a " +
        "doc-path write-scope check. This tool writes files only -- it has no delete counterpart, " +
        "by design.",
      inputSchema: {
        filename: z
          .string()
          .describe(
            'Bare destination filename, e.g. "yuanshi-03-five-bottles.jpg". No path separators. ' +
              "ASCII-only preferred. The file lands at /data/assets/<filename>."
          ),
        contentBase64: z
          .string()
          .optional()
          .describe("Base64-encoded file bytes. Provide this OR localPath, not both."),
        localPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to a local file to read the bytes from. Provide this OR contentBase64, " +
              "not both. Convenient when the file is already on this machine."
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Set true to replace an existing asset of the same name. Default false -- an existing " +
              "asset may already be referenced by other docs."
          ),
      },
    },
    async ({ filename, contentBase64, localPath, overwrite }) => {
      const warnings = validateFilename(filename);

      // Compare against undefined, not falsiness: an empty string is a *provided but empty*
      // input and must fall through to the zero-bytes refusal, not be reported as missing.
      const hasB64 = contentBase64 !== undefined;
      const hasPath = localPath !== undefined;
      if (!hasB64 && !hasPath) {
        throw new Error("Provide either contentBase64 or localPath.");
      }
      if (hasB64 && hasPath) {
        throw new Error("Provide only one of contentBase64 or localPath, not both.");
      }

      let bytes: Uint8Array;
      if (hasPath) {
        if (!localPath!.startsWith("/")) {
          throw new Error(`localPath must be absolute; got "${localPath}".`);
        }
        try {
          bytes = new Uint8Array(await readFile(localPath!));
        } catch (err) {
          throw new Error(
            `Could not read localPath "${localPath}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        // Buffer.from(x, "base64") silently drops invalid characters rather than throwing, so
        // validate first -- otherwise a malformed string writes plausible-looking garbage.
        const normalized = contentBase64!.replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
          throw new Error(
            "contentBase64 is not valid base64 (after stripping whitespace it must match " +
              "[A-Za-z0-9+/] with optional trailing '=' padding, and its length must be a multiple of 4)."
          );
        }
        bytes = new Uint8Array(Buffer.from(normalized, "base64"));
      }
      if (bytes.byteLength === 0) {
        throw new Error("Refused: the supplied content is zero bytes.");
      }

      const sourceSha = sha256Hex(bytes);
      const destPath = `${ASSET_DIR}/${filename}`;
      const reference = `${REF_PREFIX}${filename}`;

      // Refuse to clobber an asset that other docs may already point at.
      const before = await siyuan.readDir(ASSET_DIR);
      const exists = before.some((e) => e.name === filename && !e.isDir);
      if (exists && !overwrite) {
        throw new Error(
          `Refused: "${filename}" already exists in ${ASSET_DIR}/ (${formatBytes(
            bytes.byteLength
          )} bytes not written). Other docs may already reference it -- pass overwrite=true only ` +
            `if you intend to replace it everywhere. Consider a distinct filename instead.`
        );
      }

      await siyuan.putFile(destPath, filename, bytes);

      // putFile returning code:0 is not evidence. Verify against the server.
      let verification: string;
      try {
        const readBack = await siyuan.getFileBytes(destPath);
        const readBackSha = sha256Hex(readBack);
        if (readBackSha !== sourceSha) {
          throw new Error(
            `Write verification FAILED for ${destPath}: read-back SHA-256 ${readBackSha} does not ` +
              `match the ${sourceSha} that was sent (read-back was ${readBack.byteLength} bytes, ` +
              `sent ${bytes.byteLength}). Do NOT report this write as done.`
          );
        }
        verification = `verified by read-back: /api/file/getFile returned ${formatBytes(
          readBack.byteLength
        )} bytes, SHA-256 matches exactly.`;
      } catch (err) {
        // If the read-back path itself is broken, fall back to a presence check -- but say so,
        // because that is weaker evidence than a hash match.
        if (err instanceof Error && err.message.startsWith("Write verification FAILED")) {
          throw err;
        }
        const after = await siyuan.readDir(ASSET_DIR);
        const present = after.some((e) => e.name === filename && !e.isDir);
        if (!present) {
          throw new Error(
            `Write verification FAILED for ${destPath}: the file is not present in a /api/file/readDir ` +
              `listing after putFile returned success, and the /api/file/getFile read-back also errored ` +
              `(${err instanceof Error ? err.message : String(err)}). Do NOT report this write as done.`
          );
        }
        verification =
          `verified by NAME PRESENCE ONLY (weaker): the file appears in a /api/file/readDir listing, ` +
          `but the /api/file/getFile read-back failed (${err instanceof Error ? err.message : String(err)}), ` +
          `so the bytes were NOT hash-checked.`;
      }

      const lines: string[] = [];
      for (const w of warnings) lines.push(`WARNING: ${w}`, "");
      lines.push(
        `Wrote ${destPath} (${formatBytes(bytes.byteLength)} bytes).`,
        `SHA-256 (sent): ${sourceSha}`,
        `Write ${verification}`,
        "",
        "Reference for markdown -- use exactly this, no leading slash:",
        `![alt text](${reference})`,
        "",
        "For an existing doc, wire it in without rewriting the doc. NEVER insertBlock -- " +
          "insertBlock is banned outright (append.md; it returned code:0 with a plausible block ID " +
          "while never persisting, 2026-08-24 gclobster incident), so never insert-then-deleteBlock " +
          "either. Two sanctioned paths: " +
          `(a) siyuan_update_child_block(blockId="<placeholder block id>", markdown="![alt text](${reference})") ` +
          "-- rewrites the placeholder in place, is F1/F6-guarded, write-scope-checked, and read-back " +
          "verified before it returns. (b) siyuan_append_block(parentDocId=\"<doc id>\", " +
          `markdown="![alt text](${reference})") -- appends the image paragraph at the end of the doc. ` +
          "If the doc has no placeholder block, use (b) or ask before restructuring -- there is no " +
          "positional-insert path."
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
