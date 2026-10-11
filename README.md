# Prova Digital ProfAMR [desktop]

Aplicativo local do método RoadMapCrime para a cadeia de custódia da prova digital.
Ingere o laudo em PDF, pré-responde os itens por pistas e, opcionalmente, por modelo
local [Ollama], classifica pela escala do gabinete [inexistência, arranhão e quebra]
e redige minutas. O jurista refina. Tudo na máquina, nada é enviado, o que mantém o
sigilo e a conformidade com a LGPD e põe a responsabilidade em quem assina.

Mesmo molde do Transcritor ProfAMR: casca Tauri v2 com o motor Python como sidecar,
empacotado por PyInstaller, instalador Windows gerado por GitHub Actions.

## Estrutura

- `engine_entry.py`: motor [CLI `analisar <laudo.pdf> --saida <dir> [--llm]`], imprime JSON.
- `dados/itens.json`: 6 blocos, 39 itens, portas e gatilho de quebra da escala.
- `app-tauri/`: casca Tauri v2 [Rust + webview] que chama o sidecar e mostra a tela.
- `.github/workflows/build-tauri.yml`: build do instalador Windows [workflow_dispatch].

## Build local [Windows]

```
python -m pip install -r requirements.txt
powershell -ExecutionPolicy Bypass -File app-tauri/scripts/build-sidecar.ps1
cd app-tauri
npm install
npx @tauri-apps/cli icon src/assets/logo.png
npm run build
```

O instalador sai em `app-tauri/src-tauri/target/release/bundle/`.

## Modelo local [opcional]

A pré-resposta por modelo usa o Ollama em `localhost:11434` [modelo `gemma3:4b`].
Sem o Ollama, a pré-resposta fica só nas pistas determinísticas. O usuário confirma
cada item.

## Limites

A escala inexistência, arranhão e quebra é elaboração do gabinete, não tese de
tribunal nem doutrina de terceiro. A saída não é laudo nem parecer. Laudo escaneado
como imagem exige OCR, previsto para versão futura.
