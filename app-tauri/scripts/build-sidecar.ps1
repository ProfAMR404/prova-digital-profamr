# Gera o sidecar 'prova-digital-engine' [motor Python] no Windows e o nomeia com
# o target triple do Rust, como o Tauri v2 exige em externalBin. Rode no PowerShell.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")   # raiz do repositorio

Write-Host ">> Instalando dependencias de build do sidecar" -ForegroundColor Cyan
python -m pip install --upgrade pip pyinstaller
python -m pip install -r requirements.txt

# Localiza a instalacao do Tesseract para embutir no executavel [OCR offline].
$tessDir = $env:TESSERACT_DIR
if (-not $tessDir) { $tessDir = "C:\Program Files\Tesseract-OCR" }

$pyArgs = @(
  "--noconfirm", "--clean", "--onefile", "--name", "prova-digital-engine",
  "--collect-all", "pdfplumber",
  "--collect-all", "pdfminer",
  "--collect-all", "fitz",
  "--hidden-import", "pytesseract",
  "--hidden-import", "PIL",
  "--hidden-import", "PIL.Image",
  "--add-data", "dados;dados"
)

if (Test-Path (Join-Path $tessDir "tesseract.exe")) {
  Write-Host ">> Embutindo Tesseract de $tessDir" -ForegroundColor Cyan
  $pyArgs += @("--add-data", "$tessDir;tesseract")
} else {
  Write-Warning "Tesseract nao encontrado em $tessDir; o app sera gerado sem OCR embutido."
}

$pyArgs += "engine_entry.py"

Write-Host ">> Empacotando o motor com PyInstaller [onefile]" -ForegroundColor Cyan
& pyinstaller @pyArgs

$triple = (rustc -Vv | Select-String '^host: ').ToString().Replace('host: ','').Trim()
$dest = "app-tauri\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "dist\prova-digital-engine.exe" "$dest\prova-digital-engine-$triple.exe" -Force
Write-Host ">> Sidecar: $dest\prova-digital-engine-$triple.exe" -ForegroundColor Green
