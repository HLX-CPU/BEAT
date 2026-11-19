param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Manifest,[string]$Prefix='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$expected=Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
try {
  foreach($entry in $zip.Entries) {
    $name=$entry.FullName.Replace('\','/')
    if($name -match '(^|/)(portable-data|secrets.local.json|beat.sqlite(-shm|-wal)?)(/|$)') { throw "交付包混入用户数据：$name" }
  }
  foreach($file in $expected.files) {
    $name=$Prefix+'app/'+$file.path
    $matches=@($zip.Entries | Where-Object { $_.FullName.Replace('\','/') -eq $name })
    if($matches.Count -ne 1) { throw "交付包缺失或重复文件：$name" }
    $stream=$matches[0].Open()
    $hasher=[Security.Cryptography.SHA256]::Create()
    try { $hash=([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose();$hasher.Dispose() }
    if($hash -ne $file.sha256) { throw "交付包文件与源码不一致：$name" }
  }
  $code=@($zip.Entries | Where-Object { $_.FullName.Replace('\','/').StartsWith($Prefix+'app/') -and -not $_.FullName.EndsWith('/') })
  if($code.Count -ne $expected.files.Count) { throw '交付包包含清单之外的产品代码' }
  @{passed=$true;files=$expected.files.Count;archive=$Archive;version=$expected.version} | ConvertTo-Json -Compress
} finally { $zip.Dispose() }
