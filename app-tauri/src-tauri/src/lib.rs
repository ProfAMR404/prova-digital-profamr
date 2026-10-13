// Casca Tauri v2 da Prova Digital ProfAMR.
// Chama o motor Python [sidecar 'prova-digital-engine'], transmite o progresso
// [eventos 'progresso'] e devolve o JSON do resultado ao frontend.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

// SHA-256 de um arquivo, em blocos no heap [evita estourar a pilha].
fn sha256_file(caminho: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = fs::File::open(caminho).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// Diretorio local dos casos [fica na maquina do usuario; LGPD].
fn casos_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("casos");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

// So aceita id com letra, numero, hifen e sublinhado; impede escrita fora da pasta.
fn id_seguro(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

#[tauri::command]
fn salvar_caso(
    app: tauri::AppHandle,
    id: String,
    dados: serde_json::Value,
) -> Result<String, String> {
    let dir = casos_dir(&app)?;
    let seguro = id_seguro(&id);
    if seguro.is_empty() {
        return Err("identificador do caso invalido".into());
    }
    let caminho = dir.join(format!("{seguro}.json"));
    let txt = serde_json::to_string_pretty(&dados).map_err(|e| e.to_string())?;
    fs::write(&caminho, txt).map_err(|e| e.to_string())?;
    Ok(seguro)
}

#[tauri::command]
fn listar_casos(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = casos_dir(&app)?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let p = entry.map_err(|e| e.to_string())?.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let txt = match fs::read_to_string(&p) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&txt) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let caso = v.get("caso").cloned().unwrap_or_default();
        let campo = |o: &serde_json::Value, k: &str| {
            o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
        };
        out.push(serde_json::json!({
            "id": campo(&v, "id"),
            "autos": campo(&caso, "autos"),
            "arguido": campo(&caso, "arguido"),
            "classe": campo(&caso, "classe"),
            "atualizado": campo(&v, "atualizado"),
            "nlaudos": v.get("laudos").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0),
        }));
    }
    out.sort_by(|a, b| {
        b["atualizado"]
            .as_str()
            .unwrap_or("")
            .cmp(a["atualizado"].as_str().unwrap_or(""))
    });
    Ok(out)
}

#[tauri::command]
fn carregar_caso(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    let dir = casos_dir(&app)?;
    let caminho = dir.join(format!("{}.json", id_seguro(&id)));
    let txt = fs::read_to_string(&caminho).map_err(|e| e.to_string())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

// Recalcula o SHA-256 de um arquivo, para aferir se o laudo mudou desde a analise.
#[tauri::command]
fn hash_arquivo(caminho: String) -> Result<String, String> {
    sha256_file(&caminho)
}

// Modo C: detecta o IPED e le a versao, rodando '<iped> -h'.
#[tauri::command]
fn iped_detectar(caminho: Option<String>) -> Result<serde_json::Value, String> {
    let exe = caminho
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "iped".to_string());
    let out = Command::new(&exe)
        .arg("-h")
        .output()
        .map_err(|e| format!("nao foi possivel executar o IPED em '{exe}': {e}"))?;
    let txt = String::from_utf8_lossy(&out.stdout);
    let linha = txt
        .lines()
        .find(|l| l.contains("Evid") || l.to_lowercase().contains("iped"))
        .unwrap_or("")
        .trim()
        .to_string();
    let versao = linha
        .split_whitespace()
        .rev()
        .find(|t| t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
        .unwrap_or("")
        .to_string();
    if versao.is_empty() {
        return Err("o IPED respondeu, mas nao foi possivel ler a versao".into());
    }
    Ok(serde_json::json!({ "ok": true, "path": exe, "versao": versao, "linha": linha }))
}

// Modo C: grava o hash de origem, orquestra o IPED sobre a fonte e devolve o caso gerado.
// Nao escreve no vestigio; o IPED recebe a fonte como leitura e produz o caso em pasta propria.
#[tauri::command]
async fn iped_processar(
    app: tauri::AppHandle,
    fonte: String,
    iped_path: String,
) -> Result<serde_json::Value, String> {
    if iped_path.trim().is_empty() {
        return Err("caminho do IPED nao configurado".into());
    }
    let meta = fs::metadata(&fonte).map_err(|e| format!("fonte inacessivel: {e}"))?;
    // Hash de origem antes de processar [so para arquivo; pasta ou dispositivo fica a cargo do IPED por item].
    let origem_sha256: Option<String> = if meta.is_file() {
        Some(sha256_file(&fonte)?)
    } else {
        None
    };

    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("casos-iped");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let saida = base.join(format!("caso-{stamp}"));
    let saida_str = saida.to_string_lossy().into_owned();

    let app2 = app.clone();
    let fonte2 = fonte.clone();
    let iped2 = iped_path.clone();
    let saida2 = saida_str.clone();

    let code = tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        let _ = app2.emit("iped-progresso", "Iniciando o IPED".to_string());
        let mut child = Command::new(&iped2)
            .arg("-d")
            .arg(&fonte2)
            .arg("-o")
            .arg(&saida2)
            .arg("--nogui")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("falha ao iniciar o IPED: {e}"))?;
        if let Some(out) = child.stdout.take() {
            let reader = BufReader::new(out);
            for linha in reader.lines().map_while(Result::ok) {
                let l = linha.trim();
                if !l.is_empty() {
                    let _ = app2.emit("iped-progresso", l.to_string());
                }
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(serde_json::json!({
        "ok": code == 0,
        "code": code,
        "case_path": saida_str,
        "fonte": fonte,
        "origem_sha256": origem_sha256,
        "iped_path": iped_path,
    }))
}

#[tauri::command]
fn excluir_caso(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = casos_dir(&app)?;
    let caminho = dir.join(format!("{}.json", id_seguro(&id)));
    if caminho.exists() {
        fs::remove_file(&caminho).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn analisar(
    app: tauri::AppHandle,
    caminho: String,
    llm: bool,
    ocr: bool,
    tipos: Vec<String>,
) -> Result<serde_json::Value, String> {
    let saida = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("saida");
    std::fs::create_dir_all(&saida).map_err(|e| e.to_string())?;

    let mut args: Vec<String> = vec![
        "analisar".into(),
        caminho,
        "--saida".into(),
        saida.to_string_lossy().into_owned(),
    ];
    if !tipos.is_empty() {
        args.push("--tipos".into());
        args.push(tipos.join(","));
    }
    if llm {
        args.push("--llm".into());
    }
    if ocr {
        args.push("--ocr".into());
    }

    let sidecar = app
        .shell()
        .sidecar("prova-digital-engine")
        .map_err(|e| e.to_string())?
        .args(args);
    let (mut rx, _child) = sidecar.spawn().map_err(|e| e.to_string())?;

    let mut stdout_buf = String::new();
    let mut code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                let texto = String::from_utf8_lossy(&bytes);
                for linha in texto.lines() {
                    if let Some(msg) = linha.strip_prefix("PROGRESSO: ") {
                        let _ = app.emit("progresso", msg.trim().to_string());
                    }
                }
            }
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Terminated(payload) => {
                code = payload.code;
            }
            _ => {}
        }
    }

    if stdout_buf.trim().is_empty() {
        return Err(format!("o motor nao retornou dados [codigo {:?}]", code));
    }
    serde_json::from_str::<serde_json::Value>(stdout_buf.trim())
        .map_err(|e| format!("saida invalida do motor: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            analisar,
            salvar_caso,
            listar_casos,
            carregar_caso,
            excluir_caso,
            hash_arquivo,
            iped_detectar,
            iped_processar
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar a aplicacao Tauri");
}
