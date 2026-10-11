#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Motor do app de prova digital [sidecar do Tauri].
Uso: python engine_entry.py analisar <laudo.pdf> --saida <dir> [--tipos a,b] [--llm]
Ingere o laudo em PDF, extrai identificação por tipo de prova e sugere respostas
por pistas [e, opcional, por modelo local Ollama], com a página de cada indício.
Não afirma a resposta: devolve sugestões; a confirmação é do jurista no frontend.
Imprime JSON no stdout. Progresso no stderr com o prefixo PROGRESSO:. Tudo local."""
import sys, os, json, re, argparse, urllib.request

BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))

def log(m):
    print("PROGRESSO: " + m, file=sys.stderr, flush=True)

def carregar_itens():
    with open(os.path.join(BASE, "dados", "itens.json"), encoding="utf-8") as f:
        return json.load(f)

def aplicavel(item, tipos):
    t = item.get("tipos")
    if not t:
        return True
    return any(x in tipos for x in t)

def extrair_pdf(caminho):
    paginas = []
    try:
        import pdfplumber
        with pdfplumber.open(caminho) as pdf:
            for n, p in enumerate(pdf.pages, 1):
                paginas.append((n, p.extract_text() or ""))
    except Exception as e:
        log("pdfplumber indisponível ou falhou: " + str(e))
    if not any(t.strip() for _, t in paginas):
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(caminho)
            paginas = [(n + 1, pg.get_text()) for n, pg in enumerate(doc)]
        except Exception as e:
            log("PyMuPDF indisponível ou falhou: " + str(e))
    return paginas

# Identificação por tipo de prova. Geral vale sempre; os demais só para o tipo.
IDENT_GERAL = {
    "processo": r"\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b",
    "hash": r"\b([A-Fa-f0-9]{64})\b",
}
IDENT_HW = {  # dispositivo e mídia
    "imei": r"\bIMEI[:\s]*([0-9]{14,16})\b",
    "serie": r"\b(?:n[º°o.]?\s*s[ée]rie|serial)[:\s]*([A-Z0-9\-]{6,})\b",
    "lacre": r"\blacre[:\s nº°o.]*([0-9]{3,})\b",
}
IDENT_REMOTO = {  # nuvem, e-mail e mensageria
    "conta": r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b",
    "ordem_judicial": r"(ordem|autoriza[çc][ãa]o)\s+judicial[^.\n]{0,60}",
}
PROVEDORES = ["google", "gmail", "meta", "whatsapp", "telegram", "microsoft", "outlook", "apple", "icloud", "facebook", "instagram"]

def extrair_identificacao(texto, tipos):
    out = {}
    def busca(rxs):
        for k, rx in rxs.items():
            m = re.search(rx, texto, re.I)
            if m:
                out[k] = (m.group(1) if m.groups() else m.group(0)).strip()
    busca(IDENT_GERAL)
    if tipos & {"movel", "midia"}:
        busca(IDENT_HW)
    if tipos & {"nuvem", "msg"}:
        busca(IDENT_REMOTO)
        tl = texto.lower()
        achados = [p for p in PROVEDORES if p in tl]
        if achados:
            out["provedor"] = ", ".join(sorted(set(achados)))
    return out

# Pistas por item. "tipos" limita a pista aos tipos indicados; sem "tipos", geral.
# A presença do termo gera SUGESTÃO, nunca resposta definitiva.
PISTAS = {
    "A2": {"t": ["imei", "número de série", "numero de serie"], "tipos": ["movel", "midia"]},
    "A3": {"t": ["modo avião", "faraday", "isolamento de radiofrequência"], "tipos": ["movel"]},
    "A4": {"t": ["auto de apreensão", "termo de apreensão"], "tipos": ["movel", "midia"]},
    "B1": {"t": ["lacre"], "tipos": ["movel", "midia"]},
    "B2": {"t": ["ficha de acompanhamento", "rompimento de lacre"], "tipos": ["movel", "midia"]},
    "B4": {"t": ["transferência de posse", "cadeia de custódia"]},
    "C1": {"t": ["imagem forense", "cópia bit a bit", "copia bit a bit", "espelhamento"], "tipos": ["movel", "midia"]},
    "C2": {"t": ["bloqueador de escrita", "write blocker", "write-blocker"], "tipos": ["movel", "midia"]},
    "C3": {"t": ["hash", "sha-256", "sha256"]},
    "C4": {"t": ["confronto de hash", "hash da cópia", "hash da copia"]},
    "C5": {"t": ["sha-256", "sha-512", "sha256"]},
    "C6": {"t": ["cellebrite", "ufed", "ferramenta forense"], "tipos": ["movel", "midia", "msg"]},
    "E1": {"t": ["central de custódia", "armazenamento"]},
    "F1": {"t": ["extração forense", "cellebrite", "ufed"], "tipos": ["msg"]},
    "F4": {"t": ["autorização judicial", "ordem judicial"], "tipos": ["nuvem"]},
    "F5": {"t": ["recorte temporal", "período", "delimitação"], "tipos": ["nuvem"]},
    "F7": {"t": ["número de série", "hash"], "tipos": ["midia"]},
}

def prefill(paginas, itens, tipos):
    sug = {}
    for b in itens["BLOCOS"]:
        for i in b["itens"]:
            if not aplicavel(i, tipos):
                continue
            p = PISTAS.get(i["id"])
            if not p:
                continue
            if p.get("tipos") and not (set(p["tipos"]) & tipos):
                continue
            achou = False
            for termo in p["t"]:
                for num, txt in paginas:
                    pos = txt.lower().find(termo.lower())
                    if pos >= 0:
                        sug[i["id"]] = {
                            "resposta": "sim",
                            "confianca": "indicio",
                            "trecho": txt[max(0, pos - 40):pos + 90].replace("\n", " ").strip(),
                            "pagina": num,
                        }
                        achou = True
                        break
                if achou:
                    break
    return sug

def ollama_disponivel():
    try:
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
        return True
    except Exception:
        return False

def ollama_sugere(item, texto, modelo="gemma3:4b"):
    prompt = (
        "Assistente de cadeia de custódia de prova digital. Com base SOMENTE no laudo, "
        "responda em JSON {\"resposta\":\"sim|nd|nao|na\",\"trecho\":\"...\"}. "
        "sim = etapa cumprida e documentada; nd = não documentada; nao = defeituosa; na = não aplicável. "
        "Nunca invente.\n\nPergunta: " + item["txt"] + "\n\nLaudo [parcial]:\n" + texto[:6000]
    )
    body = json.dumps({"model": modelo, "prompt": prompt, "stream": False, "format": "json"}).encode()
    req = urllib.request.Request("http://localhost:11434/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=120)
        return json.loads(json.loads(r.read().decode()).get("response", "{}"))
    except Exception as e:
        log("Ollama falhou no item " + item["id"] + ": " + str(e))
        return None

def analisar(caminho, saida, usar_llm, tipos):
    log("Lendo o laudo")
    paginas = extrair_pdf(caminho)
    texto = "\n".join(t for _, t in paginas)
    if len(texto.strip()) < 40:
        log("Pouco texto extraído. Laudo escaneado pode exigir OCR.")
    itens = carregar_itens()
    log("Extraindo identificação")
    ident = extrair_identificacao(texto, tipos)
    log("Buscando indícios por pistas")
    sug = prefill(paginas, itens, tipos)
    if usar_llm and ollama_disponivel():
        log("Refinando por modelo local")
        for b in itens["BLOCOS"]:
            for i in b["itens"]:
                if i["id"] not in sug and aplicavel(i, tipos):
                    s = ollama_sugere(i, texto)
                    if s and s.get("resposta") in ("sim", "nd", "nao", "na"):
                        sug[i["id"]] = {"resposta": s["resposta"], "confianca": "modelo", "trecho": s.get("trecho", ""), "pagina": None}
    elif usar_llm:
        log("Ollama não encontrado em localhost:11434; mantendo só as pistas")
    resultado = {
        "arquivo": os.path.basename(caminho),
        "tipos": sorted(tipos),
        "identificacao": ident,
        "sugestoes": sug,
        "paginas": len(paginas),
        "aviso": "As respostas são SUGESTÕES por indício, não decisão. Confirme item a item. Processamento local, nada enviado.",
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
    a.add_argument("--tipos", default="")
    args = ap.parse_args()
    if args.cmd == "analisar":
        tipos = set(x.strip() for x in args.tipos.split(",") if x.strip())
        analisar(args.pdf, args.saida, args.llm, tipos)
    else:
        ap.print_help()
        sys.exit(2)

if __name__ == "__main__":
    main()
