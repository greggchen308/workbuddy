export class SiyuanApiError extends Error {
  constructor(public endpoint: string, public code: number, public apiMsg: string) {
    super(`SiYuan API ${endpoint} returned code ${code}: ${apiMsg}`);
  }
}

function baseUrl(): string {
  const url = process.env.SIYUAN_API_URL;
  if (!url) throw new Error("SIYUAN_API_URL is not set in this process's environment.");
  return url.replace(/\/+$/, "");
}

function token(): string {
  const tok = process.env.SIYUAN_API_TOKEN;
  if (!tok) throw new Error("SIYUAN_API_TOKEN is not set in this process's environment.");
  return tok;
}

// Every SiYuan kernel endpoint returns {code, msg, data} regardless of transport-level success,
// so a 200 with code !== 0 is still a failure and must not be treated as done.
export async function siyuanPost<T = unknown>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(`SiYuan API ${endpoint} HTTP ${res.status}: ${await res.text()}`);
  }
  const parsed = (await res.json()) as { code: number; msg: string; data: T };
  if (parsed.code !== 0) {
    throw new SiyuanApiError(endpoint, parsed.code, parsed.msg);
  }
  return parsed.data;
}

/**
 * Write a file into the workspace via /api/file/putFile (multipart: path, isDir, file).
 *
 * Deliberately does NOT use /api/asset/upload: on this deployment that endpoint is a silent
 * no-op -- HTTP 200, {"code":0,"msg":""} with succFiles: [] and succMap: {}, for every
 * multipart variant tested (field names assets/file/files/upload/assets[], with and without
 * assetsDirPath, ASCII and CJK filenames, boundaries with and without leading dashes).
 * It never raises an error, so it reads as success while writing nothing. Diagnosing it
 * further is server/Zeabur-side work and out of scope here.
 *
 * See SiYuan doc 20260917130056-wxxj67h ("SiYuan API Asset Ingest -- Silent Failures and the
 * Working putFile Path", 03 Investigations & Audits) for the full evidence.
 *
 * A code:0 from this endpoint is NOT evidence the file landed -- callers must verify with
 * getFileBytes() or readDir(). This deployment has two confirmed silent-no-op endpoints
 * (asset/upload and filetree/removeDoc), so code:0 alone means nothing.
 */
export async function putFile(
  destPath: string,
  filename: string,
  data: Uint8Array
): Promise<void> {
  const form = new FormData();
  form.append("path", destPath);
  form.append("isDir", "false");
  // Copy into a standalone ArrayBuffer so the Blob part is unambiguously typed.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  form.append("file", new Blob([buf]), filename);

  const res = await fetch(`${baseUrl()}/api/file/putFile`, {
    method: "POST",
    // No Content-Type here: fetch sets the multipart boundary itself.
    headers: { Authorization: `Token ${token()}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`SiYuan API /api/file/putFile HTTP ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  let parsed: { code?: number; msg?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`SiYuan API /api/file/putFile returned a non-JSON body: ${text.slice(0, 200)}`);
  }
  if (typeof parsed.code === "number" && parsed.code !== 0) {
    throw new SiyuanApiError("/api/file/putFile", parsed.code, parsed.msg ?? "");
  }
}

/**
 * Read raw file bytes via /api/file/getFile.
 *
 * The kernel is inconsistent here: on success it streams the raw bytes, but on failure it
 * returns HTTP 200 with a JSON {code,msg,data} envelope instead. So a JSON-looking body with a
 * non-zero code is an error, and anything else is the file content.
 */
export async function getFileBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl()}/api/file/getFile`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    throw new Error(`SiYuan API /api/file/getFile HTTP ${res.status}: ${await res.text()}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Cheap sniff: real media starts with magic bytes, never "{". Only treat as an error
  // envelope if it parses as JSON *and* carries a non-zero code.
  const asText = Buffer.from(bytes).toString("utf8");
  if (asText.trimStart().startsWith("{")) {
    let envelope: { code?: number; msg?: string } | undefined;
    try {
      envelope = JSON.parse(asText);
    } catch {
      envelope = undefined;
    }
    if (envelope && typeof envelope.code === "number" && envelope.code !== 0) {
      throw new SiyuanApiError("/api/file/getFile", envelope.code, envelope.msg ?? "");
    }
  }
  return bytes;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  updated: number;
}

export async function readDir(path: string): Promise<DirEntry[]> {
  return siyuanPost<DirEntry[]>("/api/file/readDir", { path });
}

export interface BlockRow {
  id: string;
  box: string;
  hpath: string;
  type: string;
  content?: string;
}

