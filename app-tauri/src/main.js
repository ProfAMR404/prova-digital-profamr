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

function renderIdent() {
  const i = app.ident;
  const box = el("ident");
  const linhas = Object.keys(i).map((k) => `<span><b>${k}:</b> ${escapar(String(i[k]))}</span>`).join("");
  box.hidden = Object.keys(i).length === 0;
  box.innerHTML = linhas || "";
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
    renderIdent();
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
    identificacao: app.ident,
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
carregarItens();
