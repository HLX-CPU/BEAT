$ErrorActionPreference = 'Stop'

try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
    exit 0
} catch {
    # Continue only when the local service is not already available.
}

$env:OLLAMA_MODELS = 'E:\AI\Models\Ollama'
$ollama = 'D:\Ollama\ollama.exe'
if (-not (Test-Path -LiteralPath $ollama)) {
    throw 'Ollama is missing from D:\Ollama; use the BEAT local-model repair action.'
}

Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
        exit 0
    } catch {
        # Wait up to 15 seconds and preserve a real task failure afterward.
    }
}

throw 'The local DeepSeek service did not start; use the BEAT local-model restart action.'
