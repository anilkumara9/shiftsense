# D Shift — PERSISTENT Windows UI Automation host (performance lane)
# Long-running replacement for repeated one-shot uia-dump.ps1 spawns.
# A cold powershell.exe + Add-Type + JIT costs ~300-800 ms per screen read;
# this host pays that ONCE at startup, then answers each request with only
# the UIA walk itself (typically tens of ms), which is what makes the 4 s
# context tracker and per-send refreshes cheap.
#
# Protocol (JSON lines over stdio, UTF-8):
#   request:  {"id": <int>}
#   response: {"id": <int>, "result": { app, title, pid, root } }
#             "result" is EXACTLY what uia-dump.ps1 prints for the same
#             foreground window (same walk, same caps, same fields).
#             On a per-request failure the host answers with the one-shot's
#             empty dump ({"app":"","title":"","root":null}) plus an
#             "error" message field, and KEEPS RUNNING — one bad tree can
#             never kill the host. Lines that cannot be correlated to an
#             id are skipped silently (nothing uncorrelated is ever emitted).
#   stdin EOF -> clean exit 0.
#
# Safety invariants carried over from uia-dump.ps1 (recon/DOCS_RESEARCH.md §2):
#  - Per-Monitor-V2 DPI awareness declared BEFORE touching UIA.
#  - Password fields: IsPassword reported; values are NEVER read.
#  - Bounded walk: max 3000 nodes, depth 40; values truncated at 500 chars;
#    selected text capped at 2000 chars.
#  - Chromium/Electron lazy trees: thin first walk -> wait ~500 ms -> ONE
#    re-walk (never relaunch the user's browser with accessibility flags).
param([int]$MaxNodes = 3000, [int]$MaxDepth = 40)
# 'Continue', never 'Stop': in a long-running host a terminating error in one
# request must not take the process down (the one-shot can afford 'Stop').
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class DSNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
}
"@
[void][DSNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) # PER_MONITOR_AWARE_V2
# Node speaks UTF-8 on the pipes; pin both console directions to match so
# non-ASCII window titles / element names survive the round trip.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}

# --- Walker (duplicated verbatim from uia-dump.ps1; the one-shot script is ---
# --- left untouched so its existing callers/tests keep their contract).    ---
$script:count = 0
$script:selected = $null
function Truncate($s) { if ($null -eq $s) { return $s }; $str = [string]$s; if ($str.Length -gt 500) { return $str.Substring(0, 500) }; return $str }
function Convert-El($el, $depth) {
  if ($null -eq $el -or $script:count -ge $MaxNodes -or $depth -gt $MaxDepth) { return $null }
  $script:count++
  # One stale/dead element must not kill the whole dump (audit M3): guard .Current
  try { $c = $el.Current } catch { return $null }
  $node = [ordered]@{}
  $node.type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  $node.name = Truncate $c.Name
  $node.isPassword = $c.IsPassword
  $r = $c.BoundingRectangle
  if ($r.Width -gt 0 -and $r.Height -gt 0) { $node.rect = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height) }
  try { $node.focused = $el -eq [System.Windows.Automation.AutomationElement]::FocusedElement } catch { $node.focused = $false }
  if (-not $c.IsPassword) {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $node.value = Truncate $vp.Current.Value }
    else {
      $tp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
        try { $sel = $tp.GetSelection(); if ($sel -and $sel.Count -gt 0) { $script:selected = $sel[0].GetText(2000) } } catch {}
      }
    }
  }
  $node.children = @()
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child) {
    $cn = Convert-El $child ($depth + 1)
    if ($null -ne $cn) { $node.children += $cn }
    $child = $walker.GetNextSibling($child)
  }
  return $node
}

# The one-shot's empty-dump shape, used for "no foreground window" and as
# the per-request failure result (identical to uia-dump.ps1's own output).
function New-EmptyDump { return [ordered]@{ app = ''; title = ''; root = $null } }

function Invoke-Dump {
  $hwnd = [DSNative]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return New-EmptyDump }
  [uint32]$pid32 = 0; [void][DSNative]::GetWindowThreadProcessId($hwnd, [ref]$pid32)
  $proc = $null; try { $proc = Get-Process -Id $pid32 -ErrorAction Stop } catch {}
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { return [ordered]@{ app = if ($proc) { $proc.ProcessName } else { '' }; title = ''; pid = [int]$pid32; root = $null } }
  # Per-request state reset: unlike the one-shot (fresh process per read),
  # the host must not leak node counts or a stale selection across requests.
  $script:count = 0; $script:selected = $null
  $tree = Convert-El $root 0
  # Chromium lazy-tree retry: thin result -> brief wait -> one re-walk
  if ($script:count -lt 10) { Start-Sleep -Milliseconds 500; $script:count = 0; $tree = Convert-El $root 0 }
  if ($tree -and $script:selected) { $tree.selectedText = $script:selected }
  $title = ''; try { $title = $root.Current.Name } catch {}
  return [ordered]@{ app = if ($proc) { $proc.ProcessName } else { '' }; title = $title; pid = [int]$pid32; root = $tree }
}

# --- Request loop -----------------------------------------------------------
while ($true) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($null -eq $line) { break } # stdin EOF: Node closed us / app is quitting
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = $null; $err = $null; $result = $null
  try {
    $req = $line | ConvertFrom-Json -ErrorAction Stop
    $id = $req.id
    if ($null -eq $id) { continue } # cannot correlate a response without an id
    $result = Invoke-Dump
  } catch {
    $err = $_.Exception.Message
    if ($null -eq $result) { $result = New-EmptyDump }
  }
  if ($null -eq $id) { continue }
  $resp = [ordered]@{ id = $id; result = $result }
  if ($err) { $resp.error = $err }
  try {
    # Depth must exceed the walk depth's JSON nesting (audit M3): -Depth 100.
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Depth 100 -Compress))
    [Console]::Out.Flush()
  } catch { break } # stdout is gone; nothing left to serve
}
exit 0
