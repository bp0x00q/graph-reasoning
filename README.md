# Graph Reasoning for Codex

Graph Reasoning is a local Codex plugin that performs explicit branch-and-backtrack reasoning inside Neo4j. Codex forms materially different hypotheses or approaches, records concise reasoning objects and evidence in the graph, explores branches, backtracks when a path fails, and synthesizes supported findings.

Neo4j is the authoritative explicit reasoning state. The graph is not a post-hoc transcript, and the system does not attempt to expose hidden token-level chain of thought.

## Architecture

```text
Codex
  |
  | MCP over local STDIO
  v
Graph Reasoning MCP server (Node.js)
  |
  | Neo4j transactional HTTP API on localhost
  v
Local Neo4j database
```

The MCP server and reasoning behavior are identical on Windows and Linux. Only the setup wrappers differ, and both wrappers call the same shared Node implementation under `scripts/`.

## Requirements

- Node.js 20 or newer in `PATH`
- A local Neo4j 5 database with HTTP enabled on loopback
- A Codex host that supports local STDIO MCP servers and plugins
- Windows 10/11 with PowerShell 5.1+, or a Linux system with Bash

No npm installation or container runtime is used. The MCP server depends only on Node.js built-ins.

## Package layout

```text
graph-reasoning/
├── .codex-plugin/plugin.json
├── .mcp.json
├── skills/
├── server/
├── scripts/                 # Shared implementation for both operating systems
├── setup/
│   ├── windows/
│   └── linux/
├── neo4j/
├── tests/
└── .github/workflows/ci.yml
```

## Prepare Neo4j

Graph Reasoning expects a private, local Neo4j instance without authentication. Add these settings to the active `neo4j.conf`, then restart Neo4j:

```text
dbms.security.auth_enabled=false
server.default_listen_address=127.0.0.1
server.http.enabled=true
```

A copy is provided at `neo4j/neo4j.conf.snippet`.

### Windows

For Neo4j Desktop, edit the selected DBMS configuration in Desktop and restart that DBMS.

For a native ZIP or service installation, set `NEO4J_HOME` or provide the configuration path:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup\windows\configure-neo4j.ps1
```

```powershell
.\setup\windows\configure-neo4j.ps1 `
    -ConfigPath 'C:\Neo4j\neo4j-community\conf\neo4j.conf'
```

### Linux

For a package installation using `/etc/neo4j/neo4j.conf`:

```bash
sudo ./setup/linux/configure-neo4j.sh --config /etc/neo4j/neo4j.conf
sudo systemctl restart neo4j
```

For an extracted Neo4j distribution:

```bash
export NEO4J_HOME=/opt/neo4j
./setup/linux/configure-neo4j.sh
"$NEO4J_HOME/bin/neo4j" restart
```

## Install

Extract the ZIP first, then run the installer for the current operating system.

### Windows

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup\windows\install.ps1
```

### Linux

```bash
chmod +x setup/linux/*.sh
./setup/linux/install.sh
```

Both installers:

- verify Node.js 20 or newer;
- copy the plugin to the current user's `.codex/plugins/graph-reasoning` directory;
- update the Neo4j endpoint in `.mcp.json`;
- create or merge the Graph Reasoning entry in `.agents/plugins/marketplace.json` without removing other entries.

Custom settings use the shared option names:

```powershell
.\setup\windows\install.ps1 `
    -Neo4jHttpUrl 'http://127.0.0.1:7475' `
    -Neo4jDatabase 'neo4j'
```

```bash
./setup/linux/install.sh \
  --neo4j-http-url http://127.0.0.1:7475 \
  --neo4j-database neo4j
```

A personal marketplace entry must point to a plugin beneath the current user's home directory. For an external install root, use `-SkipMarketplace` on Windows or `--skip-marketplace` on Linux and register that location manually.

Restart the Codex or ChatGPT host after installation, then enable **Graph Reasoning** from the personal plugin marketplace. Copy `AGENTS.md.snippet` into a target repository's `AGENTS.md` when automatic activation is desired for nontrivial tasks.

## Verify

### Windows

```powershell
& "$HOME\.codex\plugins\graph-reasoning\setup\windows\test.ps1"
```

Skip only the live Neo4j test:

```powershell
& "$HOME\.codex\plugins\graph-reasoning\setup\windows\test.ps1" -SkipIntegration
```

### Linux

```bash
~/.codex/plugins/graph-reasoning/setup/linux/test.sh
```

Skip only the live Neo4j test:

```bash
~/.codex/plugins/graph-reasoning/setup/linux/test.sh --skip-integration
```

The complete verifier performs JavaScript syntax checks, all unit and protocol tests, an MCP STDIO handshake, and a live Neo4j branch/backtrack smoke test.

## Manual MCP fallback

The plugin bundles `.mcp.json`. Use manual registration only when the host does not load it.

### Windows PowerShell

```powershell
$Server = Join-Path $HOME '.codex\plugins\graph-reasoning\server\index.mjs'
codex mcp add graph-reasoning `
  --env NEO4J_HTTP_URL=http://127.0.0.1:7474 `
  --env NEO4J_DATABASE=neo4j `
  -- node $Server
```

### Linux

```bash
codex mcp add graph-reasoning \
  --env NEO4J_HTTP_URL=http://127.0.0.1:7474 \
  --env NEO4J_DATABASE=neo4j \
  -- node "$HOME/.codex/plugins/graph-reasoning/server/index.mjs"
```

## MCP tools

| Tool | Purpose |
|---|---|
| `reasoning_start` | Create or resume a reasoning run and return the active graph projection. |
| `reasoning_inspect` | Read active context, frontier, one branch, history, or the audit view. |
| `reasoning_advance` | Add typed observations, assumptions, evidence, experiments, inferences, contradictions, or conclusions. |
| `reasoning_branch` | Create a graph branch point with materially distinct alternatives generated by Codex. |
| `reasoning_backtrack` | Return to an earlier branch point, preserve history, invalidate failed dependencies when appropriate, and enter another path. |
| `reasoning_integrate` | Synthesize compatible supported findings from multiple branches. |
| `reasoning_finish` | Run the graph audit and return supported conclusions, rejected paths, unresolved items, and branch coverage. |

## Reasoning model

The compact Neo4j model uses:

```text
(:Run)
(:State)
(:BranchPoint)
(:Branch)
(:ReasoningNode)
```

`ReasoningNode.kind` may be `observation`, `question`, `hypothesis`, `assumption`, `constraint`, `experiment`, `evidence`, `inference`, `contradiction`, `conclusion`, or `uncertainty`.

Backtracking never deletes a failed path. It changes graph status and active context, invalidates branch-local claims that depended on the failed premise, retains independently valid evidence, and moves the reasoning frontier to another path.

## Development checks

No dependency installation is required:

```bash
npm run check
```

A live local Neo4j instance is required only for:

```bash
npm run test:integration
```

The included CI workflow runs the dependency-free unit, protocol, package-layout, syntax, Bash, and PowerShell parser checks on both Windows and Linux.

## Publication status

This archive is repository-ready but is not a Git repository. Before publishing it, complete `PUBLICATION-CHECKLIST.md`, especially the license, author, repository URL, and a live Neo4j test on both operating systems.
