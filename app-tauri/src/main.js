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
        const sug = s
          ? `<div class="sugestao">Sugestão: <b>${ROTULOS[s.resposta] || "—"}</b> ${s.pagina ? "[pág. " + s.pagina + "]" : "[" + (s.confianca || "indício") + "]"}
               <button type="button" class="aplicar" data-id="${i.id}" data-resp="${s.resposta}">Aplicar</button>
               ${s.trecho ? `<div class="strecho">${escapar(s.trecho)}</div>` : ""}</div>`
          : "";
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
  const falhou = (ids) => ids.some((i) => vale(i) && ["nd", "nao"].includes(app.estado[i]));
  const aplicaveis = [];
  d.BLOCOS.forEach((b) => b.itens.forEach((i) => { if (aplicavel(i)) aplicaveis.push(i.id); }));
  if (app.tipos.size === 0)
    return { estado: "neutro", titulo: "Selecione o tipo de prova", corpo: "Na aba Caso, marque ao menos um tipo de prova em exame." };
  const pend = aplicaveis.some((id) => app.estado[id] === null);
  if (pend)
    return { estado: "neutro", titulo: "Diagnóstico provisório", corpo: "Confirme ou ajuste cada item aplicável para o veredito conclusivo." };
  if (falhou(d.portas.porta1) || falhou(d.portas.porta2))
    return { estado: "vermelho", titulo: "Inexistência da cadeia de custódia: inadmissibilidade", corpo: "Falta ao menos uma das duas portas [cadeia documentada; dado bruto com hash de origem]. Inadmissibilidade integral." };
  if (falhou(d.quebra))
    return { estado: "laranja", titulo: "Quebra da cadeia de custódia: até a imprestabilidade", corpo: "Com as duas portas presentes, desconformidade que a verificação independente não supera." };
  if (aplicaveis.some((id) => ["nd", "nao"].includes(app.estado[id])))
    return { estado: "amarelo", titulo: "Arranhão da cadeia de custódia: desconto no peso", corpo: "Com as duas portas presentes, desconformidades superadas pela verificação independente, preservada a admissibilidade." };
  return { estado: "verde", titulo: "Conformidade plena: elemento admissível", corpo: "As duas portas presentes e nenhuma desconformidade entre os itens aplicáveis." };
}

function atualizarVeredito() {
  const v = classificar();
  const box = el("veredito");
  box.hidden = false;
  box.className = "veredito " + v.estado;
  box.innerHTML = `<b>${v.titulo}</b><span>${v.corpo}</span><em>Escala do gabinete, não tese de tribunal.</em>`;
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
  marca(el("v-processo"), p, p === true ? "[CNJ ok]" : p === false ? "[conferir CNJ]" : "");
  const im = validaIMEI(el("i-imei").value);
  marca(el("v-imei"), im, im === true ? "[IMEI ok]" : im === false ? "[IMEI inválido]" : "");
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
  renderBlocos();
  atualizarVeredito();
  renderLaudos();
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
  el("btn-minutas").disabled = true;
  el("btn-exportar").disabled = true;
  aplicarAtivo();
}

function trocarLaudo(i) {
  capturarAtivo();
  app.ativo = i;
  aplicarAtivo();
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
  el("btn-minutas").disabled = true;
  el("btn-exportar").disabled = true;
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
    laudos: app.laudos.map((L) => ({ id: L.id, nome: L.nome, caminho: L.caminho, data: L.data, estado: L.estado, obs: L.obs, sugestoes: L.sugestoes, ident: L.ident })),
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
    estado: Object.assign({}, z.estado, L.estado || {}), obs: Object.assign({}, z.obs, L.obs || {}),
    sugestoes: L.sugestoes || {}, ident: L.ident || {},
  }));
  app.ativo = typeof v.ativo === "number" && v.ativo >= 0 && v.ativo < app.laudos.length ? v.ativo : 0;
  const temAnalise = app.laudos.some((L) => L.nome || Object.keys(L.sugestoes).length);
  el("btn-minutas").disabled = !temAnalise;
  el("btn-exportar").disabled = !temAnalise;
  el("caso-status").textContent = "Caso carregado [" + fmtData(v.atualizado) + "].";
  aplicarAtivo();
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
    const res = await invoke("analisar", { caminho: app.laudo, llm: el("llm").checked, tipos: [...app.tipos] });
    app.sugestoes = res.sugestoes || {};
    const ident = res.identificacao || {};
    if (ident.processo && el("k-autos") && !el("k-autos").value) el("k-autos").value = ident.processo;
    preencherIdent(ident);
    const L = app.laudos[app.ativo];
    if (L) { L.sugestoes = app.sugestoes; L.data = new Date().toISOString(); L.ident = lerIdent(); }
    renderBlocos();
    atualizarVeredito();
    renderLaudos();
    el("btn-minutas").disabled = false;
    el("btn-exportar").disabled = false;
    el("progresso").textContent = "Sugestões por indício prontas. Confirme item a item; o padrão é pendente.";
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
  el("saidaBox").hidden = false;
  el("saida").value = t;
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
