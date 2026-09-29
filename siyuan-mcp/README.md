# workbuddy-siyuan-mcp

A local **stdio** MCP server that gives a Tencent WorkBuddy agent scoped access to Gregg's
SiYuan vault at `gcnotes.zeabur.app`, without handing it the raw full-scope SiYuan API token
or letting it improvise around the write-safety rules in the `zeaburvps` repo's `CLAUDE.md`
and `.claude/skills/siyuan-architect/`.

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
  - **Hard-blocked, no exceptions:** `02_wiki`'s ontology folders (`Entity/`, `Concept/`,
    `Url/`, `Event/`, `Decision/`, `Configs/`, `Date/`, `Summary/`, `Decisions/`,
    `general/`), fact-card-shaped content (checked by field-shape, not just path),
    the named protected pages, and **`01_raw` entirely** — see "Not implemented yet" below.
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
- **Asset writes go through `putFile`, never `asset/upload`** — `siyuan_write_asset` wraps
  `/api/file/putFile` because `/api/asset/upload` is a **confirmed silent no-op** on this
  deployment (HTTP 200, `code:0`, `succFiles: []`, no error ever raised, across every multipart
  variant tested). Because of that — and because `filetree/removeDoc` turned out to be a second
  silent no-op — this connector treats **`code:0` as insufficient evidence**: every asset write is
  read back with `/api/file/getFile` and SHA-256 compared, falling back to a `readDir` presence
  check only if the read-back call itself fails, and the response always states which verification
  was used. Refuses path separators/traversal/control chars/leading dots, refuses extensions
  outside a media allowlist (`svg` excluded — assets are served from the vault's own origin and SVG
  can carry script), and refuses to overwrite an existing asset unless `overwrite: true`.
  Full evidence: SiYuan doc `20260917130056-wxxj67h`.
- **Kanban filing runs the full documented flow** (read-increment-verify the shared incident
  counter → create card → bind to board → resolve the real `itemID` → optional Details/Status),
  not a raw single API call a proprietary agent could get half-right.

## Not implemented yet (by design)

**`01_raw` ingestion** is out of scope for this v1. Gregg described this as a longer-horizon,
"visionary" capability with ingestion rules that aren't defined yet. Writing to `01_raw`
without those rules would mean improvising them in code — exactly the kind of guessing this
connector exists to prevent elsewhere. `checkWriteScope` in `src/scope.ts` explicitly refuses
any `01_raw` write with a message pointing here, rather than silently allowing it. Wire it up
once the ingestion rules (required `Status: [Unprocessed]` marker, dedupe behavior, etc.) are
actually specified.

**Delete/remove operations** — not implemented, matching `siyuan-architect`'s own scoping:
delete-class actions go through a human review step, not an autonomous tool call.

## Requirements

- **Node.js >= 18.17** (`package.json` `engines`; Node 20 or 22 LTS recommended).
- **Any CPU architecture.** This connector is pure JavaScript with zero native
  dependencies — see "Architecture: one build, not two" below. There is deliberately no
  separate Intel and Apple Silicon build, because the two would be byte-identical.

## Setup

```bash
cd siyuan-mcp
npm install
npm run build
```

This produces `dist/index.js`. Note its absolute path.

Verify before wiring it into WorkBuddy — `doctor.mjs` checks the runtime, the
architecture of the Node WorkBuddy will actually spawn, your `mcp.json` entry, and live
connectivity in one pass:

```bash
SIYUAN_API_URL=https://gcnotes.zeabur.app \
SIYUAN_API_TOKEN=<your SiYuan API token> \
node doctor.mjs
```

