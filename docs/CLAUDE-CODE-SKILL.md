# Claude Code Call Skill — superseded

> **This approach has been replaced by the [MCP server](MCP-SERVER.md).**

This document used to describe a Python-based Claude Code *skill* that wrapped
the outbound-call API, so you could say "call me when the backup finishes".

That capability now ships as a proper **MCP server** (`mcp-server/`), which is
better in every way that matters here:

| | Old skill | MCP server |
|---|---|---|
| Integration | Python script invoked by a skill | Native MCP tools |
| Discovery | Claude had to be told it existed | Advertised via `tools/list` |
| Errors | Raised as script output | Returned as tool errors Claude can act on |
| Install | Copy files into a skills directory | `claude mcp add` |
| Status/hangup | Manual HTTP calls | `call_status`, `hangup` tools |

## Use this instead

```bash
cd mcp-server && npm install

claude mcp add claude-phone --scope user \
  --env PHONE_DEFAULT_TO=17510 \
  -- node /absolute/path/to/mcp-server/index.js
```

Restart Claude Code, then just ask:

> "Run the migration and call me if anything needs a decision."

Full documentation: **[MCP-SERVER.md](MCP-SERVER.md)**.

## If you still want the old skill

It remains in git history. To recover it:

```bash
git log --oneline -- docs/CLAUDE-CODE-SKILL.md
git show <commit>:docs/CLAUDE-CODE-SKILL.md > old-skill.md
```

The underlying HTTP API it called (`POST /api/outbound-call`) is unchanged and
still supported — see [../voice-app/README-OUTBOUND.md](../voice-app/README-OUTBOUND.md).
