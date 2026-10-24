"""
DOMAINE BUSINESS & DONNÉES — multimodal, vente, santé/médical (information
générale non-diagnostique), analyse de données, conseiller commercial.

Sécurité : santé/médical = information générale, disclaimer systématique ;
vente/conseil = éthique explicite (pas de fausse urgence).
"""

from __future__ import annotations

import random

from .base import SpecDomaine, choisir
from .variations import Lex, joindre, nombre, pourcentage

# ─────────────────────────────────────────────────────────────────────────────
# 14. MULTIMODAL
# ─────────────────────────────────────────────────────────────────────────────

MM = Lex(
    croisement={
        "fr": ["une image + une question en langage naturel", "un audio + son transcript + une consigne",
               "un tableau de données + une photo de contexte", "une vidéo + une demande de résumé structuré",
               "une facture scannée + une table comptable", "des photos de chantier + un calendrier"],
        "en": ["an image + a natural-language question", "an audio + its transcript + an instruction",
               "a data table + a context photo", "a video + a structured summary request",
               "a scanned invoice + an accounting table", "site photos + a calendar"],
    },
    sortie={
        "fr": ["une réponse courte citant ses sources", "un tableau structuré avec scores de confiance",
               "un résumé borné au temps (00:12-00:18)", "une liste de vérifications cochables"],
        "en": ["a short answer citing its sources", "a structured table with confidence scores",
               "a time-bounded summary (00:12-00:18)", "a checkable verification list"],
    },
    metier={
        "fr": ["une boutique", "une clinique", "une ferme", "un atelier", "une école", "un restaurant"],
        "en": ["a shop", "a clinic", "a farm", "a workshop", "a school", "a restaurant"],
    },
    exigence={
        "fr": ["zéro invention", "traçabilité complète", "temps de réponse court", "fonctionne hors-ligne"],
        "en": ["zero invention", "full traceability", "short response time", "works offline"],
    },
)

MM_PIEGES = {
    "fr": [
        ("une modalité manque", "le système le DÉCLARE au lieu d'inventer — « l'audio est absent, je réponds sur l'image »"),
        ("deux sources se contredisent", "la contradiction est signalée explicitement, pas moyennée — l'utilisateur tranche"),
        ("l'OCR lit mal un champ", "score de confiance bas → champ marqué incertain + contrôle humain échantillonné"),
    ],
    "en": [
        ("a modality is missing", "the system DECLARES it instead of inventing — \"audio is absent, I answer from the image\""),
        ("two sources contradict", "the contradiction is flagged explicitly, not averaged — the user decides"),
        ("OCR misreads a field", "low confidence score → field marked uncertain + sampled human review"),
    ],
}


