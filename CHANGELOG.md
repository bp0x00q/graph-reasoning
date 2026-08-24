# Changelog

## 0.2.1 - 2026-08-24

- Fixed branch inspection on Neo4j 2026.07 by aggregating reasoning nodes before returning the branch map.
- Extended the live Neo4j smoke test to inspect a created branch and clean up its test run after both success and failure.
- Kept the bundled `.mcp.json` in the documented direct-server-map format while allowing setup and protocol verification to read direct maps, the documented `mcp_servers` wrapper, and legacy `mcpServers` wrappers.
- Cleared the MCP protocol smoke-test timeout after process exit while retaining a 90-second startup allowance.
- Added `.gitattributes` so shell, PowerShell, JavaScript, JSON, Markdown, YAML, and Cypher files retain LF endings across Windows and Linux checkouts.

## 0.2.0

- Consolidated the working Windows and Linux packages into one distribution.
- Added native Windows PowerShell and Linux Bash setup methods.
- Moved installation, Neo4j configuration, and verification behavior into shared dependency-free Node scripts to prevent operating-system drift.
- Removed the container-specific deployment path.
- Added cross-platform package tests, Windows/Linux CI, and publication guidance.

## 0.1.1

- Added the native Windows package and PowerShell setup flow.

## 0.1.0

- Initial graph-native branch-and-backtrack MCP implementation.
