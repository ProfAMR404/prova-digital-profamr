// Frontend da Prova Digital ProfAMR [Tauri v2, API global window.__TAURI__].
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;
const fs = window.__TAURI__.fs;

const el = (id) => document.getElementById(id);
const ROTULOS = { sim: "Conforme", nd: "Não documentado", nao: "Não conforme", na: "Não aplicável" };
const CAMPOS = ["autos", "classe", "vara", "arguido", "imp", "etapa", "perito", "data", "hac", "hdef"];
const IDENT_MAP = { processo: "i-processo", perito: "i-perito", imei: "i-imei", serie: "i-serie", lacre: "i-lacre", hash: "i-hash", conta: "i-conta", provedor: "i-provedor", ordem_judicial: "i-ordem" };

// app.laudos: lista de laudos do caso. app.ativo: indice do laudo em edicao.
// estado/obs/sugestoes apontam para o laudo ativo; ident fica nos inputs do DOM.
const app = { id: null, dados: null, tipos: new Set(), laudos: [], ativo: -1, laudo: null, nome: null, estado: {}, obs: {}, sugestoes: {} };

function novoId() {
  return "c" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function estadoVazio() {
  const e = {}, o = {};
  app.dados.BLOCOS.forEach((b) => b.itens.forEach((i) => { e[i.id] = null; o[i.id] = ""; }));
  return { estado: e, obs: o };
}

function novoLaudoObj() {
  const z = estadoVazio();
  return { id: novoId(), nome: null, caminho: null, data: null, estado: z.estado, obs: z.obs, sugestoes: {}, ident: {} };
}

async function carregarItens() {
  const r = await fetch("itens.json");
  app.dados = await r.json();
  novoCaso();
  listarCasos();
}

// ---- tipos de prova -------------------------------------------------------
function montarTipos() {
  const c = el("tipos");
  c.innerHTML = app.dados.TIPOS.map(
    (t) =>
      `<label class="tipo-chip ${app.tipos.has(t.id) ? "on" : ""}" id="chip-${t.id}">
        <input type="checkbox" ${app.tipos.has(t.id) ? "checked" : ""} data-id="${t.id}"> ${escapar(t.nome)}
      </label>`
  ).join("");
  c.querySelectorAll("input[type=checkbox]").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) app.tipos.add(id);
      else app.tipos.delete(id);
      el("chip-" + id).classList.toggle("on", e.target.checked);
      renderBlocos();
      atualizarVeredito();
    })
  );
}

function aplicavel(item) {
  if (!item.tipos) return true;
  return item.tipos.some((t) => app.tipos.has(t));
}

// ---- blocos e itens -------------------------------------------------------
function renderBlocos() {
  const c = el("blocos");
  c.innerHTML = app.dados.BLOCOS.map((b) => {
    const itens = b.itens
      .map((i) => {
        const ap = aplicavel(i);
        const s = app.sugestoes[i.id];
        let sug = "";
        if (s) {
          const pg = s.pagina ? "[pág. " + s.pagina + "]" : "[" + (s.confianca || "indício") + "]";
          const tr = s.trecho ? `<div class="strecho">${escapar(s.trecho)}</div>` : "";
          // Só sugere resposta quando há juízo [negação detectada ou modelo]. Mera
          // menção de termo não vira "Conforme": aparece como indício a conferir.
          sug = s.resposta
            ? `<div class="sugestao">Sugestão: <b>${ROTULOS[s.resposta] || "—"}</b> ${pg}
                 <button type="button" class="aplicar" data-id="${i.id}" data-resp="${s.resposta}">Aplicar</button>${tr}</div>`
            : `<div class="sugestao sug-mencao">Menção ao tema ${pg}, sem juízo automático. Responda manualmente.${tr}</div>`;
        }
        const opts = ["", "sim", "nd", "nao", "na"]
          .map((k) => `<option value="${k}" ${app.estado[i.id] === k ? "selected" : ""}>${k ? ROTULOS[k] : "—"}</option>`)
          .join("");
        return `<div class="item ${ap ? "" : "inaplicavel"}">
          <div class="txt"><p><span class="cod">${i.id}</span>${escapar(i.txt)}</p>
            <div class="fund">${escapar(i.fund || "")}</div>${sug}
            <input class="obs" data-id="${i.id}" ${ap ? "" : "disabled"} placeholder="Observação: onde consta no laudo [evento, página, trecho]" value="${escapar(app.obs[i.id] || "")}"></div>
          <select data-id="${i.id}" class="resp" ${ap ? "" : "disabled"}>${opts}</select>
        </div>`;
      })
      .join("");
    return `<section class="bloco"><h3>${escapar(b.titulo)}</h3>${itens}</section>`;
  }).join("");
  c.querySelectorAll("select.resp").forEach((s) =>
    s.addEventListener("change", (e) => { app.estado[e.target.dataset.id] = e.target.value || null; atualizarVeredito(); })
  );
  c.querySelectorAll("input.obs").forEach((o) =>
    o.addEventListener("input", (e) => { app.obs[e.target.dataset.id] = e.target.value; })
  );
  c.querySelectorAll("button.aplicar").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const id = e.target.dataset.id, r = e.target.dataset.resp;
      app.estado[id] = r;
      const sel = c.querySelector(`select.resp[data-id="${id}"]`);
      if (sel) sel.value = r;
      atualizarVeredito();
    })
  );
}

