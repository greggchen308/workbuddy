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

export interface BlockRow {
  id: string;
  box: string;
  hpath: string;
  type: string;
  content?: string;
}

export async function sqlQuery(stmt: string): Promise<BlockRow[]> {
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
