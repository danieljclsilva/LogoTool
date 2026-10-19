# LogoTool Windows release-acceptance runner (operator script)
#
# SCOPE: Runs the repo's own acceptance commands on a Windows host and writes a
# portable local report. It does NOT install anything, does NOT change network
# state itself, and does NOT substitute bundled Chromium for branded Chrome.
#
# WHAT THIS TESTS: the SOURCE REPOSITORY here (developer setup: Node.js, npm
# dependencies, Playwright browsers). The DELIVERED customer files
# (OPEN_LOGO_CONFIGURATOR.html / hybrid ZIP) need NO installation, server,
# CDN, runtime, or network — just a browser over file://. Do not imply the
# customer package contains npm or project tooling; it does not.
#
# macOS (Chromium/installed-Chrome) runs are development evidence only — they are
# never Windows validation. The Windows Chrome/Edge file:// offline gate is
# UNTESTED until this script (or the equivalent manual steps in
# docs/release-acceptance.md) passes on an actual Windows host.
#
# PREREQUISITES (operator does these first, network ON allowed):
#   1. Unzip the delivered source package / clone the repo; cd to the repo root.
#   2. Install Node.js >= 22.18.0 and run `npm ci`.
#   3. One-time browser setup (may need network): `npx playwright install chromium`.
#      Branded Google Chrome and Microsoft Edge must be installed for their scopes.
#   4. THEN disable all networking (Airplane mode / unplug / Wi-Fi off) and
#      re-run this script with -NetworkDisabled to execute the branded scopes.
#
# USAGE (PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\run-windows-acceptance.ps1 -NetworkDisabled
#
# EXIT CODES: 0 = every executed scope PASSED and nothing is UNTESTED.
#             1 = at least one executed scope FAILED (incl. a missing branded
#                 browser for its scope — missing browser is a hard FAIL for that
#                 scope, never a silent skip and never a Chromium substitution).
#             2 = no FAIL, but at least one scope is UNTESTED (e.g. operator did
#                 not confirm networking is disabled, or a scope was not run),
#                 or this script was misused (non-Windows host, bad flags).
#
# NOTE: each Playwright scope writes its artifacts (test-results output dir +
# HTML report) to a per-scope subdirectory of the report dir, because every
# `npx playwright test` invocation otherwise cleans the previous run's
# artifacts. Per-scope text logs alone would lose screenshots, environment
# attachments, and failure evidence.

param(
  [string]$RepoRoot = "",
  [int]$Workers = 1,
  [switch]$NetworkDisabled,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Continue"

# This script is Windows-only: refusing anywhere else keeps results honest
# (a macOS/Linux run must never be mistaken for Windows acceptance).
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Write-Host "Refusing: scripts\run-windows-acceptance.ps1 must run on Windows (actual platform: $([System.Environment]::OSVersion.Platform)). macOS/Linux runs are development evidence only."
  exit 2
}
if ($Workers -lt 1 -or $Workers -gt 8) {
  Write-Host "Refusing: -Workers must be 1..8 (got $Workers). The release gate uses --workers=1; higher values are for operator triage only."
  exit 2
}

# ---- helpers ---------------------------------------------------------------

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "=== $Message ==="
}

function Find-BrandedBrowser([string]$AppName, [string[]]$RelPaths, [string]$RegPath) {
  foreach ($rel in $RelPaths) {
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LocalAppData)) {
      if ([string]::IsNullOrEmpty($base)) { continue }
      $candidate = Join-Path $base $rel
      if (Test-Path $candidate) { return $candidate }
    }
  }
  if ($RegPath -ne "") {
    try {
      $item = Get-ItemProperty -Path $RegPath -ErrorAction Stop
      $rawDefault = "$($item.'(default)')".Trim()
      if ($rawDefault -ne "") {
        if ($rawDefault.StartsWith('"')) {
          # Quoted form: "C:\path\app.exe" [args...] — take the quoted executable.
          $exe = ($rawDefault -split '"')[1]
        } else {
          # Unquoted form: a bare executable path (no argument splitting — the
          # whole value is the path, spaces included).
          $exe = $rawDefault
        }
        if ($exe -and (Test-Path $exe)) { return $exe }
      }
    } catch { }
  }
  try {
    $cmd = Get-Command $AppName -ErrorAction Stop
    if ($cmd -and $cmd.Source) { return $cmd.Source }
  } catch { }
  return $null
}

function Get-FileVersionSafe([string]$Path) {
  try { return (Get-Item $Path).VersionInfo.FileVersion } catch { return "unknown" }
}