// ---- classificacao e veredito ---------------------------------------------
function classificar() {
  const d = app.dados;
  const idx = {};
  d.BLOCOS.forEach((b) => b.itens.forEach((i) => (idx[i.id] = i)));
  const vale = (id) => idx[id] && aplicavel(idx[id]);
  // P3: "nao conforme" [defeito comprovado] e "nao documentado" [nd] tem efeitos
  // distintos. So o defeito comprovado derruba uma porta ou aciona a quebra; a
  // falta de documentacao, superavel por verificacao independente, fica no arranhao.
  const temNao = (ids) => ids.some((i) => vale(i) && app.estado[i] === "nao");
  const listarNao = (ids) => ids.filter((i) => vale(i) && app.estado[i] === "nao").map((i) => i + " [não conforme]").join(", ");
  const listar = (ids) => ids.filter((i) => vale(i) && ["nd", "nao"].includes(app.estado[i]))
    .map((i) => i + " [" + (app.estado[i] === "nao" ? "não conforme" : "não documentado") + "]").join(", ");
  const aplicaveis = [];
  d.BLOCOS.forEach((b) => b.itens.forEach((i) => { if (aplicavel(i)) aplicaveis.push(i.id); }));
  if (app.tipos.size === 0)
    return { estado: "neutro", titulo: "Selecione o tipo de prova", corpo: "Na aba Caso, marque ao menos um tipo de prova em exame." };
  const pend = aplicaveis.some((id) => app.estado[id] === null);
  if (pend)
    return { estado: "neutro", titulo: "Diagnóstico provisório", corpo: "Confirme ou ajuste cada item aplicável para o veredito conclusivo." };
  if (temNao(d.portas.porta1) || temNao(d.portas.porta2))
    return { estado: "vermelho", titulo: "Inexistência da cadeia de custódia: inadmissibilidade", corpo: "Defeito comprovado em ao menos uma das duas portas [cadeia documentada; dado bruto com hash de origem]. Itens: " + listarNao([].concat(d.portas.porta1, d.portas.porta2)) + ". A inadmissibilidade é aferida no caso concreto, conforme o prejuízo ao contraditório e à ampla defesa [CPP, art. 157, § 1º; arts. 158-A a 158-F]." };
  if (temNao(d.quebra))
    return { estado: "laranja", titulo: "Quebra da cadeia de custódia: até a imprestabilidade", corpo: "Com as duas portas presentes, defeito comprovado que a verificação independente não supera. Itens: " + listarNao(d.quebra) + ". A imprestabilidade é aferida no caso concreto." };
  if (aplicaveis.some((id) => ["nd", "nao"].includes(app.estado[id])))
    return { estado: "amarelo", titulo: "Arranhão da cadeia de custódia: desconto no peso", corpo: "Desconformidade superável pela verificação independente, inclusive falta de documentação em porta, preservada a admissibilidade. Itens: " + listar(aplicaveis) + "." };
  return { estado: "verde", titulo: "Conformidade plena: elemento admissível", corpo: "As duas portas presentes e nenhuma desconformidade entre os itens aplicáveis." };
}

// Norma de referência comum, exibida junto ao veredito e nas saídas.
const NORMAS = "CPP [arts. 158-A a 158-F], ABNT NBR ISO/IEC 27037 e POPs do MJSP";

function atualizarVeredito() {
  const v = classificar();
  const box = el("veredito");
  box.hidden = false;
  box.className = "veredito " + v.estado;
  box.innerHTML = `<b>${v.titulo}</b><span>${v.corpo}</span><em>Classificação pelo grau de conformidade com ${NORMAS}.</em>`;
}

// ---- ficha do caso --------------------------------------------------------
function lerCaso() {
  const caso = {};
  CAMPOS.forEach((k) => (caso[k] = (el("k-" + k) && el("k-" + k).value) || ""));
  return caso;
}

function setCaso(caso) {
  caso = caso || {};
  CAMPOS.forEach((k) => { const e = el("k-" + k); if (e) e.value = caso[k] || ""; });
}

// ---- identificacao do exame ----------------------------------------------
function preencherIdent(ident) {
  el("ident-box").hidden = false;
  Object.keys(IDENT_MAP).forEach((k) => {
    const inp = el(IDENT_MAP[k]);
    if (inp && ident[k] && !inp.value) inp.value = ident[k];
  });
  validarIdent();
}

function setIdent(ident) {
  ident = ident || {};
  Object.keys(IDENT_MAP).forEach((k) => { const inp = el(IDENT_MAP[k]); if (inp) inp.value = ident[k] || ""; });
  validarIdent();
}

function lerIdent() {
  const out = {};
  Object.keys(IDENT_MAP).forEach((k) => { const e = el(IDENT_MAP[k]); const v = e && e.value.trim(); if (v) out[k] = v; });
  return out;
}

