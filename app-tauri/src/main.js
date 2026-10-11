// Frontend da Prova Digital ProfAMR [Tauri v2, API global window.__TAURI__].
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;
const fs = window.__TAURI__.fs;

const el = (id) => document.getElementById(id);
const ROTULOS = { sim: "Conforme", nd: "Não documentado", nao: "Não conforme", na: "Não aplicável" };
const app = { laudo: null, nome: null, dados: null, estado: {}, ident: {}, trechos: {} };

async function carregarItens() {
  const r = await fetch("itens.json");
  app.dados = await r.json();
  app.dados.BLOCOS.forEach((b) => b.itens.forEach((i) => (app.estado[i.id] = null)));
  renderBlocos();
}

function renderBlocos() {
  const c = el("blocos");
  c.innerHTML = app.dados.BLOCOS.map((b) => {
    const itens = b.itens
      .map((i) => {
        const trecho = app.trechos[i.id] ? `<div class="trecho">Trecho: ${escapar(app.trechos[i.id])}</div>` : "";
        const opts = ["", "sim", "nd", "nao", "na"]
          .map((k) => `<option value="${k}" ${app.estado[i.id] === k ? "selected" : ""}>${k ? ROTULOS[k] : "—"}</option>`)
          .join("");
        return `<div class="item">
          <div class="txt"><span class="cod">${i.id}</span>${escapar(i.txt)}
            <div class="fund">${escapar(i.fund || "")}</div>${trecho}</div>
          <select data-id="${i.id}" class="resp">${opts}</select>
        </div>`;
      })
      .join("");
    return `<section class="bloco"><h3>${escapar(b.titulo)}</h3>${itens}</section>`;
  }).join("");
  c.querySelectorAll("select.resp").forEach((s) =>
    s.addEventListener("change", (e) => {
      const v = e.target.value;
      app.estado[e.target.dataset.id] = v || null;
      atualizarVeredito();
    })
  );
}

function classificar() {
  const d = app.dados;
  const falhou = (ids) => ids.some((i) => ["nd", "nao"].includes(app.estado[i]));
  const pend = Object.values(app.estado).some((v) => v === null);
  if (pend) return { estado: "neutro", titulo: "Diagnóstico provisório", corpo: "Confirme ou ajuste cada item para o veredito conclusivo." };
  if (falhou(d.portas.porta1) || falhou(d.portas.porta2))
    return { estado: "vermelho", titulo: "Inexistência da cadeia de custódia: inadmissibilidade", corpo: "Falta ao menos uma das duas portas [cadeia documentada; dado bruto com hash de origem]. Inadmissibilidade integral." };
  if (falhou(d.quebra))
    return { estado: "laranja", titulo: "Quebra da cadeia de custódia: até a imprestabilidade", corpo: "Com as duas portas presentes, desconformidade que a verificação independente não supera." };
  if (Object.values(app.estado).some((v) => ["nd", "nao"].includes(v)))
    return { estado: "amarelo", titulo: "Arranhão da cadeia de custódia: desconto no peso", corpo: "Com as duas portas presentes, desconformidades superadas pela verificação independente, preservada a admissibilidade." };
  return { estado: "verde", titulo: "Conformidade plena: elemento admissível", corpo: "As duas portas presentes e nenhuma desconformidade." };
}

function atualizarVeredito() {
  const v = classificar();
  const box = el("veredito");
  box.hidden = false;
  box.className = "veredito " + v.estado;
  box.innerHTML = `<b>${v.titulo}</b><span>${v.corpo}</span><em>Escala do gabinete, não tese de tribunal.</em>`;
}

function renderIdent() {
  const i = app.ident;
  const linhas = Object.keys(i).map((k) => `<span><b>${k}:</b> ${escapar(String(i[k]))}</span>`).join("");
  const box = el("ident");
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
  el("btn-analisar").disabled = true;
  el("progresso").textContent = "Iniciando…";
  const parar = await listen("progresso", (ev) => (el("progresso").textContent = ev.payload));
  try {
    const res = await invoke("analisar", { caminho: app.laudo, llm: el("llm").checked });
    app.ident = res.identificacao || {};
    app.trechos = res.trechos || {};
    Object.keys(app.estado).forEach((k) => (app.estado[k] = (res.respostas && res.respostas[k]) || null));
    renderIdent();
    renderBlocos();
    atualizarVeredito();
    el("btn-minutas").disabled = false;
    el("btn-exportar").disabled = false;
    el("progresso").textContent = "Pré-resposta pronta. Confira item a item.";
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
      if (["nd", "nao"].includes(app.estado[i.id]) && i.minuta) {
        n++;
        t += `[${i.id}] ${i.minuta}\n\n`;
      }
    })
  );
  if (!n) t += "Nenhum item desconforme.\n";
  el("saidaBox").hidden = false;
  el("saida").value = t;
  el("saida").scrollIntoView({ behavior: "smooth" });
}

async function exportar() {
  const dados = { arquivo: app.nome, identificacao: app.ident, respostas: app.estado, veredito: classificar() };
  const destino = await dialog.save({ defaultPath: "analise-prova-digital.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (destino) {
    await fs.writeTextFile(destino, JSON.stringify(dados, null, 1));
    el("progresso").textContent = "Exportado: " + destino;
  }
}

function escapar(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

el("btn-arquivo").addEventListener("click", escolherArquivo);
el("btn-analisar").addEventListener("click", analisar);
el("btn-minutas").addEventListener("click", gerarMinutas);
el("btn-exportar").addEventListener("click", exportar);
carregarItens();
