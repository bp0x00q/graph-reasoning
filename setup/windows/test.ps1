#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$PluginPath,
    [string]$Neo4jHttpUrl = 'http://127.0.0.1:7474',
    [string]$Neo4jDatabase = 'neo4j',
    [switch]$SkipIntegration
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 20 or newer is required, but node.exe was not found in PATH.'
}

$PackageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $PluginPath) {
    $PluginPath = $PackageRoot
}

$Verifier = Join-Path $PackageRoot 'scripts\verify.mjs'
$NodeArguments = @(
    $Verifier,
    '--plugin-root', $PluginPath,
    '--neo4j-http-url', $Neo4jHttpUrl,
    '--neo4j-database', $Neo4jDatabase
)
if ($SkipIntegration) {
    $NodeArguments += '--skip-integration'
}

& $node.Source @NodeArguments
if ($LASTEXITCODE -ne 0) {
    throw "Graph Reasoning verification failed with exit code $LASTEXITCODE."
}
