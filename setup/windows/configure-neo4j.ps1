#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$Neo4jHome = $env:NEO4J_HOME
)

$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
    if (-not $Neo4jHome) {
        throw 'Supply -ConfigPath or set NEO4J_HOME before running this script.'
    }
    $ConfigPath = Join-Path $Neo4jHome 'conf\neo4j.conf'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 20 or newer is required, but node.exe was not found in PATH.'
}

$PackageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$Configurator = Join-Path $PackageRoot 'scripts\configure-neo4j.mjs'
& $node.Source $Configurator '--config' $ConfigPath
if ($LASTEXITCODE -ne 0) {
    throw "Neo4j configuration failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'Restart the Neo4j database before testing Graph Reasoning.' -ForegroundColor Cyan
if ($Neo4jHome) {
    Write-Host ('Native service command: & "{0}\bin\neo4j.ps1" restart' -f $Neo4jHome)
}
