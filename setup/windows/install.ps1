#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $HOME '.codex\plugins'),
    [string]$Neo4jHttpUrl = 'http://127.0.0.1:7474',
    [string]$Neo4jDatabase = 'neo4j',
    [switch]$SkipMarketplace
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 20 or newer is required, but node.exe was not found in PATH.'
}

$PackageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$Installer = Join-Path $PackageRoot 'scripts\install.mjs'
$NodeArguments = @(
    $Installer,
    '--source', $PackageRoot,
    '--install-root', $InstallRoot,
    '--neo4j-http-url', $Neo4jHttpUrl,
    '--neo4j-database', $Neo4jDatabase
)
if ($SkipMarketplace) {
    $NodeArguments += '--skip-marketplace'
}

& $node.Source @NodeArguments
if ($LASTEXITCODE -ne 0) {
    throw "Graph Reasoning installation failed with exit code $LASTEXITCODE."
}