function validaProcesso(v) {
  const d = (v || "").replace(/\D/g, "");
  if (d.length !== 20) return null;
  const base = BigInt(d.slice(0, 7) + d.slice(9) + "00");
  return 98n - (base % 97n) === BigInt(d.slice(7, 9));
}
function validaIMEI(v) {
  const d = (v || "").replace(/\D/g, "");
  if (d.length === 14) return null;
  if (d.length !== 15) return false;
  let s = 0;
  for (let i = 0; i < 15; i++) { let n = +d[i]; if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; } s += n; }
  return s % 10 === 0;
}
function tipoHash(v) {
  const h = (v || "").replace(/\s/g, "");
  if (!h) return "";
  if (!/^[0-9a-f]+$/i.test(h)) return "hex inválido";
  const m = { 32: "MD5 [legado]", 40: "SHA-1 [legado]", 64: "SHA-256", 128: "SHA-512" };
  return m[h.length] || "comprimento atípico";
}
function marca(span, estado, texto) {
  if (!span) return;
  span.className = "val " + (estado === true ? "ok" : estado === false ? "err" : "");
  span.textContent = texto;
}
function validarIdent() {
  const p = validaProcesso(el("i-processo").value);
  marca(el("v-processo"), p, p === true ? "[CNJ: verificador ok]" : p === false ? "[conferir CNJ]" : "");
  const im = validaIMEI(el("i-imei").value);
  marca(el("v-imei"), im, im === true ? "[IMEI: Luhn ok]" : im === false ? "[IMEI inválido]" : "");
  const th = tipoHash(el("i-hash").value);
  const okh = th && th.indexOf("inválido") < 0 && th.indexOf("atípico") < 0;
  marca(el("v-hash"), th ? (okh ? true : false) : null, th ? "[" + th + "]" : "");
}

// ---- laudos do caso -------------------------------------------------------
function capturarAtivo() {
  if (app.ativo < 0 || !app.laudos[app.ativo]) return;
  const L = app.laudos[app.ativo];
  L.estado = app.estado;
  L.obs = app.obs;
  L.sugestoes = app.sugestoes;
  L.caminho = app.laudo;
  L.nome = app.nome;
  L.ident = lerIdent();
}

function aplicarAtivo() {
  const L = app.laudos[app.ativo];
  app.estado = L.estado || {};
  app.obs = L.obs || {};
  app.sugestoes = L.sugestoes || {};
  app.laudo = L.caminho || null;
  app.nome = L.nome || null;
  app.dados.BLOCOS.forEach((b) => b.itens.forEach((i) => {
    if (!(i.id in app.estado)) app.estado[i.id] = null;
    if (!(i.id in app.obs)) app.obs[i.id] = "";
  }));
  el("arquivo").textContent = app.nome || "Nenhum laudo selecionado";
  const temIdent = L.ident && Object.keys(L.ident).length > 0;
  el("ident-box").hidden = !temIdent;
  setIdent(L.ident || {});
  mostrarNotaOcr(!!L.ocr);
  mostrarProveniencia(L);
  renderBlocos();
  atualizarVeredito();
  renderLaudos();
}

function mostrarNotaOcr(on) {
  const n = el("ident-nota");
  if (n) n.hidden = !on;
}

function mostrarProveniencia(L) {
  const p = el("proveniencia");
  if (!p) return;
  p.classList.remove("prov-alerta");
  if (L && L.sha256) {
    p.hidden = false;
    p.textContent = "Integridade da análise: SHA-256 do laudo " + L.sha256 + (L.analisado_em ? " · análise em " + fmtData(L.analisado_em) : "");
  } else {
    p.hidden = true;
  }
}

// F1: ao reabrir, re-calcula o hash do laudo e avisa se o arquivo mudou.
async function verificarIntegridade(L) {
  if (!L || !L.caminho || !L.sha256) return;
  const p = el("proveniencia");
  if (!p) return;
  try {
    const atual = await invoke("hash_arquivo", { caminho: L.caminho });
    if (!atual) return;
    if (atual.toLowerCase() === L.sha256.toLowerCase()) {
      p.textContent += " · arquivo íntegro";
    } else {
      p.hidden = false;
      p.classList.add("prov-alerta");
      p.textContent = "ATENÇÃO: o laudo em " + L.caminho + " mudou desde a análise. SHA-256 atual " + atual + ", registrado " + L.sha256 + ". Reanalise o laudo.";
    }
  } catch (e) {
    p.textContent += " · arquivo não acessível para conferência";
  }
}

function renderLaudos() {
  const sel = el("laudo-sel");
  sel.innerHTML = app.laudos
    .map((L, i) => `<option value="${i}" ${i === app.ativo ? "selected" : ""}>Laudo ${i + 1}${L.nome ? ": " + escapar(L.nome) : " [sem arquivo]"}</option>`)
    .join("");
  el("btn-excluir-laudo").disabled = app.laudos.length <= 1;
}

function novoLaudo() {
  capturarAtivo();
  app.laudos.push(novoLaudoObj());
  app.ativo = app.laudos.length - 1;
  habilitarSaidas(false);
  aplicarAtivo();
}

