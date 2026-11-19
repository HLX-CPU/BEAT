$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$target = $env:BEAT_OPEN_PATH
$mode = $env:BEAT_OPEN_MODE
if (-not $target -or $mode -notin @('file','folder','reveal')) { throw 'Invalid open request' }
if (-not (Test-Path -LiteralPath $target)) { throw 'The requested file no longer exists' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BeatOpenWindow {
  public delegate bool Visitor(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public static long FindFileWindow(string file, string documentTitle, int processId) {
    long result=0;
    EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
      StringBuilder title=new StringBuilder(4096); GetWindowText(hwnd,title,title.Capacity);
      uint pid; GetWindowThreadProcessId(hwnd,out pid);
      // An unrelated browser/editor window is not proof of opening this file.
      if(title.ToString().IndexOf(file,StringComparison.OrdinalIgnoreCase)>=0 && title.Length>0) {result=hwnd.ToInt64();return false;}
      if(documentTitle.Length>=4 && title.ToString().StartsWith(documentTitle,StringComparison.OrdinalIgnoreCase)) {result=hwnd.ToInt64();return false;}
      if(processId>0 && pid==processId && title.Length>0) {result=hwnd.ToInt64();return false;}
      return true;
    },IntPtr.Zero);
    return result;
  }
  public static bool Show(long hwnd) {
    IntPtr handle=new IntPtr(hwnd);
    ShowWindowAsync(handle,9); SetForegroundWindow(handle);
    return IsWindowVisible(handle) && !IsIconic(handle);
  }
}
'@
function Write-Receipt($value) { $value | ConvertTo-Json -Compress -Depth 6 }
if ($mode -in @('folder','reveal')) {
  $folder = if ($mode -eq 'folder') { $target } else { Split-Path -LiteralPath $target }
  $shell = New-Object -ComObject Shell.Application
  function Find-FolderWindow {
    foreach ($window in @($shell.Windows())) {
      try { if ([string]::Equals($window.Document.Folder.Self.Path,$folder,[StringComparison]::OrdinalIgnoreCase)) { return $window } } catch {}
    }
    return $null
  }
  $window = Find-FolderWindow
  if (-not $window) {
    # Explicit normal show state. The hidden PowerShell transport must never
    # propagate its hidden startup state to the customer's Explorer window.
    $shell.ShellExecute($folder,'','','open',1)
  }
  for ($attempt=0; $attempt -lt 35; $attempt++) {
    $window = Find-FolderWindow
    if ($window) {
      $window.Visible = $true
      $shown = [BeatOpenWindow]::Show([long]$window.HWND)
      if ($mode -eq 'reveal') {
        $item = $window.Document.Folder.ParseName([IO.Path]::GetFileName($target))
        if ($item) { $window.Document.SelectItem($item,29) }
      }
      $selected = @()
      try { $selected = @($window.Document.SelectedItems() | ForEach-Object { $_.Path }) } catch {}
      if ($shown -and ($mode -eq 'folder' -or $selected -contains $target)) {
        Write-Receipt @{status='verified';method='shell-folder-window';window=@{hwnd=[long]$window.HWND;folder=$folder;visible=$true;selected=$selected}}
        exit 0
      }
    }
    Start-Sleep -Milliseconds 150
  }
  throw 'The requested Explorer window could not be confirmed visible'
}
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.UseShellExecute = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
$start.FileName = $target
if ($env:BEAT_OPEN_EDITOR) {
  $start.FileName = $env:BEAT_OPEN_EDITOR
  $start.Arguments = '"' + $target + '"'
}
$process = [Diagnostics.Process]::Start($start)
$processId = if ($process) { $process.Id } else { 0 }
for ($attempt=0; $attempt -lt 20; $attempt++) {
  $hwnd = [BeatOpenWindow]::FindFileWindow([IO.Path]::GetFileName($target),[string]$env:BEAT_OPEN_TITLE,$processId)
  if ($hwnd -and [BeatOpenWindow]::Show($hwnd)) {
    Write-Receipt @{status='verified';method='visible-file-window';window=@{hwnd=$hwnd;visible=$true};processId=$processId}
    exit 0
  }
  Start-Sleep -Milliseconds 150
}
# Some default applications reuse a tab with a document title instead of its
# filename. Shell acceptance alone must not be described as visual verification.
Write-Receipt @{status='requested';method='windows-shell-accepted';processId=$processId}
