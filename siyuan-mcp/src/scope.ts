// Mirrors .claude/skills/siyuan-architect/reference/write-scope.md. Keep in sync with that
// file by hand -- it is the human-reviewed source of truth, this is its code enforcement.

export const NOTEBOOKS = {
  "01_raw": "20260429072925-l8gvqjt",
  "02_wiki": "20260429072933-078h2m9",
  "03_projects": "20260429072950-kvlm1cc",
  "04_serendipity": "20260429073137-dhtsrg9",
  "00_ops": "20260503153537-su0bsif",
  Templates: "20260501005244-3fi1omx",
  ZZ_paywall: "20260524074104-1bjm4hk",
} as const;

const OPS_SUBFOLDER_ALLOWLIST = [
  "01 PRDs & Reviews",
  "02 Incidents & RCAs",
  "03 Investigations & Audits",
  "04 GitHub Issues",
  "05 Handovers & Reports",
  "WB Scratchpad",
];

const WIKI_ROOT_PATTERNS: RegExp[] = [
  /^PHASE\d+-.*-HANDOFF-TO-/i,
  /^PHASE\d+_PRD/i,
  /^PRD-Phase-\d+(\.\d+)?-/i,
  /^POST-MORTEM-\d{4}-\d{2}-\d{2}-/i,
  /^INCIDENT-/i,
  /^INVESTIGATION/i,
  /^HANDOFF/i,
  /^HANDOVER/i,
  /^RCA/i,
  /^GH-/,
  /^GITHUB-ISSUE-DRAFT-/i,
  /^【Draft】\s*GitHub Issue/i,
];

const WIKI_HARD_BLOCKED_PREFIXES = [
  "Entity/",
  "Concept/",
  "Url/",
  "Event/",
  "Decision/",
  "Configs/",
  "Date/",
  "Summary/",
  "Decisions/",
  "general/",
];

const WIKI_PROTECTED_PAGES = ["PROJECT Wiki Build", "Carta", "TinyCloud", "GPT Image 2", "YayText"];

export interface ScopeCheck {
  ok: boolean;
  reason?: string;
}

// PRD 20260902001622-km01ps3 §8 C2: every new doc written into 01_raw must carry this literal
// marker so downstream automation can detect and queue it. WB Scratchpad drops are exempt.
export const RAW_INGEST_STATUS_MARKER = "Status: [Unprocessed]";

export function checkRawIngestMarker(notebookId: string, markdown: string): ScopeCheck {
  if (notebookId !== NOTEBOOKS["01_raw"]) {
    return { ok: true };
  }
  if (!markdown.includes(RAW_INGEST_STATUS_MARKER)) {
    return {
      ok: false,
      reason: `Every new doc filed into 01_raw must contain the literal marker "${RAW_INGEST_STATUS_MARKER}" (PRD 20260902001622-km01ps3 §8 C2) so downstream automation can detect and queue it. This content is missing it.`,
    };
  }
  return { ok: true };
}

// hpath is the human-readable path returned by getIDsByHPath / stored in the `blocks.hpath` column,
// e.g. "/01 PRDs & Reviews/Some Doc Title" or "/Entity/Some Entity".
export function checkWriteScope(notebookId: string, hpath: string): ScopeCheck {
  const segments = hpath.replace(/^\/+/, "").split("/");
  const topSegment = segments[0] ?? "";

  if (notebookId === NOTEBOOKS["00_ops"]) {
    if (OPS_SUBFOLDER_ALLOWLIST.includes(topSegment)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `"${topSegment}" is not one of 00_ops's allowlisted write folders (${OPS_SUBFOLDER_ALLOWLIST.join(", ")}). Ambiguous target -- ask Gregg which bucket this belongs in rather than guessing.`,
    };
  }

  if (notebookId === NOTEBOOKS["02_wiki"]) {
    for (const blocked of WIKI_HARD_BLOCKED_PREFIXES) {
      if (hpath.replace(/^\/+/, "").startsWith(blocked)) {
        return { ok: false, reason: `"${blocked}" is an ontology folder -- gclobster's pipeline territory, hard-blocked regardless of content.` };
      }
    }
    for (const protectedPage of WIKI_PROTECTED_PAGES) {
      if (topSegment === protectedPage) {
        return { ok: false, reason: `"${protectedPage}" is a hard-blocked protected page, even if this write looks PRD-shaped.` };
      }
    }
    if (segments.length === 1 && WIKI_ROOT_PATTERNS.some((re) => re.test(topSegment))) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `"${hpath}" in 02_wiki doesn't match a known planning-doc naming convention (PHASE*/PRD-Phase-*/POST-MORTEM-*/INCIDENT-*/INVESTIGATION*/HANDOFF*/HANDOVER*/RCA*/GH-*). Ambiguous -- ask Gregg rather than guess.`,
    };
  }

  if (notebookId === NOTEBOOKS["01_raw"]) {
    if (segments.length === 1) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `01_raw writes are restricted to a single top-level doc (no subfolders) -- "${hpath}" has ${segments.length} path segments. File one doc directly under 01_raw.`,
    };
  }

  return {
    ok: false,
    reason: `This connector has no write scope defined for notebook ${notebookId}. Only 00_ops (PRD/planning/Kanban/WB Scratchpad) and 02_wiki root planning-doc patterns are in scope.`,
  };
}

// Heuristic match against the Fact Card schema (content/type/entities/confidence/importance/source/relations).
// A hpath inside an allowlisted folder is still rejected if the body itself is fact-card-shaped --
// path-based scoping alone doesn't catch a fact card someone tries to drop in the wrong place.
const FACT_CARD_FIELD_RE = /^\*\*?\s*(content|type|entities|confidence|importance|source|relations)\s*:?\*\*?/gim;

export function isFactCardShaped(markdown: string): boolean {
  const matches = markdown.match(FACT_CARD_FIELD_RE) ?? [];
  const distinctFields = new Set(matches.map((m) => m.toLowerCase()));
  return distinctFields.size >= 3;
}

// Constitution §3 (CLAUDE.md): the real trigger is a bare #-prefixed reference immediately preceded
// by punctuation. The practical, reliable defense is the blunter rule -- at most one bare #-prefixed
// reference per block -- rather than trying to detect the exact punctuation trigger in the moment.
// We approximate "block" as a blank-line-separated chunk of markdown, which is conservative (a real
// SiYuan block can be smaller than a paragraph) but never under-flags relative to the true unit.
const BARE_HASH_REF_RE = /#[^\s#]+#?/g;

export interface CorruptionRiskFinding {
  block: string;
  refCount: number;
}

export function findBareHashCorruptionRisk(markdown: string): CorruptionRiskFinding[] {
  const chunks = markdown.split(/\n\s*\n/);
  const findings: CorruptionRiskFinding[] = [];
  for (const chunk of chunks) {
    const matches = chunk.match(BARE_HASH_REF_RE) ?? [];
    if (matches.length > 1) {
      findings.push({ block: chunk.trim(), refCount: matches.length });
    }
  }
  return findings;
}
