<#
.SYNOPSIS
    AstroOM launcher (Windows).

.DESCRIPTION
    Applies the same tuned policy argv as astro_launcher.bash and runs the
    astroom.exe binary. Any arguments you pass are appended *last* so they
    override the defaults.

    This launcher does not change the working directory. Path resolution
    belongs to the executable, which locates config/, prompts/ and sysprompts/
    relative to its own location. Calling Set-Location here would mask that and
    would break any relative path you pass through.

    Credentials come from a .env file next to this script, or from the
    environment if it is already set. The .env format matches the bash
    launcher: NAME=VALUE per line, '#' comments, and one optional layer of
    surrounding double quotes.

.PARAMETER ForwardArgs
    Arguments forwarded to astroom, appended after the policy defaults.

.EXAMPLE
    .\astro_launcher.ps1

.EXAMPLE
    .\astro_launcher.ps1 --batch 50 --results-wanted 500 --clean
#>

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ForwardArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Script directory
# ---------------------------------------------------------------------------
# $PSScriptRoot is the script's own directory, always absolute, and unaffected by
# where the caller happened to be. Prefer it over $PWD, and never assemble paths
# by string concatenation: Join-Path keeps spaces and Unicode correct.
$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
$scriptDir = (Resolve-Path -LiteralPath $scriptDir).ProviderPath

function Write-Step { param([string] $Message) Write-Host ":: $Message" }

function Stop-WithError {
    param([string] $Message, [string[]] $Hint = @())
    Write-Host "astro_launcher: $Message" -ForegroundColor Red
    foreach ($line in $Hint) { Write-Host "  $line" }
    exit 1
}

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------
# Bash `source` executes; PowerShell must parse. Reading the file line by line
# and splitting on the first '=' avoids evaluating anything as code, and avoids
# the quoting and command-substitution surprises of `Invoke-Expression`.
function Read-DotEnv {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }

    Write-Step "sourcing $Path"
    foreach ($rawLine in [System.IO.File]::ReadAllLines($Path)) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0) { continue }
        if ($line.StartsWith('#')) { continue }

        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }

        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()

        # Strip one layer of matching double quotes, matching the bash launcher.
        if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        Set-Item -Path "Env:$name" -Value $value
    }
    Write-Step "...sourced $Path"
}

# ---------------------------------------------------------------------------
# Binary discovery
# ---------------------------------------------------------------------------
function Resolve-AstroomBinary {
    $candidates = New-Object System.Collections.Generic.List[string]

    if ($env:ASTROOM_BIN) { $candidates.Add($env:ASTROOM_BIN) }
    $candidates.Add((Join-Path $scriptDir 'astroom.exe'))
    $candidates.Add((Join-Path $scriptDir (Join-Path 'bin' 'astroom.exe')))
    $candidates.Add((Join-Path $scriptDir (Join-Path '..' (Join-Path 'bin' 'astroom.exe'))))
    $candidates.Add((Join-Path $scriptDir (Join-Path 'target' (Join-Path 'release' 'astroom.exe'))))
    $candidates.Add((Join-Path $scriptDir (Join-Path 'target' (Join-Path 'debug' 'astroom.exe'))))
    $candidates.Add((Join-Path $scriptDir (Join-Path 'target' (Join-Path 'x86_64-pc-windows-gnu' (Join-Path 'release' 'astroom.exe')))))

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            # Canonicalise so spaces and Unicode in the install path are safe to
            # pass to the process.
            return (Resolve-Path -LiteralPath $candidate).ProviderPath
        }
    }

    $onPath = Get-Command -Name 'astroom.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($onPath) { return $onPath.Source }

    return $null
}

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
Read-DotEnv (Join-Path $scriptDir '.env')

# Resolved before anything destructive, so a missing binary never costs you the
# previous run's logs.
$binary = Resolve-AstroomBinary
if (-not $binary) {
    Stop-WithError 'could not find the astroom binary.' @(
        'Searched, in order:',
        '  $env:ASTROOM_BIN',
        "  $(Join-Path $scriptDir 'astroom.exe')",
        "  $(Join-Path $scriptDir '..\bin\astroom.exe')",
        "  $(Join-Path $scriptDir 'target\release\astroom.exe')",
        "  $(Join-Path $scriptDir 'target\x86_64-pc-windows-gnu\release\astroom.exe')",
        '  astroom.exe on PATH',
        '',
        'Build one with:  cargo build --release --target x86_64-pc-windows-gnu',
        'or set $env:ASTROOM_BIN to its full path.'
    )
}

$apiKey = $env:AOM_OR_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Stop-WithError "AOM_OR_API_KEY is not set. Add it to $(Join-Path $scriptDir '.env') before running LLM stages."
}

