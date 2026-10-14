// Casca Tauri v2 da Prova Digital ProfAMR.
// Chama o motor Python [sidecar 'prova-digital-engine'], transmite o progresso
// [eventos 'progresso'] e devolve o JSON do resultado ao frontend.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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

// Parser de uma linha CSV do IPED [campos entre aspas, aspas duplas escapadas].
fn csv_linha(l: &str) -> Vec<String> {
    let mut campos = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut chars = l.chars().peekable();
    while let Some(c) = chars.next() {
        if in_q {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_q = false;
                }
            } else {
                cur.push(c);
            }
        } else {
            match c {
                '"' => in_q = true,
                ',' => campos.push(std::mem::take(&mut cur)),
                _ => cur.push(c),
            }
        }
    }
    campos.push(cur);
    campos
}

// Modo C, leitura direta do caso: le o caso IPED real [FileList.csv], sem mock e
// sem servidor externo. Busca, colunas, linha do tempo e resumo sobre dados reais.
#[tauri::command]
fn iped_ler_caso(
    case_path: String,
    op: String,
    query: Option<String>,
) -> Result<serde_json::Value, String> {
    let fl = std::path::Path::new(&case_path).join("FileList.csv");
    let txt = fs::read_to_string(&fl)
        .map_err(|e| format!("FileList.csv inacessivel no caso: {e}"))?;
    let mut linhas = txt.lines();
    let header_raw = linhas.next().unwrap_or("").trim_start_matches('\u{feff}');
    let colunas = csv_linha(header_raw);
    let idx = |nome: &str| colunas.iter().position(|c| c.eq_ignore_ascii_case(nome));
    let registros: Vec<Vec<String>> = linhas
        .filter(|l| !l.trim().is_empty())
        .map(csv_linha)
        .collect();
    let total = registros.len();
    let to_obj = |r: &Vec<String>| {
        let mut m = serde_json::Map::new();
        for (i, c) in colunas.iter().enumerate() {
            m.insert(
                c.clone(),
                serde_json::Value::String(r.get(i).cloned().unwrap_or_default()),
            );
        }
        serde_json::Value::Object(m)
    };

    match op.as_str() {
        "colunas" => Ok(serde_json::json!({ "colunas": colunas, "total": total })),
        "resumo" => {
            let mut cats: std::collections::BTreeMap<String, usize> =
                std::collections::BTreeMap::new();
            if let Some(ci) = idx("Category") {
                for r in &registros {
                    *cats.entry(r.get(ci).cloned().unwrap_or_default()).or_insert(0) += 1;
                }
            }
            Ok(serde_json::json!({ "total": total, "por_categoria": cats }))
        }
        "linha_tempo" => {
            let ni = idx("Name");
            let mi = idx("Modified");
            let ai = idx("Accessed");
            let cri = idx("Created");
            let g = |o: Option<usize>, r: &Vec<String>| {
                o.and_then(|i| r.get(i)).cloned().unwrap_or_default()
            };
            let out: Vec<serde_json::Value> = registros
                .iter()
                .take(500)
                .map(|r| {
                    serde_json::json!({
                        "Name": g(ni, r), "Modified": g(mi, r),
                        "Accessed": g(ai, r), "Created": g(cri, r)
                    })
                })
                .collect();
            Ok(serde_json::json!({ "total": total, "itens": out }))
        }
        _ => {
            let q = query.unwrap_or_default().to_lowercase();
            let itens: Vec<serde_json::Value> = registros
                .iter()
                .filter(|r| q.is_empty() || r.iter().any(|f| f.to_lowercase().contains(&q)))
                .take(200)
                .map(to_obj)
                .collect();
            Ok(serde_json::json!({ "colunas": colunas, "total": total, "achados": itens.len(), "itens": itens }))
        }
    }
}

// Serializa um valor JSON-RPC como uma linha [transporte STDIO do MCP].
fn jsonrpc_linha(v: &serde_json::Value) -> String {
    let mut s = serde_json::to_string(v).unwrap_or_default();
    s.push('\n');
    s
}

// Modo C, leitura do caso: cliente MCP por STDIO. Sobe o servidor do IPEDTools,
// faz o handshake [initialize, notifications/initialized] e executa tools/list
// ou tools/call. So leitura; o servidor do IPEDTools opera read-only sobre o caso.
#[tauri::command]
async fn mcp_iped(
    comando: String,
    args: Vec<String>,
    op: String,
    tool: Option<String>,
    arguments: Option<serde_json::Value>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    if comando.trim().is_empty() {
        return Err("comando do servidor MCP nao configurado".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let mut cmd = Command::new(&comando);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(d) = cwd.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.current_dir(d);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("falha ao iniciar o servidor MCP: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("sem stdin no servidor MCP")?;
        let stdout = child.stdout.take().ok_or("sem stdout no servidor MCP")?;
        if let Some(err) = child.stderr.take() {
            std::thread::spawn(move || {
                let r = BufReader::new(err);
                for _l in r.lines().map_while(Result::ok) {}
            });
        }
        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        std::thread::spawn(move || {
            let r = BufReader::new(stdout);
            for linha in r.lines().map_while(Result::ok) {
                let t = linha.trim();
                if t.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        let timeout = Duration::from_secs(120);
        let esperar = |id: i64| -> Result<serde_json::Value, String> {
            let fim = Instant::now() + timeout;
            loop {
                let resta = fim
                    .checked_duration_since(Instant::now())
                    .ok_or("tempo esgotado aguardando o servidor MCP")?;
                match rx.recv_timeout(resta) {
                    Ok(v) => {
                        if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                            return Ok(v);
                        }
                    }
                    Err(_) => return Err("tempo esgotado aguardando o servidor MCP".into()),
                }
            }
        };
        let enviar = |stdin: &mut std::process::ChildStdin, v: &serde_json::Value| -> Result<(), String> {
            stdin
                .write_all(jsonrpc_linha(v).as_bytes())
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())
        };

        let init = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"prova-digital-profamr","version":"0.1.0"}}});
        enviar(&mut stdin, &init)?;
        let init_res = esperar(1)?;
        if let Some(e) = init_res.get("error") {
            let _ = child.kill();
            return Err(format!("initialize falhou: {e}"));
        }
        enviar(
            &mut stdin,
            &serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )?;

        let (metodo, params) = if op == "call" {
            (
                "tools/call",
                serde_json::json!({"name": tool.unwrap_or_default(), "arguments": arguments.unwrap_or_else(|| serde_json::json!({}))}),
            )
        } else {
            ("tools/list", serde_json::json!({}))
        };
        enviar(
            &mut stdin,
            &serde_json::json!({"jsonrpc":"2.0","id":2,"method":metodo,"params":params}),
        )?;
        let res = esperar(2)?;
        let _ = child.kill();
        if let Some(e) = res.get("error") {
            return Err(format!("{metodo} falhou: {e}"));
        }
        Ok(serde_json::json!({
            "server": init_res.get("result").and_then(|r| r.get("serverInfo")).cloned(),
            "result": res.get("result").cloned().unwrap_or(serde_json::Value::Null),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
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
            iped_processar,
            iped_ler_caso,
            mcp_iped
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar a aplicacao Tauri");
}