function trocarLaudo(i) {
  capturarAtivo();
  app.ativo = i;
  aplicarAtivo();
  verificarIntegridade(app.laudos[app.ativo]);
}

function excluirLaudo() {
  if (app.laudos.length <= 1) return;
  app.laudos.splice(app.ativo, 1);
  app.ativo = Math.max(0, app.ativo - 1);
  aplicarAtivo();
}

// ---- persistencia de casos ------------------------------------------------
function novoCaso() {
  app.id = null;
  app.tipos = new Set();
  app.laudos = [novoLaudoObj()];
  app.ativo = 0;
  setCaso({});
  montarTipos();
  habilitarSaidas(false);
  el("caso-status").textContent = "Caso novo, ainda não salvo.";
  aplicarAtivo();
}

async function salvarCaso() {
  capturarAtivo();
  if (!app.id) app.id = novoId();
  const dados = {
    id: app.id,
    atualizado: new Date().toISOString(),
    caso: lerCaso(),
    tipos: [...app.tipos],
    ativo: app.ativo,
    laudos: app.laudos.map((L) => ({ id: L.id, nome: L.nome, caminho: L.caminho, data: L.data, sha256: L.sha256 || null, analisado_em: L.analisado_em || null, ocr: !!L.ocr, estado: L.estado, obs: L.obs, sugestoes: L.sugestoes, ident: L.ident })),
  };
  try {
    app.id = await invoke("salvar_caso", { id: app.id, dados });
    el("caso-status").textContent = "Caso salvo na máquina [" + new Date().toLocaleString("pt-BR") + "].";
    listarCasos();
  } catch (e) {
    el("caso-status").textContent = "Falha ao salvar: " + e;
  }
}

async function listarCasos() {
  let lista = [];
  try { lista = await invoke("listar_casos"); } catch (e) { lista = []; }
  const c = el("casos-lista");
  if (!lista.length) { c.innerHTML = `<p class="nota">Nenhum caso salvo ainda. Preencha a ficha e use Salvar caso.</p>`; return; }
  c.innerHTML = lista
    .map((x) => `<div class="caso-row">
        <button type="button" class="link-caso" data-id="${escapar(x.id)}">${escapar(x.autos || "[sem autos]")} · ${escapar(x.arguido || "[sem arguido]")}</button>
        <span class="caso-meta">${x.nlaudos} laudo(s) · ${escapar(fmtData(x.atualizado))}</span>
        <button type="button" class="btn-excluir" data-id="${escapar(x.id)}">Excluir</button>
      </div>`)
    .join("");
  c.querySelectorAll(".link-caso").forEach((b) => b.addEventListener("click", (e) => carregarCasoId(e.target.dataset.id)));
  c.querySelectorAll(".btn-excluir").forEach((b) => b.addEventListener("click", (e) => excluirCasoId(e.target.dataset.id)));
}

async function carregarCasoId(id) {
  let v;
  try { v = await invoke("carregar_caso", { id }); } catch (e) { el("caso-status").textContent = "Falha ao carregar: " + e; return; }
  app.id = v.id || id;
  setCaso(v.caso || {});
  app.tipos = new Set(v.tipos || []);
  montarTipos();
  const z = estadoVazio();
  app.laudos = (v.laudos && v.laudos.length ? v.laudos : [novoLaudoObj()]).map((L) => ({
    id: L.id || novoId(), nome: L.nome || null, caminho: L.caminho || null, data: L.data || null,
    sha256: L.sha256 || null, analisado_em: L.analisado_em || null, ocr: !!L.ocr,
    estado: Object.assign({}, z.estado, L.estado || {}), obs: Object.assign({}, z.obs, L.obs || {}),
    sugestoes: L.sugestoes || {}, ident: L.ident || {},
  }));
  app.ativo = typeof v.ativo === "number" && v.ativo >= 0 && v.ativo < app.laudos.length ? v.ativo : 0;
  const temAnalise = app.laudos.some((L) => L.nome || Object.keys(L.sugestoes).length);
  habilitarSaidas(temAnalise);
  el("caso-status").textContent = "Caso carregado [" + fmtData(v.atualizado) + "].";
  aplicarAtivo();
  verificarIntegridade(app.laudos[app.ativo]);
  mostrarAba("caso");
}

async function excluirCasoId(id) {
  try { await invoke("excluir_caso", { id }); } catch (e) { el("caso-status").textContent = "Falha ao excluir: " + e; return; }
  if (app.id === id) { app.id = null; el("caso-status").textContent = "Caso excluído. A cópia aberta continua em edição até salvar de novo."; }
  listarCasos();
}

function fmtData(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR");
}

// ---- analise do laudo -----------------------------------------------------
async function escolherArquivo() {
  const escolha = await dialog.open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (escolha) {
    app.laudo = escolha;
    app.nome = escolha.replace(/^.*[\\/]/, "");
    if (app.laudos[app.ativo]) { app.laudos[app.ativo].caminho = escolha; app.laudos[app.ativo].nome = app.nome; }
    el("arquivo").textContent = app.nome;
    renderLaudos();
  }
}

