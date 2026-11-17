# Runs ltm-windows-x64.exe against a copy of fixtures/demo-bank with no node or bun on PATH, the Windows twin of smoke-binary.sh (#185).
# PowerShell, not bash: a native .exe can't run a #!/bin/sh fake qmd, MSYS fifos don't reliably feed its stdin, and Git Bash puts node on PATH.
param([string]$Bin)

$ErrorActionPreference = 'Stop'
# Exit codes are checked by hand in Invoke-Ltm, so a non-zero one mustn't throw first.
$PSNativeCommandUseErrorActionPreference = $false

if (-not $Bin) { [Console]::Error.WriteLine('usage: smoke-windows.ps1 <dist/ltm-windows-x64.exe>'); exit 2 }
if (-not (Test-Path -LiteralPath $Bin -PathType Leaf)) { [Console]::Error.WriteLine("smoke-windows: $Bin isn't a file"); exit 2 }
$Bin = (Resolve-Path -LiteralPath $Bin).Path
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Fail([string]$Step) {
  [Console]::Error.WriteLine("smoke: FAIL $Step")
  exit 1
}

# A non-PE .exe makes & throw instead of setting an exit code, and a stale $LASTEXITCODE could hide a launch that never happened, so both paths fail the step.
function Invoke-Ltm([string]$Step, [string[]]$LtmArgs) {
  $global:LASTEXITCODE = 0
  try { $out = & $Bin @LtmArgs } catch { Fail "${Step}: $($_.Exception.Message)" }
  if ($LASTEXITCODE -ne 0) { Fail $Step }
  $out
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "ltm-smoke-$([guid]::NewGuid())"
$bank = Join-Path $tmp 'bank'
$qmdbin = Join-Path $tmp 'qmdbin'
try {
  New-Item -ItemType Directory -Path $tmp, $qmdbin | Out-Null
  Copy-Item -Recurse -Force (Join-Path $root 'fixtures/demo-bank') $bank
  Copy-Item -Recurse -Force (Join-Path $root 'test/fixtures/fake-qmd-package') (Join-Path $tmp 'fake-qmd-package')

  # Same shape npm i -g installs on Windows. goto, not a ( ) block, so a ) in an expanded path can't end the block early.
  Set-Content -LiteralPath (Join-Path $qmdbin 'qmd.cmd') -Value @(
    '@echo off'
    'if "%~1"=="skills" goto skills'
    'if "%~1"=="collection" goto collection'
    'exit /b 1'
    ':skills'
    'echo %FAKE_PKG%\skills'
    'exit /b 0'
    ':collection'
    'echo Collection: %3'
    'echo   Path:     %FAKE_ROOT%'
    'exit /b 0'
  )

  # Replace PATH rather than env -i: a native Windows process still needs SystemRoot, TEMP and USERPROFILE. windows-latest puts node in many PATH dirs.
  $env:PATH = @($qmdbin, "$env:SystemRoot\System32", "$env:SystemRoot") -join [IO.Path]::PathSeparator
  $runtime = Get-Command node, bun -CommandType Application -ErrorAction SilentlyContinue
  if ($runtime) {
    [Console]::Error.WriteLine("smoke: FAIL no-runtime: node or bun is on PATH ($($runtime.Source -join ', '))")
    exit 90
  }
  Write-Output 'smoke: ok no-runtime (no node or bun on PATH)'

  Set-Location -LiteralPath $bank
  Invoke-Ltm '--version' @('--version')
  Invoke-Ltm 'validate' @('validate')

  $out = (Invoke-Ltm 'query' @('query', '--type', 'Decision', '--json')) -join "`n"
  if ($out.StartsWith('[]')) { Fail 'query: returned no Decisions' }
  if (-not $out.StartsWith('[')) { Fail "query: output isn't a JSON array: $out" }
  Write-Output 'smoke: ok query'

  Invoke-Ltm 'head' @('head', '_memory/decisions/postgres-everywhere-kQ7vN2xLp4.md')

  $psi = [Diagnostics.ProcessStartInfo]::new($Bin)
  $psi.ArgumentList.Add('mcp')
  $psi.WorkingDirectory = $bank
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.Environment['LTM_BANK_PATH'] = $bank
  try { $mcp = [Diagnostics.Process]::Start($psi) } catch { Fail "mcp: $($_.Exception.Message)" }
  $seen = [Collections.Generic.List[string]]::new()
  $reply = $null
  try {
    # StandardInput's NewLine defaults to CRLF on Windows; send bare LF like printf does.
    $mcp.StandardInput.NewLine = "`n"
    $mcp.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
    $mcp.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    $mcp.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
    $mcp.StandardInput.Flush()
    # stdin stays open until the reply lands, so EOF can't shut the server down before it answers.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($null -eq $reply) {
      $read = $mcp.StandardOutput.ReadLineAsync()
      $left = $deadline - [DateTime]::UtcNow
      if ($left -le [TimeSpan]::Zero -or -not $read.Wait($left)) { break }
      if ($null -eq $read.Result) { break }
      $seen.Add($read.Result)
      if ($read.Result.Contains('"id":2')) { $reply = $read.Result }
    }
  } finally {
    # The server need not exit on EOF (the darwin build keeps running), so stop it either way.
    if (-not $mcp.HasExited) { $mcp.Kill($true) }
    $mcp.WaitForExit()
  }
  if ($null -eq $reply) {
    $seen | ForEach-Object { [Console]::Error.WriteLine($_) }
    Fail 'mcp: no tools/list reply in 30 s'
  }
  foreach ($tool in 'query', 'head', 'facets', 'validate', 'propose') {
    if (-not $reply.Contains("`"$tool`"")) { Fail "mcp: tools/list lacks $tool" }
  }
  Write-Output 'smoke: ok mcp (query head facets validate propose)'

  # recall.mode vector runs its qmd worker on the binary's embedded Bun (BUN_BE_BUN), so this proves the worker needs no installed bun either. The fake qmd package stands in for the real one.
  Add-Content -LiteralPath (Join-Path $bank 'memory-bank.yaml') -Value @(
    'doctor: { near_duplicate_threshold: 0.6 }'
    'recall: { backend: qmd, mode: vector, collections: { Decision: decisions } }'
  )
  $env:FAKE_PKG = Join-Path $tmp 'fake-qmd-package'
  $env:FAKE_ROOT = Join-Path $bank '_memory/decisions'
  $env:XDG_CONFIG_HOME = Join-Path $tmp 'xdg'

  $env:FAKE_STATUS = '{"decisions":{"active":9,"pending":0}}'
  Invoke-Ltm "doctor vector: embedded collection didn't exit 0" @('doctor') | Out-Null

  $env:FAKE_STATUS = '{"decisions":{"active":9,"pending":9}}'
  $global:LASTEXITCODE = 0
  try { $out = (& $Bin doctor 2>&1 | ForEach-Object { "$_" }) -join "`n" } catch { Fail "doctor vector: $($_.Exception.Message)" }
  if ($LASTEXITCODE -eq 0) { Fail 'doctor vector: unembedded collection exited 0' }
  if (-not $out.Contains('run qmd embed')) { Fail "doctor vector: no qmd embed message: $out" }
  Write-Output 'smoke: ok doctor vector (worker ran in the binary)'
  Write-Output 'smoke: PASS'
} finally {
  Set-Location -LiteralPath ([IO.Path]::GetTempPath())
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
