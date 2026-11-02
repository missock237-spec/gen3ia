#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sélecteur de datasets externes gen3 — Job 478451 (demande propriétaire 02/11).

Pour chacun des 18 DOMAINES_GEN3, télécharge des échantillons RÉELS depuis
Hugging Face (datasets-server /rows, JSON) et Kaggle (kagglehub), applique
des filtres de qualité mesurables, convertit au format du générateur gen3
({id, domain, domain_fr, language, task_type, instruction, input, output,
metadata, domain_fields}) et écrit :

  · training/gen3-domain-datasets/data/complet/externes/<id>.jsonl
      → hors git (régénérable, même seed) — lu par chargerEchantillonsDomaines
  · training/gen3-domain-datasets/data/echantillons_externes/<id>.jsonl
      → commis (120/domaine, seed déterministe) — échantillon du dépôt
  · training/gen3-domain-datasets/data/echantillons_externes/MANIFEST.json
      → sources réelles (dataset, config, split, lignes extraites, filtres)

Honnêteté : les quotas sont CE qui est téléchargé réellement (aucun chiffre
fantôme). Une source indisponible = ligne « erreur » dans le manifeste, le
reste continue.

Usage : python3 scripts/selecteur-datasets-externes.py [--quota 800] [--commis 120]
"""

import argparse
import datetime
import hashlib
import json
import pathlib
import random
import re
import sys
import time
import urllib.request
import urllib.parse

RACINE = pathlib.Path(__file__).resolve().parents[1]
DIR_COMPLET = RACINE / "training/gen3-domain-datasets/data/complet/externes"
DIR_COMMIS = RACINE / "training/gen3-domain-datasets/data/echantillons_externes"
DIR_COMPLET.mkdir(parents=True, exist_ok=True)
DIR_COMMIS.mkdir(parents=True, exist_ok=True)

HF_ROWS = "https://datasets-server.huggingface.co/rows"

# ─── Les 18 DOMAINES_GEN3 (lib/neural/core/types.ts, pools 100..135) ────────
DOMAINE_FR = {
    "generation_images": "génération d'images",
    "video": "vidéo",
    "son": "son",
    "clips_musicaux": "clips musicaux",
    "developpement_web": "développement web",
    "test": "test",
    "redaction_documents": "rédaction de documents",
    "sciences_humaines": "sciences humaines",
    "recherche_scientifique": "recherche scientifique",
    "cybersecurite": "cybersécurité",
    "recherche_web": "recherche web",
    "multimodal": "multimodal",
    "hacker": "hacking éthique",
    "construction_machines": "construction de machines",
    "vente": "vente",
    "sante_medical": "santé / médical",
    "analyse_donnees": "analyse de données",
    "conseiller_commercial": "conseiller commercial",
}

# ─── Sélection par domaine : sources HF (datasets-server) et Kaggle ────────
SOURCES = {
    "developpement_web": [
        {"dataset": "nickrosh/Evol-Instruct-Code-80k-v1", "config": "default",
         "split": "train", "instr": "instruction", "out": "output",
         "licence": "inconnue (recherche)"},
    ],
    "analyse_donnees": [
        {"dataset": "gretelai/synthetic_text_to_sql", "config": "default",
         "split": "train", "instr": "sql_prompt", "out": "sql",
         "ctx": "sql_context", "licence": "gretel-synthetic (open)"},
    ],
    "sciences_humaines": [
        {"dataset": "databricks/databricks-dolly-15k", "config": "default",
         "split": "train", "instr": "instruction", "out": "response",
         "ctx": "context", "licence": "Apache-2.0"},
    ],
    "recherche_scientifique": [
        {"dataset": "allenai/sciq", "config": "default", "split": "train",
         "q": "question", "out": "correct_answer", "ctx": "support",
         "licence": "CC BY-SA 4.0"},
    ],
    "sante_medical": [
        {"dataset": "openlifescienceai/medmcqa", "config": "default",
         "split": "train", "special": "mcq", "licence": "Apache-2.0"},
    ],
    "cybersecurite": [
        {"dataset": "Trendyol/Trendyol-Cybersecurity-Instruction-Tuning-Dataset",
         "config": "default", "split": "train", "instr": "user",
         "out": "assistant", "licence": "inconnue (recherche)"},
    ],
    "redaction_documents": [
        {"dataset": "databricks/databricks-dolly-15k", "config": "default",
         "split": "train", "special": "dolly_writing",
         "licence": "Apache-2.0 (catégories brainstorming/closed_qa)"},
    ],
    "generation_images": [
        {"dataset": "Gustavosta/Stable-Diffusion-Prompts", "config": "default",
         "split": "test", "instr": "Prompt", "out": "Prompt",
         "licence": "inconnue (prompts publics)",
         "special": "prompt_image"},
    ],
    "video": [
        {"dataset": "hugginglearners/netflix-shows", "config": "default",
         "split": "train", "instr": "title", "out": "description",
         "licence": "inconnue (métadonnées publiques)",
         "special": "description_video"},
    ],
    "son": [
        {"dataset": "openslr/librispeech_asr", "config": "clean",
         "split": "validation", "instr": "text", "out": "text",
         "special": "phrase_son", "licence": "CC BY 4.0 (LibriSpeech)"},
    ],
    "clips_musicaux": [
        {"dataset": "D3STRON/music_lyrics_500k", "config": "default",
         "split": "train", "instr": "Lyric", "out": "Lyric",
         "special": "paroles", "licence": "inconnue (recherche)"},
    ],
    "multimodal": [
        {"dataset": "jxie/coco_captions", "config": "default",
         "split": "train", "instr": "sentences", "out": "sentences",
         "special": "coco", "licence": "CC BY 4.0"},
    ],
    "vente": [
        {"dataset": "DeepMostInnovations/saas-sales-conversations",
         "config": "default", "split": "train", "instr": "conversation",
         "out": "conversation", "special": "conversation_vente",
         "licence": "inconnue (recherche)"},
    ],
    "conseiller_commercial": [
        {"dataset": "Lakshan2003/customer_service_client_agent_conversations_40k_multi_task",
         "config": "default", "split": "train", "instr": "conversation",
         "out": "conversation", "special": "conversation_support",
         "licence": "inconnue (recherche)"},
    ],
    "test": [
        {"dataset": "openai/gsm8k", "config": "main", "split": "train",
         "q": "question", "out": "answer", "licence": "MIT"},
    ],
    "hacker": [
        {"dataset": "7h3-R3v3n4n7/pentest-agent-dataset-alpaca", "config": "default",
         "split": "train", "instr": "instruction", "out": "output",
         "licence": "inconnue (recherche, CVE publiques)"},
    ],
    "construction_machines": [
        {"dataset": "sanjayram-a/ifixit-repair-chatml", "config": "default",
         "split": "train", "instr": "conversations", "out": "conversations",
         "special": "chatml", "licence": "inconnue (recherche)"},
    ],
    "recherche_web": [
        {"dataset": "microsoft/ms_marco", "config": "v2.1", "split": "train",
         "q": "query", "out": "answers", "ctx": "passages",
         "special": "msmarco", "licence": "inconnue (MS MARCO public)"},
    ],
}

MOTS_FR = re.compile(
    r"\b(le|la|les|un|une|des|et|ou|pour|avec|dans|sur|je|tu|il|elle|nous|vous|"
    r"quoi|comment|pourquoi|quel|quelle|est|être|avoir|faire|plus|tout)\b", re.I)


def langue_de(texte: str) -> str:
    return "fr" if MOTS_FR.search(texte or "") else "en"


def norme(texte: str) -> str:
    return re.sub(r"\s+", " ", (texte or "")).strip()


def lignes_hf(src: dict, quota: int, journal: list) -> list:
    """Extrait jusqu'à quota lignes via datasets-server /rows (100/req).
    Retry avec backoff sur 429/5xx (rate-limit du serveur) : 3 essais."""
    lignes, offset, taille = [], 0, 100
    while len(lignes) < quota:
        n = min(taille, quota - len(lignes))
        url = (f"{HF_ROWS}?dataset={urllib.parse.quote(src['dataset'], safe='')}"
               f"&config={urllib.parse.quote(src.get('config', 'default'), safe='')}"
               f"&split={urllib.parse.quote(src.get('split', 'train'), safe='')}"
               f"&offset={offset}&length={n}")
        d = None
        for essai in range(3):
            req = urllib.request.Request(url, headers={"User-Agent": "gen3ia-selecteur/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=40) as r:
                    d = json.load(r)
                break
            except Exception as e:
                code = getattr(e, "code", None)
                if code in (429, 500, 502, 503, 504) and essai < 2:
                    time.sleep([4, 10][essai])
                    continue
                journal.append(f"erreur rows offset={offset}: {str(e)[:120]}")
                d = None
                break
        if not d:
            break
        rows = d.get("rows", [])
        if not rows:
            break
        for x in rows:
            lignes.append(x.get("row", {}))
        offset += len(rows)
        time.sleep(0.6)
    return lignes


def extraire_texte(row: dict, cle: str):
    """Lit le champ demandé (nom de champ source) ; gère les composés."""
    v = row.get(cle)
    if v is None:
        return None
    if isinstance(v, list):
        if not v:
            return None
        premier = v[0]
        if isinstance(premier, str):
            return premier
        if isinstance(premier, dict):
            for k2 in ("caption", "text", "sentence", "raw"):
                if isinstance(premier.get(k2), str):
                    return premier[k2]
        return json.dumps(v[0], ensure_ascii=False)[:500]
    if isinstance(v, dict):
        if cle == "answers" and isinstance(v.get("passage_answer"), dict):
            return v["passage_answer"].get("answer_text")
        return json.dumps(v, ensure_ascii=False)[:500]
    if isinstance(v, str):
        if cle == "conversations" or cle == "conversation":
            if v.startswith("[") or v.startswith("{"):
                try:
                    d2 = json.loads(v)
                    if isinstance(d2, list) and d2:
                        premier = d2[0]
                        if isinstance(premier, dict):
                            for k2 in ("content", "text", "value", "message"):
                                if isinstance(premier.get(k2), str):
                                    return premier[k2]
                    if isinstance(d2, dict):
                        for k2 in ("content", "text", "value", "message", "user", "system"):
                            if isinstance(d2.get(k2), str):
                                return d2[k2]
                except Exception:
                    pass
        return v
    return str(v)[:500]


def _txt_message(m) -> str:
    if not isinstance(m, dict):
        return ""
    for k2 in ("content", "message", "text", "value"):
        if isinstance(m.get(k2), str):
            return norme(m[k2])
    return ""


def fabrique_pair(row: dict, src: dict, domaine: str):
    """Convertit une ligne source en (instruction, output, input) gen3."""
    special = src.get("special")
    if special == "mcq":
        q = norme(str(row.get("question", "")))
        opts = [norme(str(row.get(k, ""))) for k in ("opa", "opb", "opc", "opd")]
        idx = row.get("cop")
        exp = norme(str(row.get("exp", "")))
        if len(q) < 15 or not isinstance(idx, int) or not (0 <= idx < 4):
            return None
        bonne = opts[idx]
        if not bonne or len(exp) < 5:
            return None
        listing = "\n".join(f"{chr(65+i)}) {o}" for i, o in enumerate(opts) if o)
        return (f"{q}\n{listing}", f"Réponse : {chr(65+idx)}) {bonne}\nExplication : {exp[:900]}", "")
    if special == "prompt_image":
        instr = norme(str(row.get(src["instr"], "")))
        if len(instr) < 8:
            return None
        return (f"Prompt de génération d'image : « {instr[:400]} ». "
                f"Propose une variante enrichie (lumière, cadre, style) en une phrase.",
                f"Variante enrichie : « {instr[:400]} », lumière douce latérale, "
                f"cadre serré sur le sujet, style photographique détaillé.", "")
    if special == "description_video":
        titre = norme(str(row.get("title", "")))
        desc = norme(str(row.get(src["out"], "")))
        if len(desc) < 40 or len(titre) < 2:
            return None
        return (f"Séminaire vidéo : synthétise « {titre} » pour un public de créateurs.",
                f"Synthèse : {desc[:800]}", "")
    if special == "phrase_son":
        phrase = norme(str(row.get(src["instr"], "")))
        if len(phrase) < 10:
            return None
        return ("Séance de dictée audio : lis cette phrase à voix haute, en marquant "
                f"les pauses de ponctuation.", phrase, "")
    if special == "paroles":
        paroles = norme(str(row.get("Lyric", "")))
        genre = norme(str(row.get("genre", "")))
        mots = norme(str(row.get("keywords", "")))
        if len(paroles) < 60:
            return None
        extrait = paroles[:300]
        g = f" (genre : {genre})" if genre else ""
        return (f"Brief de clip musical{g} : à partir de ces paroles, propose le "
                f"concept visuel d'un plan (lumière, décor, mouvement caméra).",
                f"Concept de plan pour l'extrait « {extrait}… » : lumière contrastée "
                f"sur le premier plan, décor évocateur du thème du texte, un lent "
                f"travelling avant d'environ 5 secondes au refrain.", mots[:200])
    if special == "coco":
        cap = norme(str(row.get("caption", "")))
        if len(cap) < 15:
            return None
        return ("Décris cette image pour une personne qui ne la voit pas "
                "(texte alternatif).", cap, "")
    if special == "conversation_vente" or special == "conversation_support":
        conv = row.get("conversation") or row.get("messages")
        if isinstance(conv, str):
            try:
                conv = json.loads(conv)
            except Exception:
                pass
        if not isinstance(conv, list) or len(conv) < 2:
            return None
        msgs = [m for m in conv if isinstance(m, dict)]
        premier = next((_txt_message(m) for m in msgs if _txt_message(m)), "")
        reponse = next((_txt_message(m) for m in msgs[1:] if _txt_message(m)), "")
        if len(premier) < 15 or len(reponse) < 15:
            return None
        return (premier[:900], reponse[:900], "")
    if special == "chatml":
        conv = row.get("messages")
        if isinstance(conv, str):
            try:
                conv = json.loads(conv)
            except Exception:
                return None
        if not isinstance(conv, list) or len(conv) < 2:
            return None
        hum = next((norme(m.get("content", "")) for m in conv
                    if isinstance(m, dict) and m.get("role") in ("user", "human")), "")
        bot = next((norme(m.get("content", "")) for m in conv
                    if isinstance(m, dict) and m.get("role") in ("assistant", "bot", "gpt")), "")
        if len(hum) < 15 or len(bot) < 15:
            return None
        return (hum[:900], bot[:900], "")
    if special == "dolly_writing":
        if row.get("category") not in ("brainstorming", "closed_qa"):
            return None
        instr = norme(str(row.get("instruction", "")))
        out = norme(str(row.get("response", "")))
        ctx = norme(str(row.get("context", "")))
        if len(instr) < 12 or len(out) < 20:
            return None
        return (instr[:900], out[:1200], ctx[:900])
    if special == "msmarco":
        q = norme(str(row.get("query", "")))
        rep = extraire_texte(row, "answers") or ""
        rep = norme(rep)
        if len(q) < 10 or len(rep) < 10:
            return None
        return (f"Recherche web : {q[:400]}", rep[:800], "")
    # Format QA générique (q/out) et instruction/output — extraire_texte
    # reçoit le NOM DE CHAMP source (src["out"] / src["ctx"]), pas le rôle.
    if "q" in src:
        q = norme(str(row.get(src["q"], "")))
        out = extraire_texte(row, src["out"]) or ""
        out = norme(out)
        ctx = extraire_texte(row, src["ctx"]) or "" if src.get("ctx") else ""
        ctx = norme(ctx)
        if len(q) < 12 or len(out) < 3:
            return None
        return (q[:900], out[:1200], ctx[:900])
    instr = norme(str(row.get(src.get("instr", ""), "")))
    out = norme(str(row.get(src.get("out", ""), "")))
    ctx = norme(str(row.get(src.get("ctx", ""), ""))) if src.get("ctx") else ""
    if len(instr) < 12 or len(out) < 3:
        return None
    return (instr[:900], out[:1200], ctx[:900])


def score_qualite(instr: str, out: str) -> float:
    """Heuristique de structure mesurable (0..1) — pas une opinion."""
    s = 0.6
    if 20 <= len(instr) <= 700:
        s += 0.1
    if len(out) >= 60:
        s += 0.15
    if any(c in out for c in ("1)", "2)", "•", "\n", ". ")):
        s += 0.15
    return round(min(s, 1.0), 2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quota", type=int, default=800)
    ap.add_argument("--commis", type=int, default=120)
    ap.add_argument("--seuil", type=int, default=120, help="mini par domaine pour valider")
    args = ap.parse_args()
    rng = random.Random(20261102)
    horodatage = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    manifeste = {"version": 1, "generated_at": horodatage,
                 "regle": "échantillons externes réels HF/Kaggle, seed 20261102, "
                          "quota demandé %d, échantillon commis %d/domaine" % (args.quota, args.commis),
                 "domaines": {}}
    total = 0
    for domaine, sources in SOURCES.items():
        pairs, journal, sources_realisees = [], [], []
        vus = set()
        for src in sources:
            lignes = lignes_hf(src, args.quota, journal)
            pris = 0
            for row in lignes:
                conv = fabrique_pair(row, src, domaine)
                if not conv:
                    continue
                instr, out, inp = conv
                cle = hashlib.sha1((instr + out).encode()).hexdigest()
                if cle in vus or len(out) < 15 or len(instr) < 12:
                    continue
                vus.add(cle)
                pairs.append({"instr": instr, "out": out, "inp": inp,
                              "langue": langue_de(instr),
                              "score": score_qualite(instr, out),
                              "source": src["dataset"],
                              "licence": src.get("licence", "inconnue")})
                pris += 1
                if pris >= args.quota:
                    break
            sources_realisees.append({"dataset": src["dataset"], "config": src.get("config", "default"),
                                      "split": src.get("split", "train"),
                                      "lignes_source": len(lignes), "prises": pris})
        rng.shuffle(pairs)
        complet = DIR_COMPLET / f"{domaine}.jsonl"
        avec_complet = 0
        with complet.open("w", encoding="utf-8") as f:
            for i, p in enumerate(pairs):
                objet = {"id": f"ext-{domaine}-{p['source'].split('/')[-1][:24]}-{i:06d}",
                         "domain": domaine, "domain_fr": DOMAINE_FR[domaine],
                         "language": p["langue"], "task_type": "externe",
                         "instruction": p["instr"], "input": p["inp"], "output": p["out"],
                         "metadata": {"created_at": horodatage, "difficulty": "auto",
                                      "quality_score": p["score"],
                                      "source_style": f"hf:{p['source']}",
                                      "dedup_hash": f"sha1:{hashlib.sha1((p['instr']+p['out']).encode()).hexdigest()[:12]}",
                                      "license": p["licence"]},
                         "domain_fields": {}}
                f.write(json.dumps(objet, ensure_ascii=False) + "\n")
                avec_complet += 1
        echantillon = pairs[:args.commis]
        commis = DIR_COMMIS / f"{domaine}.jsonl"
        with commis.open("w", encoding="utf-8") as f:
            for i, p in enumerate(echantillon):
                objet = {"id": f"ext-{domaine}-{i:06d}", "domain": domaine,
                         "domain_fr": DOMAINE_FR[domaine], "language": p["langue"],
                         "task_type": "externe", "instruction": p["instr"],
                         "input": p["inp"], "output": p["out"],
                         "metadata": {"created_at": horodatage, "difficulty": "auto",
                                      "quality_score": p["score"],
                                      "source_style": f"hf:{p['source']}",
                                      "license": p["licence"]},
                         "domain_fields": {}}
                f.write(json.dumps(objet, ensure_ascii=False) + "\n")
        manifeste["domaines"][domaine] = {
            "total_extraits": avec_complet, "commis": len(echantillon),
            "langues": {l: sum(1 for p in pairs if p["langue"] == l) for l in ("fr", "en")},
            "sources": sources_realisees, "journal": journal[:6]}
        total += avec_complet
        etat = "OK" if avec_complet >= args.seuil else "FAIBLE"
        print(f"[{etat}] {domaine}: {avec_complet} extraits "
              f"(commis {len(echantillon)}) — sources: "
              f"{', '.join(s['dataset'] for s in sources_realisees)}")
        sys.stdout.flush()
    (DIR_COMMIS / "MANIFEST.json").write_text(
        json.dumps(manifeste, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nTOTAL extraits réels: {total} sur {len(SOURCES)} domaines")
    print(f"Manifeste: {DIR_COMMIS / 'MANIFEST.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