def mm_alignement(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = MM.tirer(rng, lang)
    piege, garde = choisir(rng, MM_PIEGES[lang])
    if lang == "fr":
        instruction = (
            f"Structure un exemple multimodal ({s['croisement']}) avec sortie : {s['sortie']} — "
            f"cas d'usage : {s['metier']}, exigence : {s['exigence']}."
        )
        output = (
            f"1) Références croisées : identifiants stables (media_in_1, media_in_2) cités dans la consigne ;\n"
            f"2) Alignement temporel : bornes de temps (00:12-00:18) attachées aux extraits cités ;\n"
            f"3) Sortie : {s['sortie']} — chaque affirmation traçable à sa modalité ;\n"
            f"4) Cas limite « {piege} » : {garde}.\n"
            f"Contrôle final : retirer une modalité et vérifier que le système le dit."
        )
    else:
        instruction = (
            f"Structure a multimodal example ({s['croisement']}) with output: {s['sortie']} — "
            f"use case: {s['metier']}, requirement: {s['exigence']}."
        )
        output = (
            f"1) Cross references: stable ids (media_in_1, media_in_2) cited in the instruction ;\n"
            f"2) Temporal alignment: time bounds (00:12-00:18) attached to quoted excerpts ;\n"
            f"3" f") Output: {s['sortie']} — every claim traceable to its modality ;\n"
            f"4) Edge case \"{piege}\": {garde}.\n"
            f"Final check: remove one modality and verify the system says so."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "alignement_multimodal",
        "safety_label": "sans_objet",
        "modalites": ["texte"] + [m for m in ("image", "audio", "video") if m in s["croisement"]],
    }


def mm_pipeline(rng: random.Random, lang: str, ctx: dict) -> dict:
    flux = choisir(rng, {
        "fr": ["photos de reçus → dépenses catégorisées", "factures scannées → échéances de paiement",
               "photos de récolte → estimation de volume", "tickets de pesée → rapports hebdomadaires"],
        "en": ["receipt photos → categorized expenses", "scanned invoices → payment due dates",
               "harvest photos → volume estimate", "weighing tickets → weekly reports"],
    }[lang])
    revue = nombre(rng, 3, 10)
    if lang == "fr":
        instruction = (
            f"Pipeline multimodal « {flux} » pour {MM.slots['metier'][lang]} — "
            f"concevoir les 5 étapes avec contrôles (exigence : {MM.slots['exigence'][lang]})."
        )
        output = (
            f"Pipeline ({flux}) :\n"
            f"1) Capture normalisée (redressement, éclairage vérifié) ;\n"
            f"2) Extraction texte/structure avec score de confiance PAR champ ;\n"
            f"3) Règles transparentes d'abord, modèle seulement pour les ambigus ;\n"
            f"4) Contrôle humain échantillonné ({revue} %) — corrections réinjectées dans les règles ;\n"
            f"5) Sortie : table datée, chaque ligne traçable au média source.\n"
            f"Règle d'honnêteté : un champ incertain est marqué incertain — jamais lissé."
        )
    else:
        instruction = (
            f"Multimodal pipeline \"{flux}\" for {MM.slots['metier'][lang]} — "
            f"design the 5 steps with controls (requirement: {MM.slots['exigence'][lang]})."
        )
        output = (
            f"Pipeline ({flux}):\n"
            f"1) Normalized capture (deskew, lighting check) ;\n"
            f"2) Text/structure extraction with PER-field confidence ;\n"
            f"3" f") Transparent rules first, model only for ambiguous ones ;\n"
            f"4) Sampled human review ({revue}%) — corrections fed back into rules ;\n"
            f"5" f") Output: dated table, every row traceable to its source media.\n"
            f"Honesty rule: an uncertain field is marked uncertain — never smoothed."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "pipeline_multimodal",
        "safety_label": "sans_objet",
        "pipeline": {"flux": flux, "revue_humaine_pct": revue},
    }


# ─────────────────────────────────────────────────────────────────────────────
# 15. VENTE
# ─────────────────────────────────────────────────────────────────────────────

VE = Lex(
    produit={
        "fr": ["un logiciel de gestion agricole", "un service de livraison froide",
               "une formation professionnelle certifiante", "un kit solaire domestique",
               "un abonnement de maintenance machine", "un service de comptabilité externalisée"],
        "en": ["a farm management software", "a cold-chain delivery service",
               "a certified professional training", "a home solar kit",
               "a machine maintenance subscription", "an outsourced bookkeeping service"],
    },
    objection={
        "fr": ["c'est trop cher", "j'ai déjà un fournisseur", "je dois en parler à mon associé",
               "pas le temps de changer maintenant", "la dernière fois ça n'a pas marché"],
        "en": ["it's too expensive", "I already have a supplier", "I need to talk to my partner",
               "no time to switch now", "last time it didn't work"],
    },
    segment={
        "fr": ["boutique de quartier", "coopérative agricole", "indépendant", "école privée", "petite clinique"],
        "en": ["neighborhood shop", "farm cooperative", "freelancer", "private school", "small clinic"],
    },
)


def ve_objection(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = VE.tirer(rng, lang)
    etape = choisir(rng, {
        "fr": ["un essai gratuit d'une semaine", "une démonstration sur ses propres chiffres", "un appel de référence client", "un plan de bascule en 30 jours"],
        "en": ["a one-week free trial", "a demo on their own numbers", "a reference-customer call", "a 30-day switch plan"],
    }[lang])
    if lang == "fr":
        instruction = f"Client ({s['segment']}) pour {s['produit']} : « {s['objection']} ». Réponds avec méthode."
        output = (
            f"Objection « {s['objection']} » — 4 temps :\n"
            f"1) ACCUEILLIR (\"c'est une remarque fréquente\") — jamais de contradiction frontale ;\n"
            f"2) EXPLORER — une question ouverte : budget, confiance ou urgence ? ;\n"
            f"3) RÉPONDRE au vrai sujet avec un fait chiffré (coût de non-décision, retour mesuré chez un pair du segment {s['segment']}) ;\n"
            f"4) VALIDER — proposer {etape}, engagement faible.\n"
            f"Éthique : pas de fausse urgence, pas de promesse non tenable — la confiance est l'actif durable."
        )
    else:
        instruction = f"Customer ({s['segment']}) for {s['produit']}: \"{s['objection']}\". Answer with a method."
        output = (
            f"Objection \"{s['objection']}\" — 4 moves:\n"
            f"1) WELCOME (\"that's a common remark\") — never blunt contradiction ;\n"
            f"2) EXPLORE — one open question: budget, trust or urgency? ;\n"
            f"3" f") ANSWER the real topic with a quantified fact (cost of inaction, measured return at a {s['segment']} peer) ;\n"
            f"4) VALIDATE — propose {etape}, low commitment.\n"
            f"Ethics: no fake urgency, no untenable promise — trust is the durable asset."
        )
    return {
        "instruction": instruction,
        "input": s["objection"],
        "output": output,
        "task_type": "traitement_objection",
        "safety_label": "sans_objet",
        "produit": s["produit"],
        "objection": s["objection"],
    }


def ve_pitch(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = VE.tirer(rng, lang)
    mots = choisir(rng, [60, 70, 80])
    benefice = pourcentage(rng, 10, 40)
    if lang == "fr":
        instruction = f"Pitch de 30 s pour {s['produit']} ciblé {s['segment']} — bénéfices mesurables."
        output = (
            f"1) Accroche : le problème vécu du {s['segment']} en une phrase concrète ;\n"
            f"2) Solution : UN bénéfice chiffré (~{benefice} de temps ou de pertes en moins) ;\n"
            f"3) Preuve : résultat client typique anonymisé ;\n"
            f"4) Engagement : question fermée facile (« voulez-vous le voir sur VOS chiffres en 10 min ? »).\n"
            f"Discipline : {mots} mots max, zéro superlatif non prouvé, un seul appel à l'action."
        )
    else:
        instruction = f"30s pitch for {s['produit']} targeting {s['segment']} — measurable benefits."
        output = (
            f"1) Hook: the {s['segment']}'s lived problem in one concrete sentence ;\n"
            f"2) Solution: ONE quantified benefit (~{benefice} less time or waste) ;\n"
            f"3) Proof: typical anonymized customer result ;\n"
            f"4) Engage: an easy closed question (\"want to see it on YOUR numbers in 10 min?\").\n"
            f"Discipline: {mots} words max, zero unproven superlatives, one call to action."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "pitch_vente",
        "safety_label": "sans_objet",
        "produit": s["produit"],
        "segment": s["segment"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# 16. SANTÉ / MÉDICAL (information générale)
# ─────────────────────────────────────────────────────────────────────────────

SM = Lex(
    sujet={
        "fr": ["l'hydratation en climat chaud", "la prévention du paludisme à domicile",
               "la lecture d'une ordonnance courante", "l'activité physique recommandée pour un adulte",
               "le sommeil et les écrans", "l'hygiène des mains en famille",
               "le stockage sûr des médicaments à la maison"],
        "en": ["hydration in hot climates", "household malaria prevention",
               "reading a common prescription", "recommended physical activity for an adult",
               "sleep and screens", "family hand hygiene",
               "safe medicine storage at home"],
    },
    audience={
        "fr": ["une famille avec jeunes enfants", "un travailleur en extérieur", "une personne âgée vivant seule",
               "un adolescent en période d'examen", "une patiente en suivi de grossesse",
               "un groupe de voyageurs"],
        "en": ["a family with young children", "an outdoor worker", "an older person living alone",
               "a teenager during exams", "a patient in pregnancy follow-up",
               "a group of travelers"],
    },
    saison={
        "fr": ["en saison des pluies", "en saison sèche et chaude", "en voyage",
               "à la rentrée scolaire", "en période de canicule", "après une inondation"],
        "en": ["in the rainy season", "in the hot dry season", "while traveling",
               "at back-to-school time", "during a heat wave", "after a flood"],
    },
    niveau_detail={
        "fr": ["en 3 points simples", "en expliquant les mots techniques", "en une checklist imprimable",
               "avec ce qu'il faut dire au soignant"],
        "en": ["in 3 simple points", "explaining the technical words", "as a printable checklist",
               "with what to tell the health worker"],
    },
)

DISCLAIMER = {
    "fr": (
        "Information générale à but éducatif — elle ne remplace pas un diagnostic "
        "ni un traitement par un professionnel de santé."
    ),
    "en": (
        "General educational information — it does not replace diagnosis or "
        "treatment by a healthcare professional."
    ),
}


def sm_information(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = SM.tirer(rng, lang)
    gestes = nombre(rng, 3, 4)
    if lang == "fr":
        instruction = (
            f"Explique, en information générale, {s['sujet']} — pour {s['audience']}, "
            f"{s['saison']}, {SM.slots['niveau_detail'][lang]}."
        )
        output = (
            f"Repères généraux — {s['sujet']} :\n"
            f"1) Ce que disent les recommandations publiques (OMS / autorités nationales), au niveau des principes ;\n"
            f"2) Signaux qui imposent de consulter rapidement — listés clairement, sans dramatiser ;\n"
            f"3) {gestes} gestes à portée immédiate, sans matériel coûteux ;\n"
            f"4) Erreur fréquente à éviter (automédication prolongée, arrêt prématuré d'un traitement prescrit).\n"
            f"⚠ {DISCLAIMER['fr']}"
        )
    else:
        instruction = (
            f"Explain, as general information, {s['sujet']} — for {s['audience']}, "
            f"{s['saison']}, {SM.slots['niveau_detail'][lang]}."
        )
        output = (
            f"General references — {s['sujet']}:\n"
            f"1) What public recommendations say (WHO / national authorities), at principle level ;\n"
            f"2) Signals requiring quick consultation — clearly listed, no dramatizing ;\n"
            f"3" f") {gestes} immediately doable habits, no costly equipment ;\n"
            f"4) A common mistake to avoid (prolonged self-medication, stopping prescribed treatment early).\n"
            f"⚠ {DISCLAIMER['en']}"
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "information_sante",
        "safety_label": "info_medicale_generale",
        "sujet": s["sujet"],
        "disclaimer": DISCLAIMER[lang],
    }


def sm_organisation(rng: random.Random, lang: str, ctx: dict) -> dict:
    s_aud = choisir(rng, SM.slots["audience"][lang])
    questions = nombre(rng, 2, 4)
    if lang == "fr":
        instruction = f"Aide-moi à préparer mes questions avant une consultation médicale — pour {s_aud}."
        output = (
            f"Préparation de consultation :\n"
            f"1) Symptômes : depuis quand, aggravé/soulagé par quoi, fréquence exacte (calendrier du téléphone) ;\n"
            f"2) Traitements en cours — plantes et compléments compris, ils comptent ;\n"
            f"3) {questions} questions maximum, classées par importance ;\n"
            f"4) Repartir avec : plan écrit, signe d'alerte imposant un retour, prochaine échéance.\n"
            f"⚠ {DISCLAIMER['fr']}"
        )
    else:
        instruction = f"Help me prepare my questions before a medical appointment — for {s_aud}."
        output = (
            f"Appointment preparation:\n"
            f"1) Symptoms: since when, worsened/relieved by what, exact frequency (phone calendar) ;\n"
            f"2) Current treatments — herbs and supplements included, they count ;\n"
            f"3" f") {questions} questions maximum, ranked by importance ;\n"
            f"4) Leave with: written plan, warning sign requiring a return, next milestone.\n"
            f"⚠ {DISCLAIMER['en']}"
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "preparation_consultation",
        "safety_label": "info_medicale_generale",
        "questions": questions,
        "disclaimer": DISCLAIMER[lang],
    }


# ─────────────────────────────────────────────────────────────────────────────
# 17. ANALYSE DE DONNÉES
# ─────────────────────────────────────────────────────────────────────────────

AD = Lex(
    jeu={
        "fr": ["ventes mensuelles multi-boutiques", "relevés de consommation électrique",
               "réponses d'une enquête clients", "logs de pannes d'un parc de machines",
               "suivi de stocks de l'entrepôt", "présences à la clinique mobile"],
        "en": ["multi-store monthly sales", "electricity consumption readings",
               "customer survey answers", "machine fleet incident logs",
               "warehouse stock tracking", "mobile clinic visits"],
    },
    metrique={
        "fr": ["moyenne et médiane par groupe", "évolution mensuelle", "taux de croissance",
               "répartition par catégorie", "saisonnalité"],
        "en": ["group mean and median", "monthly evolution", "growth rate",
               "category breakdown", "seasonality"],
    },
)


def ad_nettoyage(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = AD.tirer(rng, lang)
    lignes = choisir(rng, [500, 2000, 10000, 50000])
    manquantes = pourcentage(rng, 2, 25)
    if lang == "fr":
        instruction = f"Nettoyage d'un jeu « {s['jeu']} » (~{lignes} lignes, {manquantes} de valeurs manquantes)."
        output = (
            f"1) Inventaire : lignes/colonnes, types réels, doublons exacts et presque-doublons ;\n"
            f"2) Valeurs manquantes ({manquantes}) : compter PAR colonne, distinguer vide d'implicite, "
            f"décider (imputer médiane / rejeter en tracé) ;\n"
            f"3) Incohérences : unités mélangées, dates hors bornes, catégories mal orthographiées — "
            f"table de correspondance conservée ;\n"
            f"4) Journal : chaque transformation réversible et documentée — un nettoyage sans journal est perdu."
        )
    else:
        instruction = f"Cleaning a \"{s['jeu']}\" dataset (~{lignes} rows, {manquantes} missing values)."
        output = (
            f"1) Inventory: rows/columns, real types, exact and near duplicates ;\n"
            f"2) Missing values ({manquantes}): count PER column, separate empty from implicit, "
            f"decide (median impute / traced rejection) ;\n"
            f"3" f") Inconsistencies: mixed units, out-of-range dates, misspelled categories — kept mapping table ;\n"
            f"4) Journal: every transformation reversible and documented — a cleaning without a journal is lost."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "nettoyage_donnees",
        "safety_label": "sans_objet",
        "jeu": s["jeu"],
        "echelle": {"lignes": lignes, "manquantes": manquantes},
    }


def ad_analyse(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = AD.tirer(rng, lang)
    groupes = nombre(rng, 2, 4)
    if lang == "fr":
        instruction = f"Analyse « {s['jeu']} » : plan pour répondre à « {s['metrique']} »."
        output = (
            f"1) Question exacte : {s['metrique']} — sur quelle période, quel périmètre ? ;\n"
            f"2) Descriptifs d'abord : moyenne ET médiane, écart-type — la médiane protège des extrêmes ;\n"
            f"3) Segmentation : {groupes} groupes max au premier passage ;\n"
            f"4) Vigilance : corrélation ≠ cause, volumes comparables, incertitude annoncée ;\n"
            f"5) Restitution : un graphique par message, axe horodaté, source et période citées."
        )
    else:
        instruction = f"Analysis of \"{s['jeu']}\": plan to answer \"{s['metrique']}\"."
        output = (
            f"1) Sharp question: {s['metrique']} — over which period, which scope? ;\n"
            f"2) Descriptives first: mean AND median, standard deviation — median protects from outliers ;\n"
            f"3) Segmentation: {groupes} groups max on the first pass ;\n"
            f"4) Caution: correlation ≠ cause, comparable volumes, stated uncertainty ;\n"
            f"5) Delivery: one chart per message, dated axis, source and period cited."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "plan_analyse",
        "safety_label": "sans_objet",
        "jeu": s["jeu"],
        "metrique": s["metrique"],
    }


AD_DEST = {
    "fr": ["un compte-rendu mensuel", "une décision rapide en réunion", "un affichage en atelier", "un rapport externe"],
    "en": ["a monthly report", "a fast in-meeting decision", "a workshop wall display", "an external report"],
}


def ad_visualisation(rng: random.Random, lang: str, ctx: dict) -> dict:
    dest = choisir(rng, AD_DEST[lang])
    but, recette = choisir(rng, {
        "fr": [
            ("montrer une tendance dans le temps", "courbe simple, 3 séries max, axe du temps régulier"),
            ("comparer des catégories", "barres horizontales triées, jamais de camembert à 12 parts"),
            ("montrer une distribution", "histogramme ou boîte à moustaches, classes expliquées"),
            ("relier deux quantités", "nuage de points, droite de tendance, attention aux extrêmes"),
        ],
        "en": [
            ("show a trend over time", "simple line, 3 series max, regular time axis"),
            ("compare categories", "sorted horizontal bars, never a 12-slice pie"),
            ("show a distribution", "histogram or box plot, explained bins"),
            ("relate two quantities", "scatter plot, trend line, outlier care"),
        ],
    }[lang])
    if lang == "fr":
        instruction = f"Quel graphique pour {but}, destiné à {dest} ?"
        output = (
            f"Recommandation : {recette}.\n"
            f"Qualités : titre = message, unités visibles, source et période citées, zéro 3D, "
            f"un encodeur visuel par variable. Une légende de 8 entrées = deux graphiques."
        )
    else:
        instruction = f"Which chart to {but}, for {dest}?"
        output = (
            f"Recommendation: {recette}.\n"
            f"Qualities: title = the message, visible units, source and period cited, zero 3D, "
            f"one visual encoder per variable. An 8-entry legend means two charts."
        )
    return {
        "instruction": instruction,
        "input": but,
        "output": output,
        "task_type": "visualisation_donnees",
        "safety_label": "sans_objet",
        "but": but,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 18. CONSEILLER COMMERCIAL
# ─────────────────────────────────────────────────────────────────────────────

CC = Lex(
    profil={
        "fr": ["une petite boutique qui veut vendre en ligne", "une coopérative agricole aux stocks irréguliers",
               "un indépendant qui facture trop tard", "une école privée en croissance",
               "un atelier de couture qui reçoit trop de commandes"],
        "en": ["a small shop that wants to sell online", "a farm cooperative with irregular stock",
               "a freelancer who invoices too late", "a growing private school",
               "a sewing workshop drowning in orders"],
    },
    priorite={
        "fr": ["encaisser plus vite", "perdre moins de stock", "répondre aux clients plus vite",
               "planifier les achats", "simplifier la comptabilité"],
        "en": ["getting paid faster", "losing less stock", "answering clients faster",
               "planning purchases", "simplifying bookkeeping"],
    },
    canal={
        "fr": ["par WhatsApp", "au téléphone", "en visite sur place", "par email", "lors d'un salon"],
        "en": ["over WhatsApp", "on the phone", "on site", "by email", "at a trade fair"],
    },
    contrainte={
        "fr": ["budget limité", "peu de temps disponible", "équipe réduite",
               "outils actuels à conserver"],
        "en": ["limited budget", "little time available", "a small team",
               "current tools to keep"],
    },
)


def cc_recommandation(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = CC.tirer(rng, lang)
    horizon = nombre(rng, 14, 60, 7)
    if lang == "fr":
        instruction = (
            f"Client : {s['profil']}, priorité exprimée : {s['priorite']} "
            f"(échange {s['canal']}, contrainte : {s['contrainte']}). "
            f"Recommandation prioritaire et pourquoi ?"
        )
        output = (
            f"1) Besoin racine : {s['priorite']} — combien ça coûte aujourd'hui (temps, argent, confiance) ? ;\n"
            f"2) Solution minimale viable : l'option la plus simple qui règle ÇA, pas la plus complète du catalogue ;\n"
            f"3) Plan {horizon} jours : quoi, qui, quand — un indicateur observé avant/après ;\n"
            f"4) Honnêteté : dire explicitement ce dont le client n'a PAS besoin maintenant — c'est ce qui fait revenir."
        )
    else:
        instruction = (
            f"Client: {s['profil']}, stated priority: {s['priorite']} "
            f"(contact {s['canal']}, constraint: {s['contrainte']}). "
            f"Priority recommendation and why?"
        )
        output = (
            f"1) Root need: {s['priorite']} — what does it cost today (time, money, trust)? ;\n"
            f"2) Minimum viable solution: the simplest option fixing THAT, not the catalog's fullest ;\n"
            f"3" f") {horizon}-day plan: what, who, when — one before/after observable indicator ;\n"
            f"4) Honesty: explicitly say what the client does NOT need now — that's what brings them back."
        )
    return {
        "instruction": instruction,
        "input": s["profil"],
        "output": output,
        "task_type": "recommandation_conseil",
        "safety_label": "sans_objet",
        "profil": s["profil"],
        "horizon_jours": horizon,
    }


def cc_suivi(rng: random.Random, lang: str, ctx: dict) -> dict:
    cadence = nombre(rng, 7, 30, 7)
    if lang == "fr":
        instruction = (
            f"Suivi commercial respectueux (cadence {cadence} jours, {CC.slots['canal'][lang]}, "
            f"contrainte client : {CC.slots['contrainte'][lang]})."
        )
        output = (
            f"1) Chaque contact apporte UNE valeur ajoutée (info utile, référence, mise à jour pertinente) — "
            f"jamais de « je revenais aux nouvelles » à vide ;\n"
            f"2) Rythme convenu ENSEMBLE ({cadence} jours ici) et noté dans le dossier ;\n"
            f"3) Sortie propre : trois contacts sans réponse → porte ouverte datée (\"je reviens au prochain cycle\") "
            f"et passage au suivant.\n"
            f"Respecter le temps du client est un argument de vente en soi."
        )
    else:
        instruction = (
            f"Respectful sales follow-up ({cadence}-day cadence, {CC.slots['canal'][lang]}, "
            f"client constraint: {CC.slots['contrainte'][lang]})."
        )
        output = (
            f"1) Every touch brings ONE added value (useful info, reference, relevant update) — "
            f"never an empty \"just checking in\" ;\n"
            f"2) Cadence agreed TOGETHER ({cadence} days here) and noted in the record ;\n"
            f"3" f") Clean exit: three unanswered touches → dated open door (\"back next cycle\") and move on.\n"
            f"Respecting the client's time is a sales argument in itself."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "suivi_client",
        "safety_label": "sans_objet",
        "cadence_jours": cadence,
    }


DOMAINES_BUSINESS = [
    SpecDomaine(
        id="multimodal",
        nom_fr="multimodal",
        nom_en="multimodal",
        description_fr=(
            "Alignement croisé image/audio/vidéo/texte (références stables, bornes "
            "temporelles) et pipelines réels — modalité manquante déclarée, "
            "jamais inventée."
        ),
        description_en=(
            "Cross-modal image/audio/video/text alignment (stable refs, time "
            "bounds) and real pipelines — missing modality declared, never "
            "invented."
        ),
        mots_cles=["multimodal", "image texte", "ocr", "alignement", "modalite"],
        taches=[
            ("alignement_multimodal", 0.50, mm_alignement, mm_alignement),
            ("pipeline_multimodal", 0.50, mm_pipeline, mm_pipeline),
        ],
    ),
    SpecDomaine(
        id="vente",
        nom_fr="vente",
        nom_en="sales",
        description_fr=(
            "Objections en 4 temps (accueillir/explorer/répondre/valider) et "
            "pitches à bénéfice chiffré — éthique : pas de fausse urgence."
        ),
        description_en=(
            "Objections in 4 moves (welcome/explore/answer/validate) and "
            "quantified-benefit pitches — ethics: no fake urgency."
        ),
        mots_cles=["vente", "client", "objection", "pitch", "prospect"],
        taches=[
            ("traitement_objection", 0.55, ve_objection, ve_objection),
            ("pitch_vente", 0.45, ve_pitch, ve_pitch),
        ],
    ),
    SpecDomaine(
        id="sante_medical",
        nom_fr="santé / médical",
        nom_en="health / medical",
        description_fr=(
            "Information de santé générale (recommandations publiques, signaux "
            "d'alerte, gestes accessibles) — disclaimer systématique de "
            "non-substitution au professionnel."
        ),
        description_en=(
            "General health information (public recommendations, warning signs, "
            "accessible habits) — systematic disclaimer about professional care."
        ),
        mots_cles=["sante", "medical", "symptome", "traitement", "consultation"],
        safety_label="info_medicale_generale",
        taches=[
            ("information_sante", 0.55, sm_information, sm_information),
            ("preparation_consultation", 0.45, sm_organisation, sm_organisation),
        ],
    ),
    SpecDomaine(
        id="analyse_donnees",
        nom_fr="analyse de données",
        nom_en="data analysis",
        description_fr=(
            "Nettoyage journalisé, plans d'analyse (médiane avant moyenne, "
            "corrélation ≠ cause) et visualisation honnête — un graphique = un "
            "message + unités + source."
        ),
        description_en=(
            "Journaled cleaning, analysis plans (median before mean, correlation "
            "≠ cause) and honest visualization — one chart = one message + units "
            "+ source."
        ),
        mots_cles=["donnees", "analyse", "graphique", "statistique", "csv"],
        taches=[
            ("nettoyage_donnees", 0.35, ad_nettoyage, ad_nettoyage),
            ("plan_analyse", 0.35, ad_analyse, ad_analyse),
            ("visualisation_donnees", 0.30, ad_visualisation, ad_visualisation),
        ],
    ),
    SpecDomaine(
        id="conseiller_commercial",
        nom_fr="conseiller commercial",
        nom_en="commercial advisor",
        description_fr=(
            "Recommandations priorisées (besoin racine → solution minimale → "
            "plan daté) et suivi respectueux avec valeur ajoutée par contact."
        ),
        description_en=(
            "Prioritized recommendations (root need → minimal solution → dated "
            "plan) and respectful follow-up with added value per touch."
        ),
        mots_cles=["conseil", "commercial", "recommandation", "suivi", "client"],
        taches=[
            ("recommandation_conseil", 0.55, cc_recommandation, cc_recommandation),
            ("suivi_client", 0.45, cc_suivi, cc_suivi),
        ],
    ),
]