/**
 * Force the kernel to flush its pending SQLite transaction so the block index is current.
 *
 * SiYuan's SQL indexing is ASYNCHRONOUS for every block-writing API (appendBlock, insertBlock,
 * updateBlock, deleteBlock) -- confirmed by maintainer 88250 on siyuan-note/siyuan#19841
 * (2026-09-25). A /api/query/sql issued right after a write can therefore miss blocks the kernel
 * has already committed and that getBlockKramdown returns. Measured on this instance the same day:
 * immediately after a write, SQL saw append 9/30, update 6/20, delete-gone 5/10; after a
 * flushTransaction the same reads returned 30/30, 20/20, 10/10.
 *
 * This is a non-mutating call, so it adds no write risk. It must return code: 0 -- siyuanPost()
 * already throws on any non-zero code, so a failure here is never silently swallowed.
 */
export async function flushTransaction(): Promise<void> {
  await siyuanPost<null>("/api/sqlite/flushTransaction", {});
}

/**
 * Run a read-only SQL query. Flushes the SQLite transaction FIRST.
 *
 * Callers must not assume a query reflects the latest write without this: the index is async, so
 * an unflushed read is a race, not a snapshot. If the flush fails we throw rather than fall through
 * to a stale-index read -- a silently stale result is worse than a visible error, because it reads
 * as "the write didn't land" and invites a duplicate write.
 */
export async function sqlQuery(stmt: string): Promise<BlockRow[]> {
  try {
    await flushTransaction();
  } catch (err) {
    throw new Error(
      `sqlQuery: could not flush the SQLite transaction before querying ` +
        `(/api/sqlite/flushTransaction failed: ${err instanceof Error ? err.message : String(err)}). ` +
        `Refusing to run the query against a possibly-stale index -- an unflushed SQL read can silently ` +
        `miss blocks the kernel has already committed (siyuan-note/siyuan#19841). Retry, or read the ` +
        `block with getBlockKramdown instead, which is always current.`
    );
  }
  return siyuanPost<BlockRow[]>("/api/query/sql", { stmt });
}

export async function getBlockKramdown(id: string): Promise<{ id: string; kramdown: string }> {
  return siyuanPost("/api/block/getBlockKramdown", { id });
}

export async function getChildBlocks(
  id: string
): Promise<Array<{ id: string; type: string; content: string; subType?: string }>> {
  return siyuanPost("/api/block/getChildBlocks", { id });
}

export async function getBlockBreadcrumb(
  id: string
): Promise<Array<{ id: string; name: string; type: string }>> {
  return siyuanPost("/api/block/getBlockBreadcrumb", { id, excludeTypes: [] });
}

export async function getIDsByHPath(notebook: string, path: string): Promise<string[]> {
  return siyuanPost<string[]>("/api/filetree/getIDsByHPath", { notebook, path });
}

export async function listDocsByPath(notebook: string, path: string): Promise<unknown> {
  return siyuanPost("/api/filetree/listDocsByPath", { notebook, path });
}

export async function fullTextSearchBlock(query: string, types?: Record<string, boolean>): Promise<unknown> {
  return siyuanPost("/api/search/fullTextSearchBlock", {
    query,
    types: types ?? { document: true, heading: true, paragraph: true },
  });
}

export async function lsNotebooks(): Promise<unknown> {
  return siyuanPost("/api/notebook/lsNotebooks", {});
}

export async function exportMdContent(id: string): Promise<{ hPath: string; content: string }> {
  return siyuanPost("/api/export/exportMdContent", { id });
}

export async function createDocWithMd(notebook: string, path: string, markdown: string): Promise<string> {
  return siyuanPost<string>("/api/filetree/createDocWithMd", { notebook, path, markdown });
}

export async function appendBlock(
  parentID: string,
  data: string,
  dataType: "markdown" | "dom" = "markdown"
): Promise<Array<{ doOperations: Array<{ id: string }> }>> {
  return siyuanPost("/api/block/appendBlock", { parentID, dataType, data });
}

export async function updateBlock(
  id: string,
  data: string,
  dataType: "markdown" | "dom" = "markdown"
): Promise<unknown> {
  return siyuanPost("/api/block/updateBlock", { id, dataType, data });
}

export async function addAttributeViewBlocks(avID: string, blockID: string): Promise<unknown> {
  return siyuanPost("/api/av/addAttributeViewBlocks", { avID, srcs: [{ id: blockID, isDetached: false }] });
}

export async function getAttributeViewItemIDsByBoundIDs(
  avID: string,
  blockIDs: string[]
): Promise<Record<string, string>> {
  return siyuanPost("/api/av/getAttributeViewItemIDsByBoundIDs", { avID, blockIDs });
}

export async function setAttributeViewBlockAttr(
  avID: string,
  keyID: string,
  itemID: string,
  value: unknown
): Promise<unknown> {
  return siyuanPost("/api/av/setAttributeViewBlockAttr", { avID, keyID, itemID, value });
}

export async function getAttributeView(id: string): Promise<unknown> {
  return siyuanPost("/api/av/getAttributeView", { id });
}

export async function renderAttributeView(
  id: string,
  blockID: string,
  viewID: string
): Promise<unknown> {
  return siyuanPost("/api/av/renderAttributeView", { id, blockID, viewID, page: 1, pageSize: 100 });
}