function Invoke-Scope([string]$Name, [string]$LogFile, [string[]]$NpmArgs, [string]$ArtifactsDir = "", [string]$HtmlReport = "") {
  Write-Step $Name
  Write-Host "  command: npm $($NpmArgs -join ' ')"
  Write-Host "  log: $LogFile"
  if ($ArtifactsDir -ne "") { Write-Host "  artifacts: $ArtifactsDir" }
  # Fail closed: $LASTEXITCODE is only meaningful when the native command ran.
  # If npm itself is missing, the call throws — that is a FAIL, never a reuse
  # of a stale success code.
  $code = 1
  $invocationError = ""
  $savedHtmlReport = $env:PLAYWRIGHT_HTML_REPORT
  try {
    if ($ArtifactsDir -ne "") {
      New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
      # The caller already passed the single npm "--" separator; append only
      # the Playwright flag so it reaches `playwright test` verbatim.
      $NpmArgs = @($NpmArgs) + @("--output=$ArtifactsDir")
    }
    if ($HtmlReport -ne "") { $env:PLAYWRIGHT_HTML_REPORT = $HtmlReport }
    $env:PLAYWRIGHT_HTML_OPEN = "never"
    & npm.cmd @NpmArgs 2>&1 | Tee-Object -FilePath $LogFile | Out-Host
    $observed = $LASTEXITCODE
    if ($null -ne $observed) { $code = $observed }
  } catch {
    $invocationError = $_.Exception.Message
    $code = 1
  } finally {
    $env:PLAYWRIGHT_HTML_REPORT = $savedHtmlReport
  }
  if ($invocationError -ne "") {
    Write-Host "  RESULT: FAIL ($Name — npm invocation failed: $invocationError)"
    return "FAIL"
  }
  if ($code -eq 0) {
    Write-Host "  RESULT: PASS ($Name)"
    return "PASS"
  } else {
    Write-Host "  RESULT: FAIL ($Name, exit $code) — see $LogFile"
    return "FAIL"
  }
}

# ---- setup -----------------------------------------------------------------

if ([string]::IsNullOrEmpty($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrEmpty($OutDir)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) ("logotool-acceptance-" + $stamp)
}
# Resolve operator-supplied relative paths before changing directories. Nested
# Join-Path calls below also support stock Windows PowerShell 5.1, which has
# no AdditionalChildPath positional parameter.
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
try {
  New-Item -ItemType Directory -Force -Path $OutDir -ErrorAction Stop | Out-Null
  Set-Location -LiteralPath $RepoRoot -ErrorAction Stop
} catch {
  Write-Host "Refusing: could not prepare repository/report paths: $($_.Exception.Message)"
  exit 2
}

$results = @()  # array of @{ scope=; result=; detail= }

Write-Step "Environment"
$os = "unknown"
try {
  $osInfo = Get-CimInstance Win32_OperatingSystem
  $os = "$($osInfo.Caption) $($osInfo.Version) $($osInfo.OSArchitecture)"
} catch { }
$nodeVer = ""
try { $nodeVer = (& node -v 2>&1) } catch { $nodeVer = "NOT FOUND" }
$npmVer = ""
try { $npmVer = (& npm.cmd -v 2>&1) } catch { $npmVer = "NOT FOUND" }
$npmPresent = $false
try { $null = Get-Command npm.cmd -ErrorAction Stop; $npmPresent = $true } catch { $npmPresent = $false }
Write-Host "  OS: $os"
Write-Host "  repo: $RepoRoot"
Write-Host "  node: $nodeVer (required: >=v22.18.0 per package.json engines)"
Write-Host "  npm: $npmVer"
Write-Host "  network disabled confirmed by operator: $NetworkDisabled"
Write-Host "  report dir: $OutDir"

$envLines = @(
  "run_utc=$([DateTime]::UtcNow.ToString('o'))",
  "os=$os",
  "repo=$RepoRoot",
  "node=$nodeVer",
  "npm=$npmVer",
  "network_disabled_confirmed=$NetworkDisabled",
  "workers=$Workers",
  "expected_viewports=1280x900 + 390x844 (asserted inside the specs; recorded per-test in attachments)",
  "offline_enforcement=playwright.config.ts sets offline:true for every context; every browser test asserts zero console/page errors and zero HTTP(S) requests"
)
$envLines | Out-File -FilePath (Join-Path $OutDir "environment.txt") -Encoding utf8

# ---- prerequisites ---------------------------------------------------------

