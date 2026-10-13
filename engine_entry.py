#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Motor do app de prova digital [sidecar do Tauri].
Uso: python engine_entry.py analisar <laudo.pdf> --saida <dir> [--tipos a,b] [--llm] [--ocr]
Ingere o laudo em PDF, extrai identificacao por tipo de prova e sugere respostas
por pistas [e, opcional, por modelo local Ollama], com a pagina de cada indicio.
Laudo escaneado sem camada de texto e lido por OCR [Tesseract embutido].
Nao afirma a resposta: devolve sugestoes; a confirmacao e do jurista no frontend.
Imprime JSON no stdout. Progresso no stderr com o prefixo PROGRESSO:. Tudo local."""
import sys, os, json, re, argparse, urllib.request, hashlib, datetime

BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))

def sha256_arquivo(caminho):
    h = hashlib.sha256()
    try:
        with open(caminho, "rb") as f:
            for bloco in iter(lambda: f.read(1 << 20), b""):
                h.update(bloco)
        return h.hexdigest()
    except Exception as e:
        log("Falha ao calcular o hash do laudo: " + str(e))
        return None

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

# ---- OCR [Tesseract embutido] --------------------------------------------
def achar_tesseract():
    # Prioriza o binario embutido no app; depois env, PATH e caminho padrao.
    cands = [
        os.environ.get("TESSERACT_CMD"),
        os.path.join(BASE, "tesseract", "tesseract.exe"),
        os.path.join(BASE, "tesseract", "tesseract"),
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "tesseract",
    ]
    for c in cands:
        if not c:
            continue
        if os.path.sep in c or c.endswith(".exe"):
            if os.path.exists(c):
                return c
        else:
            from shutil import which
            achado = which(c)
            if achado:
                return achado
    return None

def preparar_ocr():
    # Retorna o modulo pytesseract configurado, ou None se indisponivel.
    try:
        import pytesseract
    except Exception as e:
        log("pytesseract indisponivel: " + str(e))
        return None
    cmd = achar_tesseract()
    if not cmd:
        log("Tesseract nao encontrado; OCR desativado nesta execucao.")
        return None
    pytesseract.pytesseract.tesseract_cmd = cmd
    tessdata = os.path.join(os.path.dirname(cmd), "tessdata")
    if os.path.isdir(tessdata):
        os.environ["TESSDATA_PREFIX"] = tessdata
    return pytesseract

def ocr_pagina(pytess, page):
    # Rasteriza a pagina a ~300 DPI, pre-processa [cinza, contraste, nitidez] e
    # aplica OCR em portugues e ingles.
    import fitz
    from PIL import Image, ImageOps, ImageFilter
    import io
    pix = page.get_pixmap(matrix=fitz.Matrix(300 / 72, 300 / 72))
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    try:
        img = ImageOps.autocontrast(img.convert("L")).filter(ImageFilter.SHARPEN)
    except Exception:
        pass
    idiomas = "por+eng"
    try:
        return pytess.image_to_string(img, lang=idiomas)
    except Exception:
        return pytess.image_to_string(img)

def extrair_pdf(caminho, usar_ocr):
    paginas = []
    try:
        import pdfplumber
        with pdfplumber.open(caminho) as pdf:
            for n, p in enumerate(pdf.pages, 1):
                paginas.append((n, p.extract_text() or ""))
    except Exception as e:
        log("pdfplumber indisponivel ou falhou: " + str(e))
    if not any(t.strip() for _, t in paginas):
        try:
            import fitz
            doc = fitz.open(caminho)
            paginas = [(n + 1, pg.get_text()) for n, pg in enumerate(doc)]
        except Exception as e:
            log("PyMuPDF indisponivel ou falhou: " + str(e))

    paginas_ocr = []
    if usar_ocr:
        esparsas = [n for n, t in paginas if len((t or "").strip()) < 40]
        # Sem nenhuma pagina [extracao falhou de todo], tenta abrir pelo fitz.
        if not paginas:
            try:
                import fitz
                doc = fitz.open(caminho)
                paginas = [(i + 1, "") for i in range(doc.page_count)]
                esparsas = [p[0] for p in paginas]
            except Exception as e:
                log("Falha ao abrir o PDF para OCR: " + str(e))
                doc = None
        if esparsas:
            pytess = preparar_ocr()
            if pytess:
                try:
                    import fitz
                    doc = fitz.open(caminho)
                    log("OCR em " + str(len(esparsas)) + " pagina(s) escaneada(s)")
                    porpag = {n: t for n, t in paginas}
                    for n in esparsas:
                        try:
                            txt = ocr_pagina(pytess, doc[n - 1])
                        except Exception as e:
                            log("OCR falhou na pagina " + str(n) + ": " + str(e))
                            txt = ""
                        if txt.strip():
                            porpag[n] = txt
                            paginas_ocr.append(n)
                    paginas = [(n, porpag[n]) for n in sorted(porpag)]
                except Exception as e:
                    log("OCR indisponivel: " + str(e))
    return paginas, paginas_ocr

# Identificacao por tipo de prova. Geral vale sempre; os demais so para o tipo.
IDENT_GERAL = {
    "processo": r"\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b",
    "hash": r"\b([A-Fa-f0-9]{64})\b",
}
IDENT_HW = {  # dispositivo e midia
    "imei": r"\bIMEI[:\s]*([0-9]{14,16})\b",
    "serie": r"\b(?:n[\u00ba\u00b0o.]?\s*s[\u00e9e]rie|serial)[:\s]*([A-Z0-9\-]{6,})\b",
    "lacre": r"\blacre[:\s n\u00ba\u00b0o.]*([0-9]{3,})\b",
}
IDENT_REMOTO = {  # nuvem, e-mail e mensageria
    "conta": r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b",
    "ordem_judicial": r"(ordem|autoriza[\u00e7c][\u00e3a]o)\s+judicial[^.\n]{0,60}",
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
# A presenca do termo gera SUGESTAO, nunca resposta definitiva.
PISTAS = {
    "A2": {"t": ["imei", "numero de serie", "n\u00famero de s\u00e9rie"], "tipos": ["movel", "midia"]},
    "A3": {"t": ["modo aviao", "modo avi\u00e3o", "faraday", "isolamento de radiofrequencia"], "tipos": ["movel"]},
    "A4": {"t": ["auto de apreensao", "termo de apreensao", "auto de apreens\u00e3o"], "tipos": ["movel", "midia"]},
    "B1": {"t": ["lacre"], "tipos": ["movel", "midia"]},
    "B2": {"t": ["ficha de acompanhamento", "rompimento de lacre"], "tipos": ["movel", "midia"]},
    "B4": {"t": ["transferencia de posse", "cadeia de custodia", "cadeia de cust\u00f3dia"]},
    "C1": {"t": ["imagem forense", "copia bit a bit", "c\u00f3pia bit a bit", "espelhamento"], "tipos": ["movel", "midia"]},
    "C2": {"t": ["bloqueador de escrita", "write blocker", "write-blocker"], "tipos": ["movel", "midia"]},
    "C3": {"t": ["hash", "sha-256", "sha256"]},
    "C4": {"t": ["confronto de hash", "hash da copia", "hash da c\u00f3pia"]},
    "C5": {"t": ["sha-256", "sha-512", "sha256"]},
    "C6": {"t": ["cellebrite", "ufed", "ferramenta forense"], "tipos": ["movel", "midia", "msg"]},
    "E1": {"t": ["central de custodia", "central de cust\u00f3dia", "armazenamento"]},
    "F1": {"t": ["extracao forense", "extra\u00e7\u00e3o forense", "cellebrite", "ufed"], "tipos": ["msg"]},
    "F4": {"t": ["autorizacao judicial", "autoriza\u00e7\u00e3o judicial", "ordem judicial"], "tipos": ["nuvem"]},
    "F5": {"t": ["recorte temporal", "periodo", "per\u00edodo", "delimitacao"], "tipos": ["nuvem"]},
    "F7": {"t": ["numero de serie", "n\u00famero de s\u00e9rie", "hash"], "tipos": ["midia"]},
}

# Marcadores de negacao perto do termo. A presenca deles indica desconformidade.
NEGACOES = ["sem ", "nao ", "não ", "ausenc", "ausênc", "inexist", "nao ha", "não há",
            "nao consta", "não consta", "nao foi", "não foi", "rompid", "quebrad",
            "nao confere", "não confere", "divergent", "nao identificad", "não identificad",
            "impossibilit", "prejudicad", "nao localizad", "não localizad"]

def prefill(paginas, itens, tipos):
    # A mera presenca do termo NAO afirma conformidade. Sem negacao perto, a
    # sugestao e neutra [resposta null = menção a conferir]. Com negacao, sugere
    # "nao". A decisao fica com o usuario no frontend.
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
                    tl = txt.lower()
                    pos = tl.find(termo.lower())
                    if pos >= 0:
                        janela = tl[max(0, pos - 60):pos + 90]
                        negou = any(nz in janela for nz in NEGACOES)
                        sug[i["id"]] = {
                            "resposta": "nao" if negou else None,
                            "confianca": "indicio",
                            "trecho": txt[max(0, pos - 40):pos + 90].replace("\n", " ").strip(),
                            "pagina": num,
                        }
                        achou = True
                        break
                if achou:
                    break
    return sug

def tipos_por_sinais(texto, ident):
    # Sugere tipos de prova a partir dos indicios do laudo, para alertar
    # incoerencia com o tipo marcado pelo usuario.
    tl = texto.lower()
    s = set()
    if ident.get("imei") or ident.get("serie") or "imei" in tl or "cellebrite" in tl or "ufed" in tl:
        s |= {"movel", "midia"}
    if ident.get("conta") or ident.get("provedor") or "nuvem" in tl or "e-mail" in tl or "webmail" in tl:
        s |= {"nuvem", "msg"}
    if "whatsapp" in tl or "telegram" in tl or "mensageria" in tl:
        s |= {"msg"}
    return sorted(s)

# ---- Ollama refinado ------------------------------------------------------
def ollama_disponivel():
    try:
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
        return True
    except Exception:
        return False

PALAVRAS_VAZIAS = {"de", "da", "do", "das", "dos", "a", "o", "as", "os", "e", "em", "no", "na", "nos", "nas", "com", "por", "para", "que", "se", "ao", "um", "uma", "ha", "foi", "esta", "sua", "seu"}

def termos_item(item):
    pistas = PISTAS.get(item["id"], {}).get("t", [])
    palavras = re.findall(r"[a-z\u00e0-\u00ff0-9]{4,}", (item.get("txt") or "").lower())
    extra = [p for p in palavras if p not in PALAVRAS_VAZIAS]
    return pistas + extra

def contexto_item(item, paginas, limite=3500):
    # Monta um contexto curto e ancorado: trechos das paginas que mencionam os
    # termos do item, com marcador de pagina. Sem acerto, usa o inicio do laudo.
    termos = termos_item(item)
    partes, usado = [], 0
    for num, txt in paginas:
        tl = txt.lower()
        if any(t in tl for t in termos):
            pos = min((tl.find(t) for t in termos if t in tl), default=0)
            trecho = txt[max(0, pos - 200):pos + 600].replace("\n", " ").strip()
            marca = "[pag. " + str(num) + "] " + trecho
            partes.append(marca)
            usado += len(marca)
            if usado >= limite:
                break
    if partes:
        return "\n".join(partes)[:limite], True
    full = "\n".join(t for _, t in paginas)
    return full[:limite], False

def ollama_sugere(item, paginas, modelo="gemma3:4b"):
    ctx, ancorado = contexto_item(item, paginas)
    sistema = (
        "Voce apoia a afericao da cadeia de custodia de prova digital. Responda SO com base "
        "no trecho do laudo fornecido. Devolva JSON "
        "{\"resposta\":\"sim|nd|nao|na\",\"trecho\":\"citacao curta do laudo\",\"pagina\":numero_ou_0}. "
        "sim = etapa cumprida e documentada; nd = nao documentada no trecho; nao = feita de forma "
        "defeituosa; na = nao se aplica. Na duvida use nd. Nunca invente dado ausente."
    )
    prompt = (
        sistema + "\n\nItem: " + item.get("txt", "") +
        ("\nReferencia tecnica: " + item["fund"] if item.get("fund") else "") +
        "\n\nTrecho do laudo:\n" + ctx
    )
    body = json.dumps({
        "model": modelo, "prompt": prompt, "stream": False, "format": "json",
        "options": {"temperature": 0, "num_ctx": 8192},
    }).encode()
    req = urllib.request.Request("http://localhost:11434/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=180)
        dado = json.loads(json.loads(r.read().decode()).get("response", "{}"))
    except Exception as e:
        log("Ollama falhou no item " + item["id"] + ": " + str(e))
        return None
    if dado.get("resposta") not in ("sim", "nd", "nao", "na"):
        return None
    pag = dado.get("pagina")
    try:
        pag = int(pag) or None
    except Exception:
        pag = None
    return {"resposta": dado["resposta"], "confianca": "modelo", "trecho": (dado.get("trecho") or "")[:200], "pagina": pag}

def analisar(caminho, saida, usar_llm, tipos, usar_ocr):
    log("Lendo o laudo")
    paginas, paginas_ocr = extrair_pdf(caminho, usar_ocr)
    texto = "\n".join(t for _, t in paginas)
    if paginas_ocr:
        log("Texto recuperado por OCR em " + str(len(paginas_ocr)) + " pagina(s)")
    if len(texto.strip()) < 40:
        log("Pouco texto extraido, mesmo com OCR. Confira o laudo manualmente.")
    itens = carregar_itens()
    log("Extraindo identificacao")
    ident = extrair_identificacao(texto, tipos)
    log("Buscando indicios por pistas")
    sug = prefill(paginas, itens, tipos)
    if usar_llm and ollama_disponivel():
        log("Refinando por modelo local")
        for b in itens["BLOCOS"]:
            for i in b["itens"]:
                if not aplicavel(i, tipos):
                    continue
                # Refina itens sem sugestao e tambem as mencoes neutras [resposta null].
                if i["id"] not in sug or sug[i["id"]].get("resposta") is None:
                    s = ollama_sugere(i, paginas)
                    if s:
                        sug[i["id"]] = s
    elif usar_llm:
        log("Ollama nao encontrado em localhost:11434; mantendo so as pistas")
    resultado = {
        "arquivo": os.path.basename(caminho),
        "tipos": sorted(tipos),
        "identificacao": ident,
        "sugestoes": sug,
        "paginas": len(paginas),
        "paginas_ocr": paginas_ocr,
        "tipos_sugeridos": tipos_por_sinais(texto, ident),
        "laudo_sha256": sha256_arquivo(caminho),
        "analisado_em": datetime.datetime.now().isoformat(timespec="seconds"),
        "aviso": "As respostas sao SUGESTOES por indicio, nao decisao. Confirme item a item. Valores de OCR [hash, IMEI] exigem conferencia no laudo. Processamento local, nada enviado.",
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
    a.add_argument("--ocr", action="store_true")
    a.add_argument("--tipos", default="")
    args = ap.parse_args()
    if args.cmd == "analisar":
        tipos = set(x.strip() for x in args.tipos.split(",") if x.strip())
        analisar(args.pdf, args.saida, args.llm, tipos, args.ocr)
    else:
        ap.print_help()
        sys.exit(2)

if __name__ == "__main__":
    main()
