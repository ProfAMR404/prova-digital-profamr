# Gera o sidecar 'prova-digital-engine' [motor Python] no Windows e o nomeia com
# o target triple do Rust, como o Tauri v2 exige em externalBin. Rode no PowerShell.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")   # raiz do repositorio

Write-Host ">> Instalando dependencias de build do sidecar" -ForegroundColor Cyan
python -m pip install --upgrade pip pyinstaller
python -m pip install -r requirements.txt

Write-Host ">> Empacotando o motor com PyInstaller [onefile]" -ForegroundColor Cyan
pyinstaller --noconfirm --clean --onefile --name prova-digital-engine `
  --collect-all pdfplumber `
  --collect-all pdfminer `
  --add-data "dados;dados" `
  engine_entry.py

$triple = (rustc -Vv | Select-String '^host: ').ToString().Replace('host: ','').Trim()
$dest = "app-tauri\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "dist\prova-digital-engine.exe" "$dest\prova-digital-engine-$triple.exe" -Force
Write-Host ">> Sidecar: $dest\prova-digital-engine-$triple.exe" -ForegroundColor Green