Write-Step "Prerequisites"
$prereqOk = $true
if ($nodeVer -eq "NOT FOUND") {
  Write-Host "  FAIL: node is not on PATH. Install Node.js >= 22.18.0, then re-run."
  $prereqOk = $false
} else {
  $m = [regex]::Match($nodeVer, "v(\d+)\.(\d+)\.(\d+)")
  if ($m.Success) {
    $major = [int]$m.Groups[1].Value; $minor = [int]$m.Groups[2].Value
    if (($major -lt 22) -or (($major -eq 22) -and ($minor -lt 18))) {
      Write-Host "  FAIL: node $nodeVer is below engines >=22.18.0."
      $prereqOk = $false
    } else {
      Write-Host "  node version OK: $nodeVer"
    }
  } else {
    Write-Host "  FAIL: could not parse node version '$nodeVer'; refusing to continue with an unverified toolchain."
    $prereqOk = $false
  }
}
if (-not $npmPresent) {
  Write-Host "  FAIL: npm.cmd not found on PATH. Install Node.js >= 22.18.0 (which ships npm), then re-run."
  $prereqOk = $false
} else {
  Write-Host "  npm present: $npmVer"
}
if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
  Write-Host "  FAIL: node_modules/ is missing. With network ON, run 'npm ci', then re-run this script."
  $prereqOk = $false
} else {
  Write-Host "  node_modules/ present."
}
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
  Write-Host "  FAIL: package.json not found under $RepoRoot. Pass -RepoRoot explicitly."
  $prereqOk = $false
}
if (-not $prereqOk) {
  $results += @{ scope = "prerequisites"; result = "FAIL"; detail = "see console output above" }
  "OVERALL: FAIL (prerequisites)" | Out-File -FilePath (Join-Path $OutDir "summary.txt") -Encoding utf8
  Write-Host ""
  Write-Host "OVERALL: FAIL (prerequisites not met). No scope was executed. Exit 1."
  exit 1
}

# ---- browser presence (checked now, enforced per scope) --------------------

$chromePath = Find-BrandedBrowser "chrome.exe" `
  @("Google\Chrome\Application\chrome.exe") `
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
$edgePath = Find-BrandedBrowser "msedge.exe" `
  @("Microsoft\Edge\Application\msedge.exe") `
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
$chromeVer = if ($chromePath) { Get-FileVersionSafe $chromePath } else { "MISSING" }
$edgeVer = if ($edgePath) { Get-FileVersionSafe $edgePath } else { "MISSING" }
Write-Host "  Google Chrome: $(if ($chromePath) { "$chromePath ($chromeVer)" } else { 'MISSING' })"
Write-Host "  Microsoft Edge: $(if ($edgePath) { "$edgePath ($edgeVer)" } else { 'MISSING' })"
"chrome_path=$chromePath" | Out-File -Append -FilePath (Join-Path $OutDir "environment.txt") -Encoding utf8
"chrome_version=$chromeVer" | Out-File -Append -FilePath (Join-Path $OutDir "environment.txt") -Encoding utf8
"msedge_path=$edgePath" | Out-File -Append -FilePath (Join-Path $OutDir "environment.txt") -Encoding utf8
"msedge_version=$edgeVer" | Out-File -Append -FilePath (Join-Path $OutDir "environment.txt") -Encoding utf8

# ---- automated scopes ------------------------------------------------------

$results += @{ scope = "npm run typecheck"; result = (Invoke-Scope "typecheck" (Join-Path $OutDir "typecheck.log") @("run", "typecheck")); detail = "typecheck.log" }
$results += @{ scope = "npm test (Node-only, builds first)"; result = (Invoke-Scope "node tests" (Join-Path $OutDir "npm-test.log") @("test")); detail = "npm-test.log" }
$results += @{ scope = "npm run test:e2e (bundled chromium)"; result = (Invoke-Scope "e2e chromium" (Join-Path $OutDir "e2e-chromium.log") @("run", "test:e2e", "--", "--workers=$Workers") (Join-Path (Join-Path $OutDir "artifacts") "e2e-chromium") (Join-Path (Join-Path $OutDir "artifacts") "e2e-chromium-report")); detail = "e2e-chromium.log + artifacts/e2e-chromium[/-report]" }

