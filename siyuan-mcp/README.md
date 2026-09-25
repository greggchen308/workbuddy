# workbuddy-siyuan-mcp

A local **stdio** MCP server that gives a Tencent WorkBuddy agent scoped access to Gregg's
SiYuan vault at `gcnotes.zeabur.app`, without handing it the raw full-scope SiYuan API token
or letting it improvise around the write-safety rules in the `zeaburvps` repo's `CLAUDE.md`
and `.claude/skills/siyuan-architect/`.

> Moved here from `zeaburvps/connectors/workbuddy-siyuan-mcp` on 2026-09-25. The
> write-safety source of truth (`CLAUDE.md` §3/§8/§14, `.claude/skills/siyuan-architect/`)
> still lives in the `zeaburvps` repo — `src/scope.ts` and `src/tools/kanban.ts` here mirror
> it by hand, now across repos, see "Keeping this in sync" below.

It runs on your Mac, spawned by WorkBuddy itself (you never run it manually), and talks
directly to your SiYuan instance over HTTPS. No new public endpoint is created.

## What it enforces (not just documents)

- **Read** — unrestricted, anywhere in the vault.
- **Write** — allowed only into:
  - `00_ops`'s `01 PRDs & Reviews`, `02 Incidents & RCAs`, `03 Investigations & Audits`,
    `04 GitHub Issues`, `05 Handovers & Reports` (including the Kanban board), and
    `WB Scratchpad` (a free-form drop folder, created 2026-09-01, doc ID
    `20260901140545-1vmnvz1`)
  - `02_wiki` root docs matching a known planning-doc naming convention (`PHASE*`,
    `PRD-Phase-*`, `POST-MORTEM-*`, `INCIDENT-*`, `INVESTIGATION*`, `HANDOFF*`,
    `HANDOVER*`, `RCA*`, `GH-*`)
  - `01_raw` — a single top-level doc only (no subfolders), and only when the markdown
    contains the literal marker `Status: [Unprocessed]` (see "01_raw ingestion" below)
  - **Hard-blocked, no exceptions:** `02_wiki`'s ontology folders (`Entity/`, `Concept/`,
    `Url/`, `Event/`, `Decision/`, `Configs/`, `Date/`, `Summary/`, `Decisions/`,
    `general/`), fact-card-shaped content (checked by field-shape, not just path),
    and the named protected pages.
- **Never `updateBlock` a document root** — hard-refused in code (this was the 2026-07-23
  incident: a raw root update wiped a 13k-char PRD to 3 lines).
- **Never raw `insertBlock`** — appends go through `appendBlock` only.
- **Tag-misparse corruption guard (CLAUDE.md §3)** — refuses to write any block containing
  more than one bare `#`-prefixed reference, and re-reads every write afterward to scan for
  the confirmed `#` + U+200B corruption signature. A write that comes back corrupted is
  reported as a failure, never as success.
- **Fact-card shape guard** — refuses content that matches the Fact Card schema
  (`content`/`type`/`entities`/`confidence`/`importance`/`source`/`relations`), even inside
  an otherwise-allowed folder.
- **Every write is verified** — location (does it resolve back at the path you gave?) and
  content (does the read-back actually contain what you wrote?) before reporting success.
- **Kanban filing runs the full documented flow** (read-increment-verify the shared incident
  counter → create card → bind to board → resolve the real `itemID` → optional Details/Status),
  not a raw single API call a proprietary agent could get half-right.

## 01_raw ingestion (relaxed 2026-09-02)

Gregg authorized `01_raw` writes directly, based on his own knowledge of how the downstream
ingestion pipeline behaves — for the `siyuan-bilingual-ingest` skill (PRD, SiYuan doc
`20260902001622-km01ps3`). Scope: a single top-level doc directly under `01_raw` (no
subfolders — `checkWriteScope` in `src/scope.ts` refuses anything nested). Every such doc
must contain the literal marker `Status: [Unprocessed]` (PRD §8 C2) so downstream automation
can detect and queue it; `checkRawIngestMarker` (`src/scope.ts`) refuses the write otherwise,
checked before `siyuan_create_doc` runs. `WB Scratchpad` drops are unaffected and still exempt
from the marker. Dedupe behavior (near-identical source detection) is the calling skill's own
job (its FR1), not something this connector checks.

**Delete/remove operations** — not implemented, matching `siyuan-architect`'s own scoping:
delete-class actions go through a human review step, not an autonomous tool call.

## Setup

```bash
cd siyuan-mcp   # from this repo's root
npm install
npm run build
```

This produces `dist/index.js`. Note its absolute path.

## WorkBuddy configuration

Add a `stdio`-style entry (same shape as your existing Exa entry, but `command`/`args`
instead of `url`):

```json
{
  "mcpServers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp?exaApiKey=YOUR_KEY",
      "disabled": false
    },
    "siyuan": {
      "command": "node",
      "args": ["/absolute/path/to/workbuddy/siyuan-mcp/dist/index.js"],
      "env": {
        "SIYUAN_API_URL": "https://gcnotes.zeabur.app",
        "SIYUAN_API_TOKEN": "<your SiYuan API token>"
      },
      "disabled": false
    }
  }
}
```

WorkBuddy launches and manages the process itself — there is no manual step. Get your
SiYuan API token from SiYuan's own Settings → About panel if you don't already have it
noted down; it's the same token the `zeaburvps` repo's cloud environment uses as
`$SIYUAN_API_TOKEN`.

> Your pasted example had a live-looking Exa API key exposed in it (a markdown link that got
> flattened on copy). If you haven't already, rotate that key in your Exa dashboard — treat
> anything pasted into a chat as potentially logged.

## Tools exposed

**Read (unrestricted):** `siyuan_sql_query`, `siyuan_get_block_kramdown`,
`siyuan_get_child_blocks`, `siyuan_get_ids_by_hpath`, `siyuan_full_text_search`,
`siyuan_list_notebooks`, `siyuan_export_md`.

**Write (scope-checked, see above):** `siyuan_create_doc`, `siyuan_append_block`,
`siyuan_update_child_block`.

**Kanban ("OpenClaw Open Backlog" board):** `siyuan_kanban_read_board`,
`siyuan_kanban_file_card`, `siyuan_kanban_set_status`.

## Smoke testing

`smoke-test.mjs` spawns the built server exactly as WorkBuddy would, lists tools, and runs a
few live calls against the real vault (a read, a deliberately out-of-scope write that must be
refused, a deliberately corruption-risk write that must be refused, and one real append to
`WB Scratchpad`). Run it after any change to `src/`:

```bash
npm run build && node smoke-test.mjs
```

Note it does append a short "smoke test" line to `WB Scratchpad` each time it runs.

## Keeping this in sync

`src/scope.ts` and `src/tools/kanban.ts` mirror
`.claude/skills/siyuan-architect/reference/write-scope.md` and `kanban-board.md` by hand —
there's no automated sync. If Gregg changes the human-reviewed scope or the board's live IDs
(counter block, AV/view IDs, status options), update both the skill's reference doc and this
connector's constants together.
