# D Shift — Windows UI Automation dumper (accessibility-first context)
# Reads the FOREGROUND window's UIA tree and writes ONE JSON object to stdout:
#   { app, title, pid, root: { type, name, value, description, rect, focused,
#                             isPassword, selectedText, children: [...] } }
# Design notes (see recon/DOCS_RESEARCH.md section 2):
#  - Per-Monitor-V2 DPI awareness is declared BEFORE touching UIA.
#  - Chromium/Electron trees are lazy: if the first walk is thin we wait
#    ~500 ms and walk once more (we NEVER relaunch the user's browser with
#    --force-renderer-accessibility).
#  - Password fields: IsPassword is reported; values are NEVER read.
#  - Bounded walk: max 3000 nodes, depth 40 (same caps as the macOS original).
param([int]$MaxNodes = 3000, [int]$MaxDepth = 40)
$ErrorActionPreference = 'Stop'
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

$hwnd = [DSNative]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output '{"app":"","title":"","root":null}'; exit 0 }
[uint32]$pid32 = 0; [void][DSNative]::GetWindowThreadProcessId($hwnd, [ref]$pid32)
$proc = $null; try { $proc = Get-Process -Id $pid32 -ErrorAction Stop } catch {}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

$script:count = 0
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
$tree = Convert-El $root 0
# Chromium lazy-tree retry: thin result -> brief wait -> one re-walk
if ($script:count -lt 10) { Start-Sleep -Milliseconds 500; $script:count = 0; $tree = Convert-El $root 0 }
if ($script:selected) { $tree.selectedText = $script:selected }
$out = [ordered]@{ app = if ($proc) { $proc.ProcessName } else { '' }; title = $root.Current.Name; pid = [int]$pid32; root = $tree }
# Depth must exceed the walk depth's JSON nesting or deep trees truncate (audit M3)
Write-Output ($out | ConvertTo-Json -Depth 100 -Compress)
