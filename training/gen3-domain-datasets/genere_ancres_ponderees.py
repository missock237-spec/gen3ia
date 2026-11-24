#!/usr/bin/env python3
"""GÉNÉRATEUR DES ANCHRES PONDÉRÉES v5.1 — Job 478451.

Mesure, sur les datasets complets des 18 domaines (100 000 lignes/domaine,
graine 20261024, régénérés bit-à-bit par generateur.py), la CONCENTRATION
RÉELLE de chaque mot-clé de routage, puis émet le module TS
`lib/neural/training/ancres-ponderees-v51.ts` :

  - POIDS_ANCRS_V51 : token → { domaine → masse d'usage } pour les tokens
    partagés par plusieurs domaines (masse = occurrences du token dans le
    domaine / occurrences totales du token dans les 18 datasets). Un token
    exclusif à un domaine (masse 1) n'est pas stocké : poids par défaut 1.
    → un mot-clé ne rapporte plus 2 points entiers à un domaine quand son
    usage réel est majoritairement ailleurs (ex. « analyse », « qualité »,
    « suivi », « web » — causes mesurées des collisions de routage v5).
  - NOUVEAUX_ANCRS_V51 : tokens très concentrés (présent dans ≤ 2 domaines,
    ≥ 12 occurrences, masse ≥ 0.8) absents des listes v5 — extraits avec le
    TOKENISEUR EXACT du routeur (découpage non-alphanumérique : « pare-feu »
    → « pare » + « feu », corrige l'angle mort de l'extraction v5 qui
    découpait sur les espaces).

Utilisation :
  python3 training/gen3-domain-datasets/genere_ancres_ponderees.py
  (nécessite data/complet/<domaine>.jsonl générés par generateur.py)

Le module émis est PUR (zéro I/O), importé par le routeur lexical de
production (domaines.ts) et par son miroir d'évaluation (evaluation-1m.ts).
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

BASE = Path(__file__).parent
COMPLET = BASE / "data" / "complet"
SORTIE_TS = BASE.parent.parent / "lib" / "neural" / "training" / "ancres-ponderees-v51.ts"
SORTIE_ENRICHIS_TS = BASE.parent.parent / "lib" / "neural" / "training" / "mots-cles-enrichis.ts"
SORTIE_STATS = BASE.parent.parent / "var" / "rapports" / "ancres-ponderees-v51-stats.json"

SEUIL_NOUVEAU_OCCURRENCES = 8
SEUIL_NOUVEAU_DOMAINES = 2
SEUIL_NOUVEAU_MASSE = 0.80
SEUIL_MASSE_STOCKAGE = 0.02
MAX_NOUVEAUX_PAR_DOMAINE = 40
LONGUEUR_MIN = 3

# Régénération de MOTS_CLES_ENRICHIS avec le tokeniseur EXACT du routeur
# (v5 découpait sur les espaces : angle mort « pare-feu », démonstratifs EN
# aspirés par des tâches « these images… »).
SEUIL_ENRICHIS_OCCURRENCES = 8
SEUIL_ENRICHIS_DOMAINES = 3
MAX_ENRICHIS_PAR_DOMAINE = 50

# Complément CURATÉ v5.1 — vocabulaire métier des prompts produit réels FR/EN
# (tests moteur + fabriques d'évaluation) ABSENT des instructions des
# datasets synthétiques (mesuré : 0 occurrence, sauf « tableau » polyssémique
# dominé par multimodal au sens « grille de données »). Chaque token pèse
# base 1 FLAT (insensible à POIDS_ANCRS_V51) : ce sont des ancres d'expert,
# bornées (20 tokens), à provenance documentée — chaque token appartient au
# métier du domaine de façon défendable (« lettre de mission », « tableau de
# bord », « sous-titres », « fact-check », « résultats d'expérience ») ; les
# trois surcharges de polyssémie sont justifiées sous la table.
ANCRS_CURATES_V51: dict[str, list[str]] = {
    "redaction_documents": ["professionnel", "lettre", "destinataire", "rapport"],
    "analyse_donnees": ["tableau", "bord", "visualisation"],
    "video": ["titres", "explicatif"],
    "recherche_web": ["fact", "browse", "urls", "cite", "sources"],
    "recherche_scientifique": ["resultats", "mesure"],
    "vente": ["commerciale", "proposition"],
    "conseiller_commercial": ["recommend", "consulting"],
}
# Justifications des surcharges de polyssémie (mesure instruction contredite
# par le métier réel, jugement d'expert documenté) :
#  - « rapport » : le métier rédaction (rapport professionnel, rapport
#    d'audit) vs « rapport de bug » dev_web — polyssémie FR, l'ancre curatée
#    s'ajoute sans retirer la masse mesurée du dev_web.
#  - « proposition » : « proposition commerciale » est du vocabulaire vente ;
#    le pack webdev dit « proposition » au sens fonctionnalité proposée.
#  - « recommend » : verbe métier du conseil (« recommend the best plan ») ;
#    le pack webdev l'emploie au sens « produits recommandés » d'une webapp.

STOPWORDS = {
    # FR
    "les", "des", "une", "est", "pour", "avec", "dans", "que", "qui", "sur",
    "aux", "cette", "son", "ses", "par", "plus", "vous", "nous", "etre",
    "avoir", "fait", "faire", "comme", "mais", "donc", "leur", "leurs", "elle",
    "elles", "lui", "mon", "ton", "notre", "votre", "tant", "puis", "aussi",
    "tout", "tous", "toute", "tres", "etre", "cela", "celui", "sans", "sous",
    "chez", "chaque", "avant", "apres", "entre", "vers", "depuis", "pendant",
    "être", "peut", "doit", "sont", "sera", "etat", "exemple", "exemples",
    "cas", "type", "types", "donnee", "donnees", "faut", "autre", "autres",
    # EN
    "the", "and", "for", "with", "that", "this", "these", "those", "from",
    "into", "your", "you", "they", "them", "their", "there", "then", "than",
    "when", "what", "which", "will", "would", "should", "could", "have",
    "been", "were", "also", "just", "only", "some", "such", "each", "make",
    "made", "need", "want", "using", "used", "use", "get", "got", "set",
    "not", "but", "are", "was", "can", "may", "one", "two", "per", "via",
    "about", "after", "before", "while", "where", "been", "being",
    # v5.1 correctif (test « Comment vas-tu aujourd'hui ? » → doit rester null) :
    # interrogatifs FR/EN, polarité, ordinaux et quantifieurs génériques —
    # tokens d'artefact de dataset qui déclenchent de FAUX positifs de
    # routage sur du chatter sans contenu métier (cf. domaines.test.ts).
    "comment", "pourquoi", "quand", "combien", "non", "oui", "peu", "moins",
    "quel", "quels", "quelle", "quelles", "fais", "mes", "premier",
    "premiere", "seconde", "deuxieme", "trois", "six", "off",
    "how", "does", "why", "who", "now", "good", "yes", "no", "show",
}

ID_DOMAINES_INTERDITS: set[str] = set()


def tokeniser(texte: str) -> list[str]:
    """Miroir EXACT de tokenize() (lib/neural/encoding/text-encoder.ts)."""
    t = texte.lower()
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    return [m for m in re.split(r"[^a-z0-9]+", t) if m]


def mots_cles_noyau() -> dict[str, list[str]]:
    """Extrait id → motsCles du bloc DOMAINES_GEN3 de domaines.ts."""
    source = (BASE.parent.parent / "lib" / "neural" / "training" / "domaines.ts").read_text(encoding="utf-8")
    noyau: dict[str, list[str]] = {}
    for bloc in re.split(r"\n  \{", source):
        mid = re.search(r'id:\s*"([a-z_]+)"', bloc)
        mmots = re.search(r"motsCles:\s*\[([^\]]+)\]", bloc)
        if mid and mmots:
            noyau[mid.group(1)] = re.findall(r'"([^"]+)"', mmots.group(1))
    return noyau


def ancres_etendues() -> dict[str, list[str]]:
    """Miroir de ANCRES_ETENDUES (domaines.ts) — les listes littérales."""
    source = (BASE.parent.parent / "lib" / "neural" / "training" / "domaines.ts").read_text(encoding="utf-8")
    bloc = re.search(
        r"const ANCRES_ETENDUES: Record<string, string\[\]> = \{(.*?)\n\};",
        source, re.S,
    )
    if not bloc:
        raise SystemExit("ANCRES_ETENDUES introuvable dans domaines.ts")
    resultat: dict[str, list[str]] = {}
    for m in re.finditer(r'([a-z_]+):\s*\[([^\]]*)\]', bloc.group(1)):
        resultat[m.group(1)] = re.findall(r'"([^"]+)"', m.group(2))
    return resultat


def ancres_enrichis() -> dict[str, list[str]]:
    """Lit MOTS_CLES_ENRICHIS (mots-cles-enrichis.ts)."""
    source = (BASE.parent.parent / "lib" / "neural" / "training" / "mots-cles-enrichis.ts").read_text(encoding="utf-8")
    resultat: dict[str, list[str]] = {}
    for m in re.finditer(r'"([a-z_]+)":\s*\[([^\]]*)\]', source):
        resultat[m.group(1)] = re.findall(r"'([^']+)'", m.group(2))
    return resultat


def principales() -> int:
    noyau = mots_cles_noyau()
    etendues = ancres_etendues()
    ID_DOMAINES_INTERDITS.update(noyau.keys())

    fichiers = []
    for chemin in sorted(COMPLET.glob("*.jsonl.gz")):
        fichiers.append(chemin)
    gz_vus = {c.name.replace(".gz", "") for c in fichiers}
    for chemin in sorted(COMPLET.glob("*.jsonl")):
        if chemin.name in gz_vus:
            continue  # version .gz plus récente fait foi (ex. dev_web = pack 10 types)
        fichiers.append(chemin)
    fichiers.sort()
    if len(fichiers) < 18:
        print(f"ECHEC: {len(fichiers)} datasets trouvés dans {COMPLET} (18 attendus).")
        print("Lancer d'abord : python3 generateur.py --lignes 100000")
        return 2

    freq: dict[str, Counter] = {}
    lignes_lues = 0
    for chemin in fichiers:
        domaine = chemin.name.split(".")[0]
        compteur: Counter = Counter()
        ouvre = gzip.open if chemin.suffix == ".gz" else open
        with ouvre(chemin, "rt", encoding="utf-8") as f:
            for ligne in f:
                if not ligne.strip():
                    continue
                try:
                    obj = json.loads(ligne)
                except Exception:
                    continue
                lignes_lues += 1
                for tok in tokeniser(obj.get("instruction", "")):
                    compteur[tok] += 1
        freq[domaine] = compteur
        print(f"  compté {domaine}: {sum(compteur.values()):,} tokens", flush=True)

    # Masse globale par token.
    total_par_token: Counter = Counter()
    for compteur in freq.values():
        for tok, n in compteur.items():
            total_par_token[tok] += n

    # 0. ENRICHIS régénérés (tokeniseur exact du routeur, critères v5 :
    #    présent dans ≤ 3 domaines, ≥ 8 occurrences, ratio = n / dom²).
    enrichis: dict[str, list[str]] = {}
    for domain, compteur in sorted(freq.items()):
        candidats = []
        for tok, n in compteur.items():
            nb_domains = sum(1 for d in freq if freq[d].get(tok, 0) > 0)
            if nb_domains <= SEUIL_ENRICHIS_DOMAINES and n >= SEUIL_ENRICHIS_OCCURRENCES \
                    and len(tok) >= 4 and tok.isalpha() and tok not in STOPWORDS:
                candidats.append((tok, n / (nb_domains ** 2)))
        candidats.sort(key=lambda x: (-x[1], x[0]))
        enrichis[domain] = [t for t, _ in candidats[:MAX_ENRICHIS_PAR_DOMAINE]]

    # 1. POIDS des ancres existantes (tokens partagés seulement).
    tous_ancres: dict[str, set[str]] = {}
    for domain, mots in noyau.items():
        for m in mots:
            tous_ancres.setdefault(m, set()).add(domain)
    for domain, mots in etendues.items():
        for m in mots:
            tous_ancres.setdefault(m, set()).add(domain)
    for domain, mots in enrichis.items():
        for m in mots:
            tous_ancres.setdefault(m, set()).add(domain)

    poids: dict[str, dict[str, float]] = {}
    stats_partage: list[dict] = []
    for tok in sorted(tous_ancres):
        total = total_par_token.get(tok, 0)
        if total == 0:
            continue  # ancre jamais rencontrée : poids par défaut 1 partout
        domaines_presents = [d for d in freq if freq[d].get(tok, 0) > 0]
        if len(domaines_presents) <= 1:
            continue  # exclusif : poids 1 par défaut, rien à stocker
        masse = {}
        for d in domaines_presents:
            m = freq[d][tok] / total
            if m >= SEUIL_MASSE_STOCKAGE:
                masse[d] = round(m, 2)
        if len(masse) > 1:
            poids[tok] = masse
            stats_partage.append({
                "token": tok, "total_occurrences": total,
                "masse": masse,
            })

    # 2. NOUVEAUX ancres exclusifs (tokeniseur exact du routeur).
    curates_tous = {t for mots in ANCRS_CURATES_V51.values() for t in mots}
    nouveaux: dict[str, list[str]] = {}
    for domain, compteur in sorted(freq.items()):
        candidats = []
        for tok, n in compteur.items():
            if n < SEUIL_NOUVEAU_OCCURRENCES or len(tok) < LONGUEUR_MIN:
                continue
            if tok in STOPWORDS or tok in tous_ancres or tok in ID_DOMAINES_INTERDITS or tok in curates_tous:
                continue
            if not tok.isalpha():
                continue
            domaines_presents = sum(1 for d in freq if freq[d].get(tok, 0) > 0)
            if domaines_presents > SEUIL_NOUVEAU_DOMAINES:
                continue
            masse = n / total_par_token[tok]
            if masse < SEUIL_NOUVEAU_MASSE:
                continue
            candidats.append((tok, n * masse, n))
        candidats.sort(key=lambda x: (-x[1], x[0]))
        nouveaux[domain] = [t for t, _, _ in candidats[:MAX_NOUVEAUX_PAR_DOMAINE]]

    # 3. Émission du module TS.
    lignes_ts = [
        "/**",
        " * ANCHRES PONDÉRÉES v5.1 — Job 478451.",
        " *",
        " * POIDS_ANCRS_V51 : masse d'usage RÉELLE par domaine pour chaque token",
        " * de routage partagé (mesurée sur les 18 datasets complets, 100 000",
        " * lignes/domaine, graine 20261024 — tokeniseur exact du routeur).",
        " * Un token absent de la table pèse 1 (exclusif à un domaine).",
        " *",
        " * NOUVEAUX_ANCRS_V51 : tokens exclusifs découverts (≤ 2 domaines,",
        " * ≥ 12 occurrences, masse ≥ 0.8) absents des listes v5 — extraits",
        " * avec le tokeniseur non-alphanumérique du routeur (« pare-feu » →",
        " * « pare » + « feu »), corrigeant l'angle mort de l'extraction v5.",
        " *",
        " * Généré par genere_ancres_ponderees.py — ne pas éditer à la main.",
        " */",
        "export const POIDS_ANCRS_V51: Record<string, Record<string, number>> = {",
    ]
    for tok in sorted(poids):
        entrees = ", ".join(f'"{d}": {w}' for d, w in sorted(poids[tok].items()))
        lignes_ts.append(f'  "{tok}": {{ {entrees} }},')
    lignes_ts.append("};")
    lignes_ts.append("")
    lignes_ts.append("export const NOUVEAUX_ANCRS_V51: Record<string, readonly string[]> = {")
    for domain in sorted(nouveaux):
        mots = ", ".join(f'"{m}"' for m in nouveaux[domain])
        lignes_ts.append(f'  "{domain}": [{mots}],')
    lignes_ts.append("};")
    lignes_ts.append("")
    lignes_ts.append("/**")
    lignes_ts.append(" * Complément CURATÉ (base 1 flat, insensible à POIDS_ANCRS_V51) :")
    lignes_ts.append(" * vocabulaire métier des prompts produit réels, mesuré ABSENT des")
    lignes_ts.append(" * instructions des datasets (provenance et justification :")
    lignes_ts.append(" * genere_ancres_ponderees.py — ANCRS_CURATES_V51).")
    lignes_ts.append(" */")
    lignes_ts.append("export const ANCRS_CURATES_V51: Record<string, readonly string[]> = {")
    for domain, mots in sorted(ANCRS_CURATES_V51.items()):
        ligne = ", ".join(f'"{m}"' for m in mots)
        lignes_ts.append(f'  "{domain}": [{ligne}],')
    lignes_ts.append("};")
    lignes_ts.append("")
    SORTIE_TS.parent.mkdir(parents=True, exist_ok=True)
    SORTIE_TS.write_text("\n".join(lignes_ts), encoding="utf-8")

    # 4. Régénération de mots-cles-enrichis.ts (même schéma d'export v5).
    total_enr = sum(len(v) for v in enrichis.values())
    ts_enr = [
        "/**",
        " * MOTS-CLÉS ENRICHIS DES 18 DOMAINES — v5.1 (Job 478451).",
        " * Tokens discriminants extraits des datasets complets (100 000",
        " * lignes/domaine, graine 20261024) avec le TOKENISEUR EXACT du",
        " * routeur (minuscules, NFD sans diacritiques, découpage non-",
        " * alphanumérique) — critères v5 : présent dans ≤ 3 domaines,",
        " * ≥ 8 occurrences, ratio = n / dom², stoplist élargie.",
        " * Généré par genere_ancres_ponderees.py — ne pas éditer à la main.",
        " */",
        "export const MOTS_CLES_ENRICHIS: Record<string, readonly string[]> = {",
    ]
    for dom in sorted(enrichis):
        mots = ", ".join(f"'{m}'" for m in enrichis[dom])
        ts_enr.append(f'  "{dom}": [{mots}],')
    ts_enr.append("};")
    ts_enr.append("")
    SORTIE_ENRICHIS_TS.write_text("\n".join(ts_enr), encoding="utf-8")

    SORTIE_STATS.parent.mkdir(parents=True, exist_ok=True)
    SORTIE_STATS.write_text(json.dumps({
        "genere_le": __import__("datetime").datetime.now(__import__("datetime").UTC).isoformat(),
        "lignes_lues": lignes_lues,
        "tokens_pondere": len(poids),
        "nouveaux_ancres": {d: len(v) for d, v in nouveaux.items()},
        "curates": {d: len(v) for d, v in ANCRS_CURATES_V51.items()},
        "enrichis_regeneres": {d: len(v) for d, v in enrichis.items()},
        "partages_mesures": stats_partage[:200],
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"POIDS_ANCRS_V51 : {len(poids)} tokens pondérés")
    print(f"NOUVEAUX_ANCRS_V51 : {sum(len(v) for v in nouveaux.values())} tokens sur {len(nouveaux)} domaines")
    print(f"MOTS_CLES_ENRICHIS régénérés : {total_enr} tokens sur {len(enrichis)} domaines")
    print(f"écrit : {SORTIE_TS}")
    print(f"écrit : {SORTIE_ENRICHIS_TS}")
    return 0


if __name__ == "__main__":
    sys.exit(principales())