async function analisar() {
  if (!app.laudo) { el("progresso").textContent = "Escolha um laudo primeiro."; return; }
  if (app.tipos.size === 0) { el("progresso").textContent = "Marque o tipo de prova na aba Caso."; return; }
  el("btn-analisar").disabled = true;
  el("progresso").textContent = "Iniciando…";
  const parar = await listen("progresso", (ev) => (el("progresso").textContent = ev.payload));
  try {
    const res = await invoke("analisar", { caminho: app.laudo, llm: el("llm").checked, ocr: el("ocr").checked, tipos: [...app.tipos] });
    app.sugestoes = res.sugestoes || {};
    const ident = res.identificacao || {};
    const nocr = (res.paginas_ocr || []).length;
    if (ident.processo && el("k-autos") && !el("k-autos").value) el("k-autos").value = ident.processo;
    preencherIdent(ident);
    mostrarNotaOcr(nocr > 0);
    const L = app.laudos[app.ativo];
    if (L) {
      L.sugestoes = app.sugestoes;
      L.data = new Date().toISOString();
      L.analisado_em = res.analisado_em || L.data;
      L.sha256 = res.laudo_sha256 || null;
      L.ocr = nocr > 0;
      L.ident = lerIdent();
    }
    mostrarProveniencia(L);
    renderBlocos();
    atualizarVeredito();
    renderLaudos();
    habilitarSaidas(true);
    // Coerência entre o tipo de prova marcado e os indícios do laudo [F4].
    const sugTipos = (res.tipos_sugeridos || []).filter((t) => !app.tipos.has(t));
    const nomesTipo = {};
    app.dados.TIPOS.forEach((t) => (nomesTipo[t.id] = t.nome));
    const aviso = sugTipos.length ? " O laudo indica também: " + sugTipos.map((t) => nomesTipo[t] || t).join(", ") + ". Reveja o tipo de prova na aba Caso." : "";
    el("progresso").textContent = (nocr ? "OCR recuperou texto em " + nocr + " página(s) escaneada(s); confira hash e IMEI no laudo. " : "") + "Sugestões por indício prontas. Confirme item a item; o padrão é pendente." + aviso;
  } catch (e) {
    el("progresso").textContent = "Falha: " + e;
  } finally {
    parar();
    el("btn-analisar").disabled = false;
  }
}

// ---- saida ----------------------------------------------------------------
function gerarMinutas() {
  const caso = lerCaso();
  let t = "MINUTAS DE FUNDAMENTAÇÃO · ITENS DESCONFORMES\n";
  if (caso.autos) t += "Autos n. " + caso.autos + "\n";
  if (caso.arguido) t += "Arguido: " + caso.arguido + "\n";
  if (app.nome) t += "Laudo: " + app.nome + "\n";
  t += "\n";
  let n = 0;
  app.dados.BLOCOS.forEach((b) =>
    b.itens.forEach((i) => {
      if (aplicavel(i) && ["nd", "nao"].includes(app.estado[i.id]) && i.minuta) {
        n++;
        t += `[${i.id}] ${i.minuta}\n`;
        if (app.obs[i.id]) t += `(Referência nos autos: ${app.obs[i.id]})\n`;
        t += "\n";
      }
    })
  );
  if (!n) t += "Nenhum item desconforme entre os aplicáveis.\n";
  el("saida").value = t;
  el("saidaBox").hidden = false;
  el("relatorio").hidden = true;
  el("btn-imprimir").hidden = false;
  mostrarAba("saida");
}