Exit code `0` means usable; `1` means it will not load, and the failing line says why.

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
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/siyuan-mcp/dist/index.js"],
      "env": {
        "SIYUAN_API_URL": "https://gcnotes.zeabur.app",
        "SIYUAN_API_TOKEN": "<your SiYuan API token>"
      },
      "disabled": false
    }
  }
}
```

**Use an absolute path for `command`, not the bare `"node"`.** A bare `node` resolves
through `PATH`, and WorkBuddy's own managed Node is not always the one you expect — on
macOS the failure is silent (the connector simply never appears in the tool list, with no
error surfaced). An absolute path removes that whole class of problem. Find yours with
`which -a node` and pick one `doctor.mjs` reports as native to your architecture.

WorkBuddy launches and manages the process itself — there is no manual step. Get your
SiYuan API token from SiYuan's own Settings → About panel if you don't already have it
noted down; it's the same token this repo's cloud environment uses as `$SIYUAN_API_TOKEN`.

> Your pasted example had a live-looking Exa API key exposed in it (a markdown link that got
> flattened on copy). If you haven't already, rotate that key in your Exa dashboard — treat
> anything pasted into a chat as potentially logged.

## Tools exposed

**Read (unrestricted):** `siyuan_sql_query`, `siyuan_get_block_kramdown`,
`siyuan_get_child_blocks`, `siyuan_get_ids_by_hpath`, `siyuan_full_text_search`,
`siyuan_list_notebooks`, `siyuan_export_md`.

**Write (scope-checked, see above):** `siyuan_create_doc`, `siyuan_append_block`,
`siyuan_update_child_block`.

**Assets (writes files, no doc-scope check — assets are global to the vault, not notebook-scoped):**
`siyuan_write_asset`. Writes an image/media file into `/data/assets/` and returns the
`assets/<name>` reference string to paste into markdown. Takes the bytes as either
`contentBase64` or `localPath`. Added 2026-09-17 to replace the ad-hoc inline Python that
`putFile` used to require. There is deliberately **no delete counterpart**.

**Kanban ("OpenClaw Open Backlog" board):** `siyuan_kanban_read_board`,
`siyuan_kanban_file_card`, `siyuan_kanban_set_status`.

## Architecture: one build, not two

**There is no Intel build and no Apple Silicon build. There is one build, and it is the
same file on both.**

Worth stating explicitly, because the symptom is misleading. This project compiles
TypeScript to plain ES2022 JavaScript and depends only on `@modelcontextprotocol/sdk` and
`zod`. Verified against the lockfile: **98 packages, zero native modules** — no `cpu`/`os`
constraints, no install scripts, no `node-gyp`, no `.node` bindings. `tsc` output is
byte-identical on x86_64 and arm64, so two artifacts would be the same bytes twice.

What *is* architecture-specific is the **Node binary that launches the server**, and that
is not something this repo ships. WorkBuddy spawns stdio MCP servers with its own managed
Node (`$CODEBUDDY_NODE_BIN`). After migrating an Intel Mac to Apple Silicon, that binary
can still be x86_64; with no Rosetta 2 installed it dies with `Bad CPU type in executable`
before the server starts, and WorkBuddy shows the connector as simply absent. No amount of
rebuilding this repo fixes that — the fix is on the runtime side.

Two ways out, in order of preference:

1. **Point `command` at a native Node** (see the config above). `/usr/local/bin/node` is a
   universal binary on most macOS installs and works on either architecture. Quick fix, no
   reinstall.
2. **Re-provision WorkBuddy's managed runtimes for arm64.** The managed Node *and* the
   managed Python are both affected — after the 2026-09-29 migration, every binary under
   `~/.workbuddy-ai/binaries` was still x86_64.

`doctor.mjs` reports exactly which of these you are in.

> Installing Rosetta 2 (`softwareupdate --install-rosetta --agree-to-license`) makes the
> x86_64 binaries run again and is a legitimate immediate unblock, but it means running the
> whole toolchain translated. Prefer a native Node where you have the choice.

## Smoke testing

`smoke-test.mjs` spawns the built server exactly as WorkBuddy would, lists tools, and
exercises the guards against the real vault. Run it after any change to `src/`:

```bash
npm run build && node smoke-test.mjs
```

It resolves `dist/index.js` relative to its own location, so it runs from any checkout.

**A default run is write-free.** It covers the negative paths — a deliberately out-of-scope
write that must be refused, a corruption-risk write that must be refused, `update_child_block`
against a document root (F1) and against a heading with bare text (F6), append to a non-root
block, and four asset refusals (traversal, excluded `svg`, missing extension, both inputs
supplied) — plus a real asset write of a 74-byte PNG that is independently hash-verified
against `/api/file/getFile` and **deleted again** at the end via a direct kernel call, so no
test assets accumulate. It also asserts the flush-before-query ordering in `siyuanClient`.

The happy-path append is gated behind `--live-write` and is **off by default**, because the
connector has no delete tool by design: a live append cannot be undone by the script and
leaves residue only a human can remove in the SiYuan UI. Five earlier runs had left ten stray
blocks on `WB Scratchpad` before this gate was added. Only pass `--live-write` when you
actually need to exercise the write path and are prepared to clean up afterwards.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point. Validates env, registers tool groups, connects the stdio transport. |
| `src/scope.ts` | The write-scope policy — allowed paths, hard-blocked folders, fact-card shape check. |
| `src/siyuanClient.ts` | Kernel HTTP client, including flush-before-query and the bounded flush/circuit breaker. |
| `src/corruption.ts` | The `#`-reference tag-misparse guard. |
| `src/tools/read.ts` | The 7 read tools. |
| `src/tools/write.ts` | `create_doc`, `append_block`, `update_child_block` — scope-checked and read-back verified. |
| `src/tools/assets.ts` | `siyuan_write_asset` — `putFile` + SHA-256 read-back. No delete counterpart, by design. |
| `src/tools/kanban.ts` | The 3 "OpenClaw Open Backlog" board tools. |
| `doctor.mjs` | Preflight: runtime, Node architecture, `mcp.json`, live connectivity. |
| `smoke-test.mjs` | Live guard/behaviour harness. Write-free by default. |

`dist/` and `node_modules/` are gitignored — build locally with `npm run build`.

## Keeping this in sync

`src/scope.ts` and `src/tools/kanban.ts` mirror
`.claude/skills/siyuan-architect/reference/write-scope.md` and `kanban-board.md` by hand —
there's no automated sync. If Gregg changes the human-reviewed scope or the board's live IDs
(counter block, AV/view IDs, status options), update both the skill's reference doc and this
connector's constants together.

This directory is developed inside the private `zeaburvps` repo at
`connectors/workbuddy-siyuan-mcp/` and published here. Keep the two in step.
