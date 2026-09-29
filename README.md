# workbuddy

Connectors and extensions for [Tencent WorkBuddy](https://www.workbuddy.ai).

## `siyuan-mcp`

A local **stdio** MCP server that gives a WorkBuddy agent scoped, safety-checked access to a
self-hosted SiYuan vault — read anywhere, write only into a human-reviewed allowlist, with
every write read back and verified.

Full documentation, setup, and troubleshooting: **[`siyuan-mcp/README.md`](siyuan-mcp/README.md)**.

### Requirements

- Node.js >= 18.17
- **Any CPU architecture.** The connector is pure JavaScript with zero native dependencies,
  so there is deliberately no separate Intel and Apple Silicon build — the same `dist/` runs
  on both. See
  [Architecture: one build, not two](siyuan-mcp/README.md#architecture-one-build-not-two)
  for the one thing that *is* architecture-specific — the Node that launches the server — and
  what to do when it breaks after a machine migration.

### Quick start

```bash
git clone https://github.com/greggchen308/workbuddy.git
cd workbuddy/siyuan-mcp
npm install
npm run build

SIYUAN_API_URL=https://your-siyuan.example \
SIYUAN_API_TOKEN=<your token> \
node doctor.mjs
```

`doctor.mjs` is a one-shot preflight: it checks the Node runtime, the architecture of the
Node WorkBuddy will actually spawn, your `mcp.json` entry, and live API connectivity. Exit
code `0` means usable; `1` means it will not load, and the failing line says why.

Then register the server in WorkBuddy's `mcp.json` — see
[WorkBuddy configuration](siyuan-mcp/README.md#workbuddy-configuration).

## License

MIT — see [LICENSE](LICENSE).
