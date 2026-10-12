// Casca Tauri v2 da Prova Digital ProfAMR.
// Chama o motor Python [sidecar 'prova-digital-engine'], transmite o progresso
// [eventos 'progresso'] e devolve o JSON do resultado ao frontend.

use std::fs;
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

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
            excluir_caso
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar a aplicacao Tauri");
}