# Log cleanup. `Remove-Item` is used rather than a shell glob so hidden files
# and paths containing spaces behave predictably on every PowerShell edition.
if ($env:AOM_CLEAN_LOGS -ne '0') {
    $logDir = Join-Path $scriptDir 'logs'
    Write-Step "cleaning $logDir"
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $logDir -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Step "...cleaned $logDir"
}

# ---------------------------------------------------------------------------
# Policy argv
# ---------------------------------------------------------------------------
# Mirrors astro_launcher.bash exactly. A List[string] is used rather than a
# string so that every element reaches the process as one argument: spaces,
# quotes and Unicode survive without any manual escaping.
$profileDir = if ($env:AOM_PROFILE_DIR) {
    $env:AOM_PROFILE_DIR
} elseif (Test-Path -LiteralPath (Join-Path $scriptDir 'candidate_data') -PathType Container) {
    Join-Path $scriptDir 'candidate_data'
} elseif (Test-Path -LiteralPath (Join-Path $scriptDir 'michael_martini_data') -PathType Container) {
    Join-Path $scriptDir 'michael_martini_data'
} else {
    Join-Path $scriptDir 'candidate_data'
}

$argsList = [System.Collections.Generic.List[string]]::new()
function Add-Pair { param([string] $Flag, [string] $Value) $argsList.Add($Flag); $argsList.Add($Value) }

$argsList.Add('run-pipeline')
Add-Pair '--job-provider' 'indeed,linkedin'
Add-Pair '--search-terms-file' (Join-Path $profileDir 'search_terms.txt')
Add-Pair '--api-key' $apiKey
Add-Pair '--jobcloth-preset' 'jc_glm-5.3-flash'
Add-Pair '--remoteeval-preset' 're_glm-5.3-flash'
Add-Pair '--jobjudge-preset' 'jep_glm-5.3-flash'
Add-Pair '--makematerials-preset' 'rop_glm-5.3-flash'
Add-Pair '--batch' '10';    Add-Pair '--sleep' '2'
Add-Pair '--results-wanted' '200'; Add-Pair '--hours-old' '24'
Add-Pair '--jc-provider' 'astro_auto_provider'; Add-Pair '--jc-provider-quant' 'fp8'; Add-Pair '--jc-reasoning-effort' 'low'
Add-Pair '--re-provider' 'astro_auto_provider'; Add-Pair '--re-provider-quant' 'fp8'; Add-Pair '--re-reasoning-level' 'high'
Add-Pair '--jj-provider' 'astro_auto_provider'; Add-Pair '--j-provider-quant' 'fp8'; Add-Pair '--jj-reasoning-effort' 'high'
Add-Pair '--mm-provider' 'astro_auto_provider'; Add-Pair '--mm-provider-quant' 'fp8'; Add-Pair '--mm-reasoning-effort' 'high'
Add-Pair '--astro_auto_provider-top' '3'
Add-Pair '--remote-only' 'true'
foreach ($flag in @('--track-or-costs', '--internet-watchdog', '--log-cool-offs')) { $argsList.Add($flag) }

# Optional explicit directory redirection, passed as absolute paths so they are
# unambiguous regardless of the caller's working directory.
if ($env:AOM_DATA_DIR) { Add-Pair '--data-dir' $env:AOM_DATA_DIR }
if ($env:AOM_LOG_DIR) { Add-Pair '--log-dir' $env:AOM_LOG_DIR }
if ($env:AOM_MATERIALS_DIR) { Add-Pair '--materials-dir' $env:AOM_MATERIALS_DIR }
if ($env:AOM_PROFILE_DIR) { Add-Pair '--profile-dir' $env:AOM_PROFILE_DIR }

if ($env:AOM_CLEAN -eq '1') { $argsList.Add('--clean') }
if ($env:AOM_DEPLOY -eq '1') {
    if ([string]::IsNullOrWhiteSpace($env:AOM_DEPLOY_DESTINATION)) {
        Stop-WithError 'AOM_DEPLOY is set but AOM_DEPLOY_DESTINATION is empty.' @(
            'For example: AOM_DEPLOY_DESTINATION="GoogleDrive:/autoJobGen-src"'
        )
    }
    # `--deploy` is a bare flag: it accepts an optional value defaulting to true.
    $argsList.Add('--deploy')
    Add-Pair '--deploy-destination' $env:AOM_DEPLOY_DESTINATION
}

# Caller-supplied arguments go last so they override the policy defaults.
if ($ForwardArgs) { foreach ($extra in $ForwardArgs) { $argsList.Add($extra) } }

Write-Step "exec $binary run-pipeline ..."

# ---------------------------------------------------------------------------
# Invocation
# ---------------------------------------------------------------------------
# The call operator (`&`) passes the array as discrete arguments with no
# re-parsing, and the process replaces this shell's console so Ctrl+C reaches
# astroom directly. $LASTEXITCODE then carries astroom's own exit code, which
# includes the 130/143 that Ctrl+C and SIGTERM-style termination produce.
& $binary @argsList
exit $LASTEXITCODE