if (-not $NetworkDisabled) {
  Write-Step "Branded scopes SKIPPED — networking not confirmed disabled"
  Write-Host "  You ran without -NetworkDisabled. The branded Chrome/Edge scopes were NOT executed."
  Write-Host "  To execute them: disable ALL networking (Airplane mode ON, Wi-Fi off, Ethernet"
  Write-Host "  unplugged), then re-run with the -NetworkDisabled flag. The specs themselves run"
  Write-Host "  with offline contexts and assert zero HTTP(S) requests, but the host must be"
  Write-Host "  offline for the result to count as offline acceptance."
  $results += @{ scope = "npm run test:e2e:chrome (branded Chrome, file://, offline)"; result = "UNTESTED"; detail = "operator did not pass -NetworkDisabled" }
  $results += @{ scope = "npm run test:e2e:edge (branded Edge, file://, offline)"; result = "UNTESTED"; detail = "operator did not pass -NetworkDisabled" }
} else {
  if ($chromePath) {
    $results += @{ scope = "npm run test:e2e:chrome (branded Chrome, file://, offline)"; result = (Invoke-Scope "e2e branded Chrome" (Join-Path $OutDir "e2e-chrome.log") @("run", "test:e2e:chrome", "--", "--workers=$Workers") (Join-Path (Join-Path $OutDir "artifacts") "e2e-chrome") (Join-Path (Join-Path $OutDir "artifacts") "e2e-chrome-report")); detail = "e2e-chrome.log + artifacts/e2e-chrome[/-report]" }
  } else {
    Write-Step "e2e branded Chrome — BROWSER MISSING: HARD FAIL"
    Write-Host "  Google Chrome was not found on this host. This scope FAILS."
    Write-Host "  Do NOT substitute bundled Chromium results for branded Chrome."
    Write-Host "  Install Chrome and re-run."
    "HARD FAIL: Google Chrome not found; scope not executed." | Out-File -FilePath (Join-Path $OutDir "e2e-chrome.log") -Encoding utf8
    $results += @{ scope = "npm run test:e2e:chrome (branded Chrome, file://, offline)"; result = "FAIL"; detail = "branded Chrome missing on host" }
  }
  if ($edgePath) {
    $results += @{ scope = "npm run test:e2e:edge (branded Edge, file://, offline)"; result = (Invoke-Scope "e2e branded Edge" (Join-Path $OutDir "e2e-msedge.log") @("run", "test:e2e:edge", "--", "--workers=$Workers") (Join-Path (Join-Path $OutDir "artifacts") "e2e-msedge") (Join-Path (Join-Path $OutDir "artifacts") "e2e-msedge-report")); detail = "e2e-msedge.log + artifacts/e2e-msedge[/-report]" }
  } else {
    Write-Step "e2e branded Edge — BROWSER MISSING: HARD FAIL"
    Write-Host "  Microsoft Edge was not found on this host. This scope FAILS."
    Write-Host "  Do NOT substitute bundled Chromium or Chrome results for branded Edge."
    Write-Host "  Install Edge and re-run."
    "HARD FAIL: Microsoft Edge not found; scope not executed." | Out-File -FilePath (Join-Path $OutDir "e2e-msedge.log") -Encoding utf8
    $results += @{ scope = "npm run test:e2e:edge (branded Edge, file://, offline)"; result = "FAIL"; detail = "branded Edge missing on host" }
  }
}

# ---- summary ---------------------------------------------------------------

Write-Step "Summary"
$failCount = @($results | Where-Object { $_.result -eq "FAIL" }).Count
$untestedCount = @($results | Where-Object { $_.result -eq "UNTESTED" }).Count
$lines = @("LogoTool Windows acceptance — per-scope results", "")
foreach ($r in $results) {
  $line = "[$($r.result)] $($r.scope) -- $($r.detail)"
  Write-Host "  $line"
  $lines += $line
}
$lines += ""
$lines += "Automated-journey evidence vs untested gates:"
$lines += "- PASS above = that automated scope passed on THIS host (see environment.txt for OS/browser/version). It is still synthetic-fixture evidence only."
$lines += "- UNTESTED above = no claim is made for that gate. It must not be read as passing."
$lines += "- Even a full PASS here does NOT establish: real garment dimensions, curved-surface logo rendering, production approval, or operator usability. See docs/operator-pilot-checklist.md."
$lines | Out-File -FilePath (Join-Path $OutDir "summary.txt") -Encoding utf8

Write-Host ""
Write-Host "Report dir: $OutDir (environment.txt, per-scope *.log, per-scope artifacts/, summary.txt)"
Write-Host "Keep this folder as the acceptance record for this host."
Write-Host "Reminder: this validates the SOURCE REPO's automated suites. The customer delivery"
Write-Host "(OPEN_LOGO_CONFIGURATOR.html / hybrid ZIP) is a separate artifact needing no npm or install."
if ($failCount -gt 0) {
  Write-Host "OVERALL: FAIL ($failCount scope(s) failed). Exit 1."
  exit 1
} elseif ($untestedCount -gt 0) {
  Write-Host "OVERALL: INCOMPLETE ($untestedCount scope(s) UNTESTED, none failed). Exit 2."
  exit 2
} else {
  Write-Host "OVERALL: PASS (all executed scopes passed on this host). Exit 0."
  exit 0
}
