"""
DOMAINE SAVOIR — rédaction de documents, sciences humaines, recherche
scientifique, recherche web. Variation riche par slots (type, audience,
discipline, période, source, contrainte de fraîcheur...).
"""

from __future__ import annotations

import random

from .base import SpecDomaine, choisir
from .variations import Lex, joindre, nombre, pourcentage

# ─────────────────────────────────────────────────────────────────────────────
# 10. RÉDACTION DE DOCUMENTS
# ─────────────────────────────────────────────────────────────────────────────

RD = Lex(
    type={
        "fr": ["rapport d'activité", "manuel d'utilisation", "compte rendu de réunion",
               "article de blog technique", "courrier administratif", "note de synthèse",
               "cahier des charges", "fiche de procédure"],
        "en": ["activity report", "user manual", "meeting minutes",
               "technical blog post", "administrative letter", "briefing note",
               "requirements document", "procedure sheet"],
    },
    audience={
        "fr": ["direction non technique", "équipe technique", "clients finaux",
               "partenaires institutionnels", "nouveaux arrivants", "auditeur externe"],
        "en": ["non-technical leadership", "technical team", "end customers",
               "institutional partners", "newcomers", "external auditor"],
    },
    ton={
        "fr": ["neutre et factuel", "chaleureux mais précis", "formel administratif", "pédagogique"],
        "en": ["neutral and factual", "warm but precise", "formal administrative", "teaching-oriented"],
    },
    volume={
        "fr": ["1 page", "2 pages", "5 pages", "10 pages"],
        "en": ["1 page", "2 pages", "5 pages", "10 pages"],
    },
)

RD_PROBLEMES = {
    "fr": [
        ("trop long et sans plan lisible", "couper 30 % : fusionner les redondances, titres informatifs, une idée par paragraphe"),
        ("ton trop familier pour la cible", "registre neutre, supprimer les familiarités, garder une accroche humaine"),
        ("conclusions non étayées", "adosser chaque conclusion à un fait du corps, sinon la marquer « hypothèse »"),
        ("jargon non défini", "définir chaque terme à sa première occurrence ou le remplacer"),
    ],
    "en": [
        ("too long with no readable structure", "cut 30%: merge redundancies, informative titles, one idea per paragraph"),
        ("tone too casual for the audience", "neutral register, drop colloquialisms, keep one human hook"),
        ("conclusions not backed up", "tie each conclusion to a body fact, else label it \"hypothesis\""),
        ("undefined jargon", "define each term at first use or replace it"),
    ],
}


