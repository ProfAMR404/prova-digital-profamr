#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Motor do app de prova digital [sidecar do Tauri].
Uso: python engine_entry.py analisar <laudo.pdf> --saida <dir> [--llm]
Ingere o laudo em PDF, extrai identificação, pré-responde os 39 itens por pistas
determinísticas e, com --llm, por modelo local Ollama, classifica pela escala do
gabinete [inexistência, arranhão e quebra] e redige minutas. Imprime JSON no stdout.
Progresso vai ao stderr com o prefixo PROGRESSO:. Tudo local, nada é enviado."""
import sys, os, json, re, argparse, urllib.request

BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))

def log(m):
    print("PROGRESSO: " + m, file=sys.stderr, flush=True)

def carregar_itens():
    caminho = os.path.join(BASE, "dados", "itens.json")
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)

def extrair_pdf(caminho):
    texto = ""
    try:
        import pdfplumber
        with pdfplumber.open(caminho) as pdf:
            for p in pdf.pages:
                texto += (p.extract_text() or "") + "\n"
    except Exception as e:
        log("pdfplumber indisponível ou falhou: " + str(e))
    if len(texto.strip()) < 40:
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(caminho)
            texto = "\n".join(pg.get_text() for pg in doc)
        except Exception as e:
            log("PyMuPDF indisponível ou falhou: " + str(e))
    return texto

IDENT_RE = {
    "processo": r"\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b",
    "imei": r"\bIMEI[:\s]*([0-9]{14,16})\b",
    "serie": r"\b(?:n[º°o.]?\s*s[ée]rie|serial)[:\s]*([A-Z0-9\-]{6,})\b",
    "hash": r"\b([A-Fa-f0-9]{64})\b",
    "lacre": r"\blacre[:\s nº°o.]*([0-9]{3,})\b",
}

def extrair_identificacao(t):
    out = {}
    for k, rx in IDENT_RE.items():
        m = re.search(rx, t, re.I)
        if m:
            out[k] = m.group(1) if m.groups() else m.group(0)
    return out

# Pistas determinísticas: termo presente no laudo sugere a etapa cumprida [sim].
# A pré-resposta é sugestão; o jurista confirma na tela.
PISTAS = {
    "A2": ["imei", "número de série", "numero de serie"],
    "A4": ["auto de apreensão", "data da apreensão", "hora da apreensão"],
    "A3": ["modo avião", "faraday", "isolamento de radiofrequência"],
    "B1": ["lacre"],
    "B2": ["ficha de acompanhamento", "rompimento de lacre"],
    "B4": ["transferência de posse", "cadeia de custódia"],
    "C1": ["imagem forense", "cópia bit a bit", "copia bit a bit", "espelhamento"],
    "C2": ["bloqueador de escrita", "write blocker", "write-blocker"],
    "C3": ["hash", "sha-256", "sha256"],
    "C4": ["confronto de hash", "hash da cópia", "hash da copia", "conferência de hash"],
    "C5": ["sha-256", "sha-512", "sha256"],
    "C6": ["cellebrite", "ufed", "ferramenta forense", "versão"],
    "E1": ["central de custódia", "armazenamento"],
    "F1": ["extração forense", "cellebrite", "ufed"],
}

def prefill(texto, itens):
    tl = texto.lower()
    estado = {}
    trechos = {}
    for b in itens["BLOCOS"]:
        for i in b["itens"]:
            estado[i["id"]] = None
            pistas = PISTAS.get(i["id"])
            if pistas:
                for p in pistas:
                    pos = tl.find(p.lower())
                    if pos >= 0:
                        estado[i["id"]] = "sim"
                        trechos[i["id"]] = texto[max(0, pos - 40):pos + 80].replace("\n", " ").strip()
                        break
    return estado, trechos

def ollama_disponivel():
    try:
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
        return True
    except Exception:
        return False

def ollama_sugere(item, texto, modelo="gemma3:4b"):
    prompt = (
        "Você é assistente de análise de cadeia de custódia de prova digital. "
        "Com base SOMENTE no trecho do laudo, responda em JSON {\"resposta\":\"sim|nd|nao|na\","
        "\"justificativa\":\"...\",\"trecho\":\"...\"}. "
        "sim = etapa cumprida e documentada; nd = não documentada; nao = cumprida de modo defeituoso; "
        "na = não aplicável. Nunca invente.\n\nPergunta: " + item["txt"] +
        "\n\nLaudo [parcial]:\n" + texto[:6000]
    )
    body = json.dumps({"model": modelo, "prompt": prompt, "stream": False, "format": "json"}).encode()
    req = urllib.request.Request("http://localhost:11434/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=120)
        data = json.loads(r.read().decode())
        return json.loads(data.get("response", "{}"))
    except Exception as e:
        log("Ollama falhou no item " + item["id"] + ": " + str(e))
        return None

def classificar(estado, itens):
    portas = itens["portas"]
    quebra = itens["quebra"]
    falhou = lambda ids: any(estado.get(i) in ("nd", "nao") for i in ids)
    p1 = falhou(portas["porta1"])
    p2 = falhou(portas["porta2"])
    q = falhou(quebra)
    pend = any(v is None for v in estado.values())
    if pend:
        return {"estado": "provisorio", "titulo": "Diagnóstico provisório",
                "corpo": "Há itens sem resposta. Confirme ou ajuste cada item para o veredito conclusivo."}
    if p1 or p2:
        return {"estado": "inexistencia", "titulo": "Inexistência da cadeia de custódia: inadmissibilidade",
                "corpo": "Falta ao menos uma das duas portas [cadeia documentada; dado bruto com hash de origem]. Inadmissibilidade integral. Escala do gabinete."}
    if q:
        return {"estado": "quebra", "titulo": "Quebra da cadeia de custódia: até a imprestabilidade",
                "corpo": "Com as duas portas presentes, há desconformidade que a verificação independente não supera. Escala do gabinete."}
    if any(v in ("nd", "nao") for v in estado.values()):
        return {"estado": "arranhao", "titulo": "Arranhão da cadeia de custódia: desconto no peso",
                "corpo": "Com as duas portas presentes, as desconformidades são superadas pela verificação independente, preservada a admissibilidade. Escala do gabinete."}
    return {"estado": "plena", "titulo": "Conformidade plena: elemento admissível",
            "corpo": "As duas portas presentes e nenhuma desconformidade."}

def minutas(estado, itens):
    out = []
    for b in itens["BLOCOS"]:
        for i in b["itens"]:
            if estado.get(i["id"]) in ("nd", "nao") and i.get("minuta"):
                out.append({"id": i["id"], "peso": i.get("peso"), "minuta": i["minuta"]})
    return out

def analisar(caminho, saida, usar_llm):
    log("Lendo o laudo")
    texto = extrair_pdf(caminho)
    if len(texto.strip()) < 40:
        log("Pouco texto extraído. Laudo escaneado pode exigir OCR.")
    itens = carregar_itens()
    log("Extraindo identificação")
    ident = extrair_identificacao(texto)
    log("Pré-respondendo por pistas")
    estado, trechos = prefill(texto, itens)
    if usar_llm and ollama_disponivel():
        log("Refinando por modelo local")
        for b in itens["BLOCOS"]:
            for i in b["itens"]:
                if estado[i["id"]] is None:
                    sug = ollama_sugere(i, texto)
                    if sug and sug.get("resposta") in ("sim", "nd", "nao", "na"):
                        estado[i["id"]] = sug["resposta"]
                        if sug.get("trecho"):
                            trechos[i["id"]] = sug["trecho"]
    elif usar_llm:
        log("Ollama não encontrado em localhost:11434; mantendo só as pistas")
    log("Classificando")
    veredito = classificar(estado, itens)
    resultado = {
        "arquivo": os.path.basename(caminho),
        "identificacao": ident,
        "respostas": estado,
        "trechos": trechos,
        "veredito": veredito,
        "minutas": minutas(estado, itens),
        "aviso": "Pré-resposta por heurística; confirme item a item. Processamento local, nada enviado.",
    }
    try:
        os.makedirs(saida, exist_ok=True)
        with open(os.path.join(saida, "analise.json"), "w", encoding="utf-8") as f:
            json.dump(resultado, f, ensure_ascii=False, indent=1)
    except Exception as e:
        log("Falha ao gravar em " + saida + ": " + str(e))
    print(json.dumps(resultado, ensure_ascii=False))

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    a = sub.add_parser("analisar")
    a.add_argument("pdf")
    a.add_argument("--saida", default=".")
    a.add_argument("--llm", action="store_true")
    args = ap.parse_args()
    if args.cmd == "analisar":
        analisar(args.pdf, args.saida, args.llm)
    else:
        ap.print_help()
        sys.exit(2)

if __name__ == "__main__":
    main()
