// Frontend da Prova Digital ProfAMR [Tauri v2, API global window.__TAURI__].
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;
const fs = window.__TAURI__.fs;

const el = (id) => document.getElementById(id);
const ROTULOS = { sim: "Conforme", nd: "Não documentado", nao: "Não conforme", na: "Não aplicável" };
const CAMPOS = ["autos", "classe", "vara", "arguido", "imp", "etapa", "perito", "data", "hac", "hdef"];
const app = { laudo: null, nome: null, dados: null, estado: {}, obs: {}, sugestoes: {}, ident: {}, tipos: new Set() };

async function carregarItens() {
  const r = await fetch("itens.json");
  app.dados = await r.json();
  app.dados.BLOCOS.forEach((b) => b.itens.forEach((i) => { app.estado[i.id] = null; app.obs[i.id] = ""; }));
  montarTipos();
  renderBlocos();
}

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

function lerCaso() {
  const caso = {};
  CAMPOS.forEach((k) => (caso[k] = (el("k-" + k) && el("k-" + k).value) || ""));
  return caso;
}

const IDENT_MAP = { processo: "i-processo", perito: "i-perito", imei: "i-imei", serie: "i-serie", lacre: "i-lacre", hash: "i-hash", conta: "i-conta", provedor: "i-provedor", ordem_judicial: "i-ordem" };

function preencherIdent(ident) {
  el("ident-box").hidden = false;
  Object.keys(IDENT_MAP).forEach((k) => {
    const inp = el(IDENT_MAP[k]);
    if (inp && ident[k] && !inp.value) inp.value = ident[k];
  });
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

async function escolherArquivo() {
  const escolha = await dialog.open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (escolha) {
    app.laudo = escolha;
    app.nome = escolha.replace(/^.*[\\/]/, "");
    el("arquivo").textContent = app.nome;
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
    app.ident = res.identificacao || {};
    app.sugestoes = res.sugestoes || {};
    if (app.ident.processo && el("k-autos") && !el("k-autos").value) el("k-autos").value = app.ident.processo;
    preencherIdent(app.ident);
    renderBlocos();
    atualizarVeredito();
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

function gerarMinutas() {
  let t = "MINUTAS DE FUNDAMENTAÇÃO · ITENS DESCONFORMES\n\n";
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
  const dados = {
    caso: lerCaso(),
    tipos: [...app.tipos],
    laudo: app.nome,
    identificacao: lerIdent(),
    respostas: app.estado,
    observacoes: app.obs,
    sugestoes: app.sugestoes,
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
el("t-caso").addEventListener("click", () => mostrarAba("caso"));
el("t-analise").addEventListener("click", () => mostrarAba("analise"));
el("t-saida").addEventListener("click", () => mostrarAba("saida"));
el("t-instrucoes").addEventListener("click", () => mostrarAba("instrucoes"));
["i-processo", "i-imei", "i-hash"].forEach((id) => { const e = el(id); if (e) e.addEventListener("input", validarIdent); });
carregarItens();