def rd_document(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = RD.tirer(rng, lang)
    sections = nombre(rng, 3, 6)
    actions = nombre(rng, 2, 4)
    if lang == "fr":
        instruction = (
            f"Plan de {s['type']} ({s['volume']}) pour {s['audience']}, ton {s['ton']}."
        )
        output = (
            f"Plan de {s['type']} — {s['audience']} :\n"
            f"1) Résumé en 5 lignes, décision demandée en tête ;\n"
            f"2) Contexte en 2 paragraphes (situation, enjeu chiffré) ;\n"
            f"3) Corps en {sections} sections max — une idée par paragraphe, chaque affirmation portée par un fait ;\n"
            f"4) Recommandations : {actions} actions datées avec responsable ;\n"
            f"5) Annexe : données et méthode.\n"
            f"Style ({s['ton']}) : voix active, zéro jargon non défini, titres informatifs."
        )
    else:
        instruction = (
            f"{s['type']} outline ({s['volume']}) for {s['audience']}, {s['ton']} tone."
        )
        output = (
            f"{s['type']} outline — {s['audience']}:\n"
            f"1) 5-line summary, requested decision first ;\n"
            f"2) Context in 2 paragraphs (situation, quantified stake) ;\n"
            f"3" f") Body in {sections} sections max — one idea per paragraph, every claim carried by a fact ;\n"
            f"4" f") Recommendations: {actions} dated actions with an owner ;\n"
            f"5" f") Appendix: data and method.\n"
            f"Style ({s['ton']}): active voice, no undefined jargon, informative titles."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "plan_document",
        "safety_label": "sans_objet",
        "document": {"type": s["type"], "audience": s["audience"], "volume": s["volume"], "sections": sections},
    }


def rd_relecture(rng: random.Random, lang: str, ctx: dict) -> dict:
    p, remede = choisir(rng, RD_PROBLEMES[lang])
    type_doc = choisir(rng, RD.slots["type"][lang])
    coupes = pourcentage(rng, 15, 35)
    if lang == "fr":
        instruction = f"Revois mon {type_doc} : {p}."
        output = (
            f"Remède principal : {remede}.\n"
            f"Passe en 3 tours : 1) structure (les titres racontent-ils l'histoire seuls ?) ; "
            f"2) paragraphes (première phrase = idée, le reste = preuve) ; "
            f"3) phrases (couper doubles négations et adverbes de remplissage, viser -{coupes}).\n"
            f"Finir en lisant à voix haute le début et la fin : les deux seuls passages lus par tous."
        )
    else:
        instruction = f"Review my {type_doc}: {p}."
        output = (
            f"Main fix: {remede}.\n"
            f"3-pass review: 1) structure (do titles alone tell the story?) ; "
            f"2) paragraphs (first sentence = idea, rest = evidence) ; "
            f"3) sentences (cut double negatives and filler adverbs, aim -{coupes}).\n"
            f"Finish by reading opening and ending aloud: the only passages everyone reads."
        )
    return {
        "instruction": instruction,
        "input": p,
        "output": output,
        "task_type": "relecture",
        "safety_label": "sans_objet",
        "probleme": p,
        "document": type_doc,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 11. SCIENCES HUMAINES
# ─────────────────────────────────────────────────────────────────────────────

SH = Lex(
    discipline={
        "fr": ["histoire", "sociologie", "philosophie", "géographie humaine", "anthropologie", "science politique"],
        "en": ["history", "sociology", "philosophy", "human geography", "anthropology", "political science"],
    },
    periode={
        "fr": ["l'époque coloniale et ses traces contemporaines", "les indépendances des années 1960",
               "l'urbanisation rapide du XXIe siècle", "les mobilités et diasporas",
               "les économies informelles de quartier", "l'école comme ascenseur social"],
        "en": ["the colonial era and its contemporary traces", "the 1960s independences",
               "rapid 21st-century urbanization", "mobilities and diasporas",
               "neighborhood informal economies", "school as a social ladder"],
    },
    source={
        "fr": ["archives administratives", "entretiens oraux", "presse d'époque", "statistiques officielles",
               "photographies de famille", "journaux personnels"],
        "en": ["administrative archives", "oral interviews", "period press", "official statistics",
               "family photographs", "personal diaries"],
    },
)

SH_ANGLES = {
    "fr": ["facteurs économiques", "facteurs politiques", "facteurs culturels", "acteurs dominants et dominés", "échelles locale et nationale"],
    "en": ["economic factors", "political factors", "cultural factors", "dominant and dominated actors", "local and national scales"],
}


def sh_analyse(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = SH.tirer(rng, lang)
    angles = joindre(rng.sample(SH_ANGLES[lang], k=3), lang)
    sources = joindre(rng.sample(s["source"] if isinstance(s["source"], list) else [s["source"]], k=1), lang)
    # Deux sources complémentaires pour le croisement.
    deux_sources = rng.sample(SH.slots["source"][lang], k=2)
    if lang == "fr":
        instruction = (
            f"Analyse {s['discipline']} de « {s['periode']} », à partir de {joindre(deux_sources, 'fr')} — "
            f"méthode et limites annoncées."
        )
        output = (
            f"Grille d'analyse ({s['discipline']}) :\n"
            f"1) Question précise (qui, où, quand, avec quelles conséquences) ;\n"
            f"2) Sources : {joindre(deux_sources, 'fr')} — critique de chacune (qui écrit, pour qui, quand ?) ;\n"
            f"3) Angles croisés : {angles} — sans réduire l'un à l'autre ;\n"
            f"4) Limites : biais des sources dominantes, silences des archives, généralisation abusive.\n"
            f"Honnêteté : distinguer attesté / interprété / contesté."
        )
    else:
        instruction = (
            f"{s['discipline']} analysis of \"{s['periode']}\", based on {joindre(deux_sources, 'en')} — "
            f"method and stated limitations."
        )
        output = (
            f"Analytical grid ({s['discipline']}):\n"
            f"1) Sharp question (who, where, when, with what consequences) ;\n"
            f"2) Sources: {joindre(deux_sources, 'en')} — critique each (who writes, for whom, when?) ;\n"
            f"3" f") Crossed angles: {angles} — without reducing one to another ;\n"
            f"4" f") Limitations: dominant-source bias, archive silences, overgeneralization.\n"
            f"Honesty: separate attested / interpreted / disputed."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "analyse_sh",
        "safety_label": "sans_objet",
        "discipline": s["discipline"],
        "periode": s["periode"],
        "sources": deux_sources,
    }


def sh_pedagogie(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = SH.tirer(rng, lang)
    exemple_vivant = choisir(rng, {
        "fr": ["un marché local", "un groupe de pairs", "une règle d'école", "un arrêt de bus"],
        "en": ["a local market", "a peer group", "a school rule", "a bus stop"],
    }[lang])
    if lang == "fr":
        instruction = f"Explique un concept central de {s['discipline']} à un lycéen — sans simplification trompeuse."
        output = (
            f"Explication (niveau lycée, {s['discipline']}) :\n"
            f"1) Partir de {exemple_vivant} — situation concrète vécue ;\n"
            f"2) Nommer le concept APRÈS l'exemple, définition exacte ;\n"
            f"3) Contre-exemple pour délimiter (ce n'est PAS...) ;\n"
            f"4) Question ouverte finale qui prépare la suite.\n"
            f"Honnêteté : signaler « les spécialistes débattent de... » quand c'est le cas."
        )
    else:
        instruction = f"Explain a core {s['discipline']} concept to a high-schooler — no misleading simplification."
        output = (
            f"Explanation (high-school level, {s['discipline']}):\n"
            f"1) Start from {exemple_vivant} — a lived concrete situation ;\n"
            f"2) Name the concept AFTER the example, exact definition ;\n"
            f"3" f") Counter-example to delimit (it is NOT...) ;\n"
            f"4" f") Final open question that prepares what's next.\n"
            f"Honesty: flag \"specialists debate...\" when they do."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "pedagogie_sh",
        "safety_label": "sans_objet",
        "discipline": s["discipline"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# 12. RECHERCHE SCIENTIFIQUE
# ─────────────────────────────────────────────────────────────────────────────

RS = Lex(
    champ={
        "fr": ["agronomie tropicale", "épidémiologie", "énergie renouvelable", "hydrologie",
               "science des matériaux", "pédologie", "océanographie côtière"],
        "en": ["tropical agronomy", "epidemiology", "renewable energy", "hydrology",
               "materials science", "soil science", "coastal oceanography"],
    },
    mesure={
        "fr": ["rendement par parcelle", "taux d'adoption d'une pratique", "température et humidité",
               "concentration mesurée en laboratoire", "temps de réponse du système"],
        "en": ["yield per plot", "practice adoption rate", "temperature and humidity",
               "lab-measured concentration", "system response time"],
    },
)

RS_REPET = [3, 4, 5, 6]


def rs_protocole(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = RS.tirer(rng, lang)
    n = choisir(rng, RS_REPET)
    seuil = pourcentage(rng, 5, 20)
    if lang == "fr":
        instruction = (
            f"Protocole expérimental en {s['champ']} : mesurer {s['mesure']}, "
            f"répétitions n={n}, effet attendu ≥ {seuil}."
        )
        output = (
            f"Protocole ({s['champ']}) :\n"
            f"1) Hypothèse falsifiable en une phrase — {s['mesure']} gagne ≥ {seuil} dans les conditions testées ;\n"
            f"2) Facteurs : variable indépendante manipulée, variables contrôlées listées, confusions déclarées ;\n"
            f"3) Plan : témoins + {n} répétitions, randomisation, aveuglement quand possible ;\n"
            f"4) Mesures : instruments calibrés, seuils fixés AVANT l'expérience ;\n"
            f"5) Analyse : test annoncé a priori + taille d'effet, pas seulement p-valeur ;\n"
            f"6) Reproductibilité : données brutes + code d'analyse archivés, journal des écarts."
        )
    else:
        instruction = (
            f"Experimental protocol in {s['champ']}: measure {s['mesure']}, "
            f"replicates n={n}, expected effect ≥ {seuil}."
        )
        output = (
            f"Protocol ({s['champ']}):\n"
            f"1) One-sentence falsifiable hypothesis — {s['mesure']} gains ≥ {seuil} under tested conditions ;\n"
            f"2) Factors: manipulated independent variable, listed controls, declared confounders ;\n"
            f"3" f") Design: controls + {n} replicates, randomization, blinding when possible ;\n"
            f"4" f") Measures: calibrated instruments, thresholds fixed BEFORE the experiment ;\n"
            f"5" f") Analysis: a-priori test + effect size, not just p-value ;\n"
            f"6) Reproducibility: raw data + analysis code archived, deviation journal."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "protocole_recherche",
        "safety_label": "sans_objet",
        "champ": s["champ"],
        "repetitions": n,
    }


def rs_vulgarisation(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = RS.tirer(rng, lang)
    taille_effet = pourcentage(rng, 5, 30)
    if lang == "fr":
        instruction = f"Vulgarise un résultat en {s['champ']} sans le déformer."
        output = (
            f"Règles de non-déformation ({s['champ']}) :\n"
            f"1) Ce qui a été réellement mesuré (population, durée, conditions) avant toute généralisation ;\n"
            f"2) Taille d'effet en termes concrets (« dans ces conditions, {s['mesure']} gagne ~{taille_effet} ») ;\n"
            f"3) Limites nommées : échantillon petit, un seul site, court terme ;\n"
            f"4) Jamais « la science prouve » — « cette étude suggère », étude citée."
        )
    else:
        instruction = f"Popularize a {s['champ']} finding without distorting it."
        output = (
            f"Non-distortion rules ({s['champ']}):\n"
            f"1) What was actually measured (population, duration, conditions) before any generalization ;\n"
            f"2) Effect size in concrete terms (\"in these conditions, {s['mesure']} gains ~{taille_effet}\") ;\n"
            f"3" f") Named limitations: small sample, single site, short term ;\n"
            f"4) Never \"science proves\" — \"this study suggests\", study cited."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "vulgarisation",
        "safety_label": "sans_objet",
        "champ": s["champ"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# 13. RECHERCHE WEB
# ─────────────────────────────────────────────────────────────────────────────

RW = Lex(
    besoin={
        "fr": ["comparer deux fournisseurs d'un équipement", "vérifier une information virale avant partage",
               "trouver la documentation officielle d'un outil", "surveiller le prix d'un composant",
               "identifier les normes applicables à un produit", "retrouver une étude citée de seconde main"],
        "en": ["compare two equipment suppliers", "verify a viral claim before sharing",
               "find a tool's official documentation", "track a component's price",
               "identify standards applying to a product", "trace a second-hand cited study"],
    },
    source={
        "fr": ["site officiel du fabricant", "institut de statistique national", "norme publiée",
               "article scientifique original", "archive web horodatée"],
        "en": ["manufacturer's official site", "national statistics institute", "published standard",
               "original scientific paper", "timestamped web archive"],
    },
)

RW_PAS = {
    "fr": ["reformuler en 2-3 requêtes complémentaires (synonymes, site:, guillemets)",
           "privilégier les sources primaires et croiser au moins deux sources indépendantes",
           "vérifier la fraîcheur : date visible, archive si la page a changé",
           "noter chaque résultat : URL, date, ce qu'il établit exactement",
           "chercher activement ce qui CONTREDIT l'hypothèse de départ"],
    "en": ["reformulate into 2-3 complementary queries (synonyms, site:, quotes)",
           "prefer primary sources and cross at least two independent ones",
           "check freshness: visible date, archive if the page changed",
           "log every result: URL, date, what it exactly establishes",
           "actively search what CONTRADICTS the starting hypothesis"],
}


def rw_requete(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = RW.tirer(rng, lang)
    pas = rng.sample(RW_PAS[lang], k=4)
    if lang == "fr":
        instruction = f"Stratégie de recherche fiable pour : {s['besoin']}."
        output = (
            f"Stratégie (« {s['besoin']} ») :\n" +
            "\n".join(f"{i+1}) {p}." for i, p in enumerate(pas)) +
            f"\nRègle d'or : une affirmation non traçable est une affirmation jetable — "
            f"la source {s['source']} prime sur tout second-hand."
        )
    else:
        instruction = f"Reliable search strategy for: {s['besoin']}."
        output = (
            f"Strategy (\"{s['besoin']}\"):\n" +
            "\n".join(f"{i+1}) {p}." for i, p in enumerate(pas)) +
            f"\nGolden rule: an untraceable claim is a disposable claim — "
            f"the {s['source']} beats any second-hand source."
        )
    return {
        "instruction": instruction,
        "input": s["besoin"],
        "output": output,
        "task_type": "strategie_recherche",
        "safety_label": "sans_objet",
        "besoin": s["besoin"],
    }


def rw_verification(rng: random.Random, lang: str, ctx: dict) -> dict:
    indice = choisir(rng, {
        "fr": ["une image virale", "une capture d'écran sans source", "une statistique « qui circule »", "une citation attribuée"],
        "en": ["a viral image", "a source-less screenshot", "a \"circulating\" statistic", "an attributed quote"],
    }[lang])
    moteur = nombre(rng, 2, 3)
    if lang == "fr":
        instruction = f"Vérifier {indice} avant de la partager : protocole complet."
        output = (
            f"Protocole ({moteur} recherches inversées minimales) :\n"
            f"1) Retrouver les premières publications (moteurs inverses, archives) ;\n"
            f"2) Métadonnées quand elles existent — sans y croire aveuglément (falsifiables) ;\n"
            f"3) Cohérence physique (ombres, météo, langue des panneaux) avec l'événement revendiqué ;\n"
            f"4) Démenti/confirmation d'une source locale fiable.\n"
            f"Décision : non vérifié = non partagé. La vitesse ne vaut pas la fiabilité."
        )
    else:
        instruction = f"Verify {indice} before sharing: full protocol."
        output = (
            f"Protocol ({moteur} reverse searches minimum):\n"
            f"1) Find the earliest publications (reverse engines, archives) ;\n"
            f"2) Metadata when present — no blind trust (forgeable) ;\n"
            f"3" f") Physical consistency (shadows, weather, sign language) with the claimed event ;\n"
            f"4) Debunk/confirmation from a reliable local source.\n"
            f"Decision: unverified = unshared. Speed is not worth reliability."
        )
    return {
        "instruction": instruction,
        "input": indice,
        "output": output,
        "task_type": "verification_information",
        "safety_label": "sans_objet",
        "moteurs_inverses": moteur,
    }


DOMAINES_SAVOIR = [
    SpecDomaine(
        id="redaction_documents",
        nom_fr="rédaction de documents",
        nom_en="document writing",
        description_fr=(
            "Plans, relectures et styles adaptés à l'audience — résumé d'abord, "
            "une idée par paragraphe, recommandations datées, coupes chiffrées."
        ),
        description_en=(
            "Outlines, reviews and audience-fitted styles — summary first, one "
            "idea per paragraph, dated recommendations, quantified cuts."
        ),
        mots_cles=["document", "rapport", "rediger", "courrier", "manuel"],
        taches=[
            ("plan_document", 0.55, rd_document, rd_document),
            ("relecture", 0.45, rd_relecture, rd_relecture),
        ],
    ),
    SpecDomaine(
        id="sciences_humaines",
        nom_fr="sciences humaines",
        nom_en="humanities",
        description_fr=(
            "Analyses disciplinées avec méthode, croisement de sources critiquées "
            "et limites annoncées — attesté / interprété / contesté distingués."
        ),
        description_en=(
            "Disciplined analyses with method, crossed critiqued sources and "
            "stated limitations — attested / interpreted / disputed separated."
        ),
        mots_cles=["histoire", "sociologie", "philosophie", "culture", "societe"],
        taches=[
            ("analyse_sh", 0.55, sh_analyse, sh_analyse),
            ("pedagogie_sh", 0.45, sh_pedagogie, sh_pedagogie),
        ],
    ),
    SpecDomaine(
        id="recherche_scientifique",
        nom_fr="recherche scientifique",
        nom_en="scientific research",
        description_fr=(
            "Protocoles falsifiables (hypothèse, répétitions, randomisation, "
            "taille d'effet) et vulgarisation non déformante — limites nommées."
        ),
        description_en=(
            "Falsifiable protocols (hypothesis, replicates, randomization, "
            "effect size) and non-distorting popularization — named limitations."
        ),
        mots_cles=["science", "recherche", "protocole", "hypothese", "experience"],
        taches=[
            ("protocole_recherche", 0.55, rs_protocole, rs_protocole),
            ("vulgarisation", 0.45, rs_vulgarisation, rs_vulgarisation),
        ],
    ),
    SpecDomaine(
        id="recherche_web",
        nom_fr="recherche web",
        nom_en="web search",
        description_fr=(
            "Stratégies de requêtes, traçabilité des sources, recherche active "
            "de contradiction et vérification d'informations virales."
        ),
        description_en=(
            "Query strategies, source traceability, active contradiction search "
            "and viral information verification."
        ),
        mots_cles=["recherche", "web", "source", "verifier", "internet"],
        taches=[
            ("strategie_recherche", 0.55, rw_requete, rw_requete),
            ("verification_information", 0.45, rw_verification, rw_verification),
        ],
    ),
]