async function exportar() {
  capturarAtivo();
  const dados = {
    id: app.id,
    caso: lerCaso(),
    tipos: [...app.tipos],
    laudos: app.laudos.map((L) => ({ nome: L.nome, data: L.data, identificacao: L.ident, respostas: L.estado, observacoes: L.obs, sugestoes: L.sugestoes })),
    laudoAtivo: app.nome,
    veredito: classificar(),
  };
  const destino = await dialog.save({ defaultPath: "analise-prova-digital.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (destino) {
    await fs.writeTextFile(destino, JSON.stringify(dados, null, 1));
    el("progresso").textContent = "Exportado: " + destino;
  }
}

// ---- saidas: relatorio, termo, PDF [Fase 5] -------------------------------
function habilitarSaidas(on) {
  ["btn-relatorio", "btn-termo", "btn-minutas", "btn-exportar", "btn-rmcr"].forEach((id) => { const b = el(id); if (b) b.disabled = !on; });
  if (!on) { el("btn-imprimir").hidden = true; }
}

function nomeTipos() {
  const m = {};
  app.dados.TIPOS.forEach((t) => (m[t.id] = t.nome));
  return [...app.tipos].map((t) => m[t] || t);
}

// Veredito de um laudo especifico [tipos sao do caso].
function vereditoDe(laudo) {
  const salvo = app.estado;
  app.estado = laudo.estado || {};
  const v = classificar();
  app.estado = salvo;
  return v;
}

function itensRespondidos(laudo) {
  const linhas = [];
  app.dados.BLOCOS.forEach((b) => b.itens.forEach((i) => {
    if (!aplicavel(i)) return;
    const r = (laudo.estado || {})[i.id];
    if (!r) return;
    linhas.push({ id: i.id, txt: i.txt, resposta: ROTULOS[r] || r, chave: r, obs: (laudo.obs || {})[i.id] || "" });
  }));
  return linhas;
}

function gerarRelatorio() {
  capturarAtivo();
  const caso = lerCaso();
  const cab = [
    ["Autos n.", caso.autos], ["Classe", caso.classe], ["Vara / Órgão", caso.vara],
    ["Arguido", caso.arguido], ["Imputação", caso.imp], ["Etapa", caso.etapa],
    ["Perito / Órgão", caso.perito], ["Data", caso.data],
  ].filter(([, v]) => v).map(([k, v]) => `<tr><th>${escapar(k)}</th><td>${escapar(v)}</td></tr>`).join("");
  const tipos = nomeTipos();
  let laudosHtml = "";
  app.laudos.forEach((L, i) => {
    const v = vereditoDe(L);
    const ident = L.ident || {};
    const idRows = Object.keys(IDENT_MAP).map((k) => ident[k] ? `<tr><th>${escapar(k)}</th><td>${escapar(ident[k])}</td></tr>` : "").join("");
    const linhas = itensRespondidos(L);
    const corpoItens = linhas.length
      ? linhas.map((x) => `<tr><td class="cod">${escapar(x.id)}</td><td>${escapar(x.txt)}</td><td class="r r-${x.chave}">${escapar(x.resposta)}</td><td>${escapar(x.obs)}</td></tr>`).join("")
      : `<tr><td colspan="4">Nenhum item respondido.</td></tr>`;
    const prov = L.sha256 ? `<p class="rel-prov">Integridade da análise: SHA-256 do laudo ${escapar(L.sha256)}${L.analisado_em ? " · análise em " + escapar(fmtData(L.analisado_em)) : ""}${L.ocr ? " · lido por OCR, conferir hash e IMEI no laudo" : ""}</p>` : "";
    laudosHtml += `<section class="rel-laudo">
      <h3>Laudo ${i + 1}${L.nome ? ": " + escapar(L.nome) : ""}</h3>
      <div class="rel-vered v-${v.estado}"><b>${escapar(v.titulo)}</b><span>${escapar(v.corpo)}</span></div>
      ${prov}
      ${idRows ? `<table class="rel-id"><caption>Identificação</caption>${idRows}</table>` : ""}
      <table class="rel-itens"><thead><tr><th>Cód.</th><th>Item</th><th>Resposta</th><th>Observação</th></tr></thead><tbody>${corpoItens}</tbody></table>
    </section>`;
  });
  const html = `<div class="rel-doc">
    <header class="rel-head"><span class="rel-wm">Prof. AMR</span><h1>Aferição da cadeia de custódia da prova digital</h1></header>
    <table class="rel-caso">${cab || '<tr><td>Ficha do caso não preenchida.</td></tr>'}</table>
    <p class="rel-tipos"><b>Tipo de prova em exame:</b> ${tipos.length ? escapar(tipos.join(", ")) : "não selecionado"}</p>
    ${laudosHtml}
    <p class="rel-rodape">Classificação pelo grau de conformidade com ${NORMAS}, em três níveis: inexistência, arranhão e quebra. Documento de apoio à análise, não laudo nem parecer. A confirmação de cada item é humana. Processamento local.</p>
  </div>`;
  el("relatorio").innerHTML = html;
  el("relatorio").hidden = false;
  el("saidaBox").hidden = true;
  el("btn-imprimir").hidden = false;
  mostrarAba("saida");
}

const CONSEQUENCIA = {
  vermelho: "Reconhecida a inexistência da cadeia de custódia, pela falta de ao menos uma das duas portas [cadeia documentada do reconhecimento ao descarte; dado bruto com o hash de origem], o elemento tende à inadmissibilidade. A consequência é aferida no caso concreto, segundo o prejuízo ao contraditório e à ampla defesa, podendo levar ao desentranhamento do elemento e das provas dele derivadas [CPP, art. 157, § 1º; arts. 158-A a 158-F].",
  laranja: "Reconhecida a quebra da cadeia de custódia, com as duas portas presentes mas desconformidade que a verificação independente não supera, o elemento pode ser imprestável. A exclusão da valoração é aferida no caso concreto, conforme o prejuízo demonstrado.",
  amarelo: "Reconhecido o arranhão da cadeia de custódia, com as duas portas presentes e desconformidade superada pela verificação independente, preserva-se a admissibilidade e procede-se ao desconto no peso probatório na valoração do conjunto [CPP, art. 155].",
  verde: "Reconhecida a conformidade plena da cadeia de custódia, o elemento é admissível e íntegro, sem reparo quanto à forma dos arts. 158-A a 158-F do CPP.",
  neutro: "Aferição ainda não conclusiva. Confirme cada item aplicável antes de lavrar o termo.",
};

function termoModelo() {
  capturarAtivo();
  const caso = lerCaso();
  const L = app.laudos[app.ativo] || {};
  const v = vereditoDe(L);
  let t = "TERMO DE AFERIÇÃO DA CADEIA DE CUSTÓDIA DA PROVA DIGITAL\n";
  t += "[minuta de fundamentação, sujeita a revisão e complementação]\n\n";
  if (caso.autos) t += "Autos n. " + caso.autos + "\n";
  if (caso.classe) t += "Classe: " + caso.classe + "\n";
  if (caso.vara) t += "Vara / Órgão: " + caso.vara + "\n";
  if (caso.arguido) t += "Arguido: " + caso.arguido + "\n";
  if (caso.imp) t += "Imputação: " + caso.imp + "\n";
  t += "Tipo de prova em exame: " + (nomeTipos().join(", ") || "não selecionado") + "\n";
  if (L.nome) t += "Laudo: " + L.nome + "\n";
  if (L.sha256) t += "SHA-256 do laudo: " + L.sha256 + (L.ocr ? " [lido por OCR, conferir no laudo]" : "") + "\n";
  if (L.analisado_em) t += "Análise em: " + fmtData(L.analisado_em) + "\n";
  const ident = L.ident || {};
  const idTxt = Object.keys(IDENT_MAP).filter((k) => ident[k]).map((k) => k + " " + ident[k]).join("; ");
  if (idTxt) t += "Identificação do vestígio: " + idTxt + "\n";
  t += "\nI. Resultado da aferição\n" + v.titulo + ". " + v.corpo + "\n";
  t += "\nII. Fundamentação\n" + (CONSEQUENCIA[v.estado] || "") + "\n";
  const desconf = [];
  app.dados.BLOCOS.forEach((b) => b.itens.forEach((i) => {
    if (aplicavel(i) && ["nd", "nao"].includes((L.estado || {})[i.id]) && i.minuta) {
      desconf.push("[" + i.id + "] " + i.minuta + ((L.obs || {})[i.id] ? " Referência nos autos: " + L.obs[i.id] + "." : ""));
    }
  }));
  if (desconf.length) {
    t += "\nIII. Pontos de desconformidade apurados\n" + desconf.join("\n") + "\n";
  }
  t += "\nIV. Precedente\n[inserir precedente verificado na fonte oficial, se houver]\n";
  t += "\nV. Conclusão\n[redigir a conclusão conforme o resultado acima e o pedido das partes]\n";
  t += "\nClassificação pelo grau de conformidade com " + NORMAS + ". Minuta de apoio, não laudo nem parecer. A confirmação dos itens e a valoração cabem ao agente processual.\n";
  el("saida").value = t;
  el("saidaBox").hidden = false;
  el("relatorio").hidden = true;
  el("btn-imprimir").hidden = false;
  mostrarAba("saida");
}

function imprimir() {
  if (el("saidaBox").hidden === false) {
    el("relatorio").innerHTML = "<pre class='doc-txt'>" + escapar(el("saida").value) + "</pre>";
  }
  const estava = el("relatorio").hidden;
  el("relatorio").hidden = false;
  window.print();
  if (estava) el("relatorio").hidden = true;
}

// ---- Fase 6: exportacao mapeada para o schema RMCr [casos.*] --------------
// Colunas conferidas nas migrations 0028/0033 do repo ProfAMR404/rmcr-penal
// [projeto Supabase rrjnnoxpkwpioasmecax]. Nao escreve no banco, so gera arquivo.
function mapEnum(txt, dic) {
  const s = (txt || "").toLowerCase();
  for (const [chave, alvo] of dic) { if (s.includes(chave)) return alvo; }
  return null;
}
const MAP_CLASSE = [["apelaç", "apelacao"], ["apelac", "apelacao"], ["recurso em sentido", "recurso_em_sentido_estrito"], ["rese", "rese"], ["habeas", "habeas_corpus"], ["mandado de seg", "mandado_seguranca"], ["revisão", "revisao_criminal"], ["revisao", "revisao_criminal"], ["agravo", "agravo_execucao"], ["embargos de decl", "embargos_declaratorios"], ["embargos infring", "embargos_infringentes"], ["inquérito", "inquerito_policial"], ["inquerito", "inquerito_policial"], ["ação penal privada", "acao_penal_privada"], ["ação penal", "acao_penal_publica"], ["acao penal", "acao_penal_publica"]];
const MAP_FASE = [["investiga", "investigacao_preliminar"], ["inquérito", "investigacao_preliminar"], ["denúncia recebida", "denuncia_recebida"], ["denuncia recebida", "denuncia_recebida"], ["denúncia", "denuncia_oferecida"], ["denuncia", "denuncia_oferecida"], ["instru", "instrucao"], ["alega", "alegacoes_finais"], ["sentença", "sentenca"], ["sentenca", "sentenca"], ["apela", "recurso_primeiro_grau"], ["segundo grau", "segundo_grau"], ["tribunal", "segundo_grau"], ["superior", "recurso_superior"], ["trânsito", "transito_julgado"], ["transito", "transito_julgado"], ["execu", "execucao"], ["arquiv", "arquivado"], ["extin", "extinto"]];
const MAP_ADMISS = { vermelho: "inadmitida_ilegitima", laranja: "imprestavel", amarelo: "admitida", verde: "admitida", neutro: null };

function exportarRMCr() {
  capturarAtivo();
  const caso = lerCaso();
  const provas = app.laudos.map((L) => {
    const v = vereditoDe(L);
    const ident = L.ident || {};
    const notas = [];
    if (ident.hash) notas.push("hash " + ident.hash);
    if (ident.lacre) notas.push("lacre " + ident.lacre);
    if (ident.conta) notas.push("conta " + ident.conta);
    if (ident.provedor) notas.push("provedor " + ident.provedor);
    if (ident.ordem_judicial) notas.push(ident.ordem_judicial);
    if (L.sha256) notas.push("SHA-256 do laudo " + L.sha256 + (L.ocr ? " [OCR, conferir]" : ""));
    if (L.analisado_em) notas.push("análise em " + fmtData(L.analisado_em));
    return {
      titulo: L.nome || "Prova digital",
      fonte: "laudo pericial",
      autoridade_produtora: caso.perito || ident.perito || null,
      digital_dispositivo: ident.imei || ident.serie || null,
      digital_serial: ident.serie || null,
      digital_ferramenta: null,
      conclusao: v.titulo,
      custodia_iniciada: true,
      admissibilidade: MAP_ADMISS[v.estado] || null,
      fundamento_inadmissibilidade: ["vermelho", "laranja"].includes(v.estado) ? v.corpo : null,
      notas: notas.join("; ") || null,
    };
  });
  const laudoAtivo = app.laudos[app.ativo] || {};
  const dados = {
    _schema: "rmcr-casos",
    _versao: "1",
    _origem: "prova-digital-profamr",
    _proveniencia: { ferramenta: "prova-digital-profamr", laudo_sha256: laudoAtivo.sha256 || null, analisado_em: laudoAtivo.analisado_em || null },
    _observacao: "Mapa para o schema casos.* do RMCr. imputacao e partes exigem vinculo a tipo_penal e usuario no destino; aqui vao como texto. Nenhuma escrita no banco.",
    processo: {
      numero_cnj: caso.autos || null,
      orgao_julgador: caso.vara || null,
      classe_processual: mapEnum(caso.classe, MAP_CLASSE),
      classe_texto: caso.classe || null,
      fase_processual: mapEnum(caso.etapa, MAP_FASE),
      fase_texto: caso.etapa || null,
      titulo: caso.classe || caso.arguido || null,
      sinopse: caso.hac || null,
      observacoes: [caso.hdef ? "HDef: " + caso.hdef : "", caso.imp ? "Imputação: " + caso.imp : ""].filter(Boolean).join(" | ") || null,
      data_fato: caso.data || null,
    },
    partes: caso.arguido ? [{ nome: caso.arguido, papel: "arguido" }] : [],
    provas: provas,
  };
  exportarJsonArquivo(dados, "caso-rmcr.json", "Exportado para o RMCr: ");
}

async function exportarJsonArquivo(dados, nome, prefixo) {
  const destino = await dialog.save({ defaultPath: nome, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (destino) {
    await fs.writeTextFile(destino, JSON.stringify(dados, null, 2));
    el("progresso").textContent = (prefixo || "Exportado: ") + destino;
  }
}

function escapar(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function mostrarAba(q) {
  [["caso", "p-caso", "t-caso"], ["analise", "p-analise", "t-analise"], ["saida", "p-saida", "t-saida"], ["instrucoes", "p-instrucoes", "t-instrucoes"]].forEach(([k, p, t]) => {
    const on = k === q;
    el(p).hidden = !on;
    el(t).classList.toggle("on", on);
  });
  window.scrollTo({ top: 0 });
}

el("btn-arquivo").addEventListener("click", escolherArquivo);
el("btn-analisar").addEventListener("click", analisar);
el("btn-minutas").addEventListener("click", gerarMinutas);
el("btn-exportar").addEventListener("click", exportar);
el("btn-relatorio").addEventListener("click", gerarRelatorio);
el("btn-termo").addEventListener("click", termoModelo);
el("btn-rmcr").addEventListener("click", exportarRMCr);
el("btn-imprimir").addEventListener("click", imprimir);
el("btn-salvar-caso").addEventListener("click", salvarCaso);
el("btn-novo-caso").addEventListener("click", novoCaso);
el("btn-novo-laudo").addEventListener("click", novoLaudo);
el("btn-excluir-laudo").addEventListener("click", excluirLaudo);
el("laudo-sel").addEventListener("change", (e) => trocarLaudo(+e.target.value));
el("t-caso").addEventListener("click", () => mostrarAba("caso"));
el("t-analise").addEventListener("click", () => mostrarAba("analise"));
el("t-saida").addEventListener("click", () => mostrarAba("saida"));
el("t-instrucoes").addEventListener("click", () => mostrarAba("instrucoes"));
["i-processo", "i-imei", "i-hash"].forEach((id) => { const e = el(id); if (e) e.addEventListener("input", validarIdent); });
carregarItens();
