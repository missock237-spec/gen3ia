#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum v4 — Catégories 3-4 : métiers professionnels et sciences (95 000).

  professions 75 000 — 15 verticales × 5 000 (marketing, e-commerce, service client,
                       finance, comptabilité, droit, éducation, RH, immobilier,
                       agriculture, logistique, journalisme, tourisme,
                       gestion de projets, entrepreneuriat)
  sciences    20 000 — banque de faits EXACTS (physique, chimie, biologie, astronomie,
                       géographie, environnement, électronique, robotique) × questions
"""

from __future__ import annotations

import random

from cv4_pools import (CITIES_EN, MONTANTS, MONTHS_EN, MOIS_FR, NAMES_EN, NOMS_FR,
                       OBJETS_FR, OBJECTS_EN, POURCENTAGES, PRODUITS_EN, PRODUITS_FR,
                       VILLES_FR)

def _c(rng, fr):  # client/personne + ville + montant, cohérents langue
    nom = rng.choice(NOMS_FR if fr else NAMES_EN)
    ville = rng.choice(VILLES_FR if fr else CITIES_EN)
    montant = rng.choice(MONTANTS)
    return nom, ville, montant

# ═══════════════════ professions (75 000) — 15 verticales ═══════════════════

def prof_marketing(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom, ville, budget = _c(rng, fr)
    produit = rng.choice(PRODUITS_FR if fr else PRODUITS_EN)
    p = rng.choice(POURCENTAGES)
    clics = rng.randint(200, 4000)
    conv = max(1, clics * p // 100)
    if fr:
        out = (f"Plan de campagne (budget {budget:,} francs) :\n"
               f"1. Cible : acheteurs de {produit} à {ville} ;\n2. Message : bénéfice unique + preuve sociale ;\n"
               f"3. Canaux : réseaux sociaux + recherche locale ;\n4. Mesure : {clics:,} clics visés → {conv:,} conversions "
               f"({p} %), CPA ≈ {round(budget / conv)} francs.\nDécision : si CPA > valeur client, réduire la cible.")
    else:
        out = (f"Campaign plan (budget {budget:,} francs):\n"
               f"1. Target: {produit} buyers in {ville};\n2. Message: single benefit + social proof;\n"
               f"3. Channels: social + local search;\n4. Measure: {clics:,} clicks → {conv:,} conversions "
               f"({p}%), CPA ≈ {round(budget / conv)} francs.\nDecision: if CPA > customer value, narrow the target.")
    return {"task_type": "campaign_plan", "language": "fr" if fr else "en",
            "instruction": "Construis un plan de campagne chiffré avec CPA et critère d'arrêt." if fr
            else "Build a quantified campaign plan with CPA and a stop criterion.",
            "input": f"Promouvoir le {produit} à {ville}, budget {budget:,} francs, taux de conversion attendu {p} %."
            if fr else f"Promote the {produit} in {ville}, budget {budget:,} francs, expected conversion {p}%.",
            "output": out, "difficulty": "intermédiaire"}

def prof_ecommerce(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    produit = rng.choice(PRODUITS_FR if fr else PRODUITS_EN)
    cout, vente = rng.choice(MONTANTS), 0
    vente = cout + rng.choice([200, 500, 1000, 2000])
    marge = round((vente - cout) / vente * 100, 1)
    if fr:
        out = (f"Fiche produit : titre clair ({produit}), 3 bénéfices concrets, taille/poids, garantie.\n"
               f"Économie : coût {cout:,} → prix {vente:,} francs, marge {marge} %.\n"
               f"Seuil de rentabilité : couvrir le CPA avant toute remise — jamais de remise qui passe la marge sous 15 %.")
    else:
        out = (f"Product sheet: clear title ({produit}), 3 concrete benefits, size/weight, warranty.\n"
               f"Economics: cost {cout:,} → price {vente:,} francs, margin {marge}%.\n"
               f"Break-even: cover CPA before any discount — never discount below a 15% margin.")
    return {"task_type": "product_sheet", "language": "fr" if fr else "en",
            "instruction": "Rédige la fiche produit et l'économie de l'offre (marge, seuil)." if fr
            else "Write the product sheet and the offer economics (margin, threshold).",
            "input": f"Produit : {produit} — coût {cout:,} francs, prix visé {vente:,} francs."
            if fr else f"Product: {produit} — cost {cout:,} francs, target price {vente:,} francs.",
            "output": out, "difficulty": "facile"}

def prof_service_client(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom, ville, montant = _c(rng, fr)
    produit = rng.choice(PRODUITS_FR if fr else PRODUITS_EN)
    if fr:
        out = (f"Réponse structurée : 1) accuser le désagrément sans excuser ; 2) reformuler le fait "
               f"({produit}, {montant:,} francs) ; 3) donner l'action concrète et son délai ; "
               f"4) offrir une escalade si le délai saute. Ton courtois, zéro jargon, aucune promesse non tenable.")
    else:
        out = (f"Structured reply: 1) acknowledge the inconvenience without excuses; 2) restate the fact "
               f"({produit}, {montant:,} francs); 3) give the concrete action and its deadline; "
               f"4) offer escalation if the deadline slips. Courteous tone, zero jargon, no unkeepable promises.")
    return {"task_type": "support_reply", "language": "fr" if fr else "en",
            "instruction": "Réponds à la réclamation en 4 étapes, avec action datée et escalade." if fr
            else "Reply to the complaint in 4 steps, with a dated action and escalation.",
            "input": f"Réclamation de {nom} : {produit} payé {montant:,} francs, problème non résolu depuis 8 jours."
            if fr else f"Complaint from {nom}: {produit} paid {montant:,} francs, unresolved for 8 days.",
            "output": out, "difficulty": "intermédiaire"}

def prof_finance(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    capital = rng.choice([100_000, 250_000, 500_000, 1_000_000])
    taux = rng.choice([3, 4, 5, 6, 8])
    interet = capital * taux // 100
    if fr:
        out = (f"Calcul : {capital:,} francs placés à {taux} % simple → {interet:,} francs par an.\n"
               f"Limites honnêtes : calcul simplifié (hors fiscalité/inflation) ; toute décision financière "
               f"personnelle doit être validée par un conseiller agréé — gen3 assiste, ne prescrit pas.")
    else:
        out = (f"Computation: {capital:,} francs at {taux}% simple → {interet:,} francs per year.\n"
               f"Honest limits: simplified computation (no tax/inflation); any personal financial decision "
               f"must be validated by a licensed advisor — gen3 assists, does not prescribe.")
    return {"task_type": "finance_calc", "language": "fr" if fr else "en",
            "instruction": "Calcule l'intérêt simple et rappelle les limites du conseil financier automatisé." if fr
            else "Compute simple interest and restate automated financial advice limits.",
            "input": f"Capital {capital:,} francs, taux {taux} % par an." if fr else f"Capital {capital:,} francs, {taux}% yearly rate.",
            "output": out, "difficulty": "facile", "safety_label": "information-only"}

def prof_comptabilite(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    ventes = rng.choice([500_000, 800_000, 1_200_000])
    achats = ventes * rng.choice([40, 55, 65]) // 100
    resultat = ventes - achats
    if fr:
        out = (f"Classement : ventes {ventes:,} (produit), achats {achats:,} (charge) → résultat brut {resultat:,} francs.\n"
               f"Étapes suivantes : provisions, amortissements, puis validation par un comptable agréé — "
               f"gen3 prépare, ne certifie pas.")
    else:
        out = (f"Classification: sales {ventes:,} (revenue), purchases {achats:,} (expense) → gross result {resultat:,} francs.\n"
               f"Next steps: provisions, depreciation, then review by a certified accountant — "
               f"gen3 prepares, does not certify.")
    return {"task_type": "accounting_sort", "language": "fr" if fr else "en",
            "instruction": "Classe les opérations et calcule le résultat brut ; rappelle qui certifie." if fr
            else "Sort the operations, compute the gross result; state who certifies.",
            "input": f"Ventes {ventes:,} francs ; achats {achats:,} francs." if fr else f"Sales {ventes:,} francs; purchases {achats:,} francs.",
            "output": out, "difficulty": "facile"}

def prof_droit(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet = rng.choice(["bail d'habitation", "contrat de travail", "vente de bien", "prêt entre particuliers"]) if fr else \
            rng.choice(["residential lease", "employment contract", "property sale", "private loan"])
    if fr:
        out = (f"Assistance documentaire : résumer les clauses clés d'un {sujet} (parties, durée, prix/loyer, "
               f"résiliation, litiges), signaler les clauses inhabituelles, et renvoyer systématiquement à un "
               f"avocat/barreau local pour l'interprétation engageante — gen3 ne fournit PAS de conseil juridique.")
    else:
        out = (f"Document assistance: summarize the key clauses of a {sujet} (parties, term, price/rent, "
               f"termination, disputes), flag unusual clauses, and always refer to a local lawyer/bar for "
               f"binding interpretation — gen3 does NOT provide legal advice.")
    return {"task_type": "legal_assist", "language": "fr" if fr else "en",
            "instruction": "Aide documentaire sur le contrat SANS conseil juridique ; renvoi obligatoire." if fr
            else "Document help on the contract WITHOUT legal advice; mandatory referral.",
            "input": f"Document : {sujet} à résumer avant signature." if fr else f"Document: {sujet} to review before signing.",
            "output": out, "difficulty": "intermédiaire", "safety_label": "information-only"}

def prof_education(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    niveau = rng.choice(["6e", "3e", "terminale"]) if fr else rng.choice(["grade 6", "grade 9", "grade 12"])
    sujet = rng.choice(["les fractions", "le théorème de Pythagore", "la photosynthèse", "les temps du passé"]) if fr else \
            rng.choice(["fractions", "Pythagorean theorem", "photosynthesis", "past tenses"])
    n = rng.randint(3, 6)
    if fr:
        out = (f"Séance ({n} étapes) pour {niveau} sur {sujet} : accroche concrète, démonstration pas-à-pas, "
               f"{max(2, n - 2)} exercices progressifs, correction commentée, mini-quiz de sortie. "
               f"Adapter au rythme : si erreur fréquente, reprendre le prérequis exact.")
    else:
        out = (f"Lesson ({n} steps) for {niveau} on {sujet}: concrete hook, step-by-step demonstration, "
               f"{max(2, n - 2)} graded exercises, commented correction, exit mini-quiz. "
               f"Adapt to pace: on frequent error, revisit the exact prerequisite.")
    return {"task_type": "lesson_plan", "language": "fr" if fr else "en",
            "instruction": "Construis la séance adaptée au niveau avec exercices progressifs." if fr
            else "Build the level-appropriate lesson with graded exercises.",
            "input": f"Niveau {niveau}, sujet : {sujet}, {n} étapes." if fr else f"Level {niveau}, topic: {sujet}, {n} steps.",
            "output": out, "difficulty": "facile"}

def prof_rh(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    poste = rng.choice(["développeur", "commercial", "gestionnaire de stock", "community manager"]) if fr else \
            rng.choice(["developer", "sales rep", "stock manager", "community manager"])
    if fr:
        out = (f"Offre d'emploi : titre exact ({poste}), missions en 4 puces, compétences requises vs souhaitées "
               f"séparées, fourchette de rémunération si politique interne l'autorise, process en 3 étapes datées. "
               f"Zéro critère discriminant (âge, genre, origine) — vérifier la conformité avant publication.")
    else:
        out = (f"Job ad: exact title ({poste}), 4-bullet missions, required vs nice-to-have skills separated, "
               f"salary range if internal policy allows, 3-step dated process. "
               f"Zero discriminatory criteria (age, gender, origin) — check compliance before publishing.")
    return {"task_type": "job_ad", "language": "fr" if fr else "en",
            "instruction": "Rédige l'offre conforme et non discriminante." if fr else "Write the compliant, non-discriminatory job ad.",
            "input": f"Poste : {poste}." if fr else f"Role: {poste}.",
            "output": out, "difficulty": "facile"}

def prof_immobilier(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom, ville, budget = _c(rng, fr)
    pieces = rng.choice([2, 3, 4, 5])
    if fr:
        out = (f"Annonce : {pieces} pièces à {ville}, points forts mesurables (surface, exposition, proximités "
               f"vérifiées), photos honnêtes sans grand-angle trompeur, loyer/prix cohérents avec le marché local. "
               f"Cadrage budget : {budget:,} francs — lister 3 compromis possibles (surface vs quartier vs étage).")
    else:
        out = (f"Listing: {pieces}-room place in {ville}, measurable highlights (area, exposure, verified nearby "
               f"amenities), honest photos without misleading wide-angle, rent/price consistent with the local market. "
               f"Budget framing: {budget:,} francs — list 3 possible trade-offs (size vs area vs floor).")
    return {"task_type": "real_estate_ad", "language": "fr" if fr else "en",
            "instruction": "Rédige l'annonce honnête et 3 compromis budgétaires." if fr
            else "Write the honest listing and 3 budget trade-offs.",
            "input": f"{pieces} pièces à {ville}, budget {budget:,} francs." if fr else f"{pieces}-room in {ville}, {budget:,} francs budget.",
            "output": out, "difficulty": "facile"}

def prof_agriculture(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    culture = rng.choice(["maïs", "manioc", "tomate", "arachide"]) if fr else \
             rng.choice(["maize", "cassava", "tomato", "groundnut"])
    hectares = rng.choice([0.5, 1, 2, 5])
    if fr:
        out = (f"Plan de culture ({hectares} ha de {culture}) : calendrier semis/récolte par saison des pluies, "
               f"espacement et densité indicatifs, rotation recommandée, signaux de maladies à surveiller. "
               f"Renvoi : les doses d'intrants exactes dépendent du sol — analyse de sol locale obligatoire.")
    else:
        out = (f"Crop plan ({hectares} ha of {culture}): rainy-season sowing/harvest calendar, indicative spacing "
               f"and density, recommended rotation, disease signals to watch. Referral: exact input doses depend "
               f"on the soil — local soil analysis required.")
    return {"task_type": "crop_plan", "language": "fr" if fr else "en",
            "instruction": "Propose un plan de culture prudent, renvoyant à l'analyse de sol locale." if fr
            else "Propose a cautious crop plan, referring to local soil analysis.",
            "input": f"{culture}, {hectares} ha." if fr else f"{culture}, {hectares} ha.",
            "output": out, "difficulty": "intermédiaire"}

def prof_logistique(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    ville_a, ville_b = rng.sample(VILLES_FR if fr else CITIES_EN, k=2)
    colis = rng.randint(20, 400)
    tournée = max(1, colis // 50)
    if fr:
        out = (f"Tournées : {colis} colis {ville_a} → {ville_b} regroupés en {tournée} tournée(s) (≈ 50 colis/tournée).\n"
               f"Optimisation : regrouper par zone de livraison, fenêtres horaires confirmées la veille, "
               f"preuve de livraison numérique. Alerte : si un colis dépasse le délai promis, prévenir AVANT l'échéance.")
    else:
        out = (f"Routes: {colis} parcels {ville_a} → {ville_b} grouped into {tournée} run(s) (≈ 50 parcels/run).\n"
               f"Optimization: group by delivery zone, confirm time windows the day before, digital proof of delivery. "
               f"Alert: if a parcel will miss the promised deadline, warn BEFORE the deadline.")
    return {"task_type": "logistics_plan", "language": "fr" if fr else "en",
            "instruction": "Calcule les tournées et l'organisation de preuve de livraison." if fr
            else "Compute the runs and the proof-of-delivery organization.",
            "input": f"{colis} colis de {ville_a} vers {ville_b}." if fr else f"{colis} parcels from {ville_a} to {ville_b}.",
            "output": out, "difficulty": "intermédiaire"}

def prof_journalisme(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet = rng.choice(["l'ouverture d'un marché", "un projet solaire", "une grève des transports", "un festival culturel"]) if fr else \
            rng.choice(["a market opening", "a solar project", "a transport strike", "a culture festival"])
    if fr:
        out = (f"Factualité : 5W (qui, quoi, où, quand, pourquoi) vérifiées auprès de 2 sources indépendantes ; "
               f"citations attribuées exactement ; distinction claire fait/opinion ; "
               f"droit de réponse signalé. Rien ne se publie sur une source unique non corroborée.")
    else:
        out = (f"Factual reporting: 5W (who, what, where, when, why) verified with 2 independent sources; "
               f"quotes attributed exactly; clear fact/opinion separation; "
               f"right of reply flagged. Nothing publishes on a single uncorroborated source.")
    return {"task_type": "journalistic_check", "language": "fr" if fr else "en",
            "instruction": "Applique la méthode de vérification 5W + double source." if fr
            else "Apply the 5W + double-source verification method.",
            "input": f"Sujet d'article : {sujet}." if fr else f"Article topic: {sujet}.",
            "output": out, "difficulty": "intermédiaire"}

def prof_tourisme(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom, ville, budget = _c(rng, fr)
    jours = rng.choice([3, 5, 7])
    if fr:
        out = (f"Itinéraire {jours} jours à {ville} (budget {budget:,} francs) : J1 centre et marché, "
               f"J2 site culturel + repos, puis alternance nature/culture ; coûts estimés par poste "
               f"(hébergement, repas, transport) avec 10 % d'imprévus. Conseils : horaires vérifiés, "
               f"respect des coutumes locales, aucune promesse de tarif non confirmé.")
    else:
        out = (f"{jours}-day itinerary in {ville} (budget {budget:,} francs): D1 center and market, "
               f"D2 cultural site + rest, then nature/culture alternation; estimated costs per line "
               f"(lodging, meals, transport) with 10% contingency. Tips: verified hours, respect local customs, "
               f"no promises of unconfirmed rates.")
    return {"task_type": "itinerary", "language": "fr" if fr else "en",
            "instruction": "Construis l'itinéraire chiffré avec imprévus et respect local." if fr
            else "Build the quantified itinerary with contingency and local respect.",
            "input": f"{jours} jours à {ville}, budget {budget:,} francs." if fr else f"{jours} days in {ville}, {budget:,} francs budget.",
            "output": out, "difficulty": "intermédiaire"}

def prof_projets(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    projet = rng.choice(["refonte du site", "ouverture d'une boutique", "migration du stockage", "lancement d'une app"]) if fr else \
             rng.choice(["website revamp", "store opening", "storage migration", "app launch"])
    semaines = rng.choice([6, 8, 12])
    if fr:
        out = (f"Plan {semaines} semaines : périmètre figé en semaine 1, jalons tous les {semaines // 3} semaines "
               f"(démo, tests, mise en production), risques principaux + plan B, budget réparti par jalon. "
               f"Règle : aucun jalon sans critère de sortie vérifiable.")
    else:
        out = (f"{semaines}-week plan: scope frozen in week 1, milestones every {semaines // 3} weeks "
               f"(demo, testing, go-live), main risks + plan B, budget spread per milestone. "
               f"Rule: no milestone without a verifiable exit criterion.")
    return {"task_type": "project_plan", "language": "fr" if fr else "en",
            "instruction": "Découpe le projet en jalons datés avec critères de sortie." if fr
            else "Break the project into dated milestones with exit criteria.",
            "input": f"Projet : {projet}, {semaines} semaines." if fr else f"Project: {projet}, {semaines} weeks.",
            "output": out, "difficulty": "intermédiaire"}

def prof_entrepreneuriat(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom, ville, capital = _c(rng, fr)
    if fr:
        out = (f"Étude de marché express : 1) 10 entretiens clients cibles à {ville} ; 2) concurrence directe/indirecte "
               f"listée avec prix ; 3) unité d'économie (coût, prix, marge, volume d'équilibre) ; "
               f"4) capital {capital:,} francs réparti (produit 40 %, acquisition 30 %, réserve 30 %). "
               f"Honnêteté : une idée sans unité d'économie positive n'est pas une entreprise, c'est un pari.")
    else:
        out = (f"Quick market study: 1) 10 target-customer interviews in {ville}; 2) direct/indirect competition "
               f"listed with prices; 3) unit economics (cost, price, margin, break-even volume); "
               f"4) capital {capital:,} francs split (product 40%, acquisition 30%, reserve 30%). "
               f"Honesty: an idea without positive unit economics is not a business, it is a bet.")
    return {"task_type": "market_study", "language": "fr" if fr else "en",
            "instruction": "Structure l'étude de marché et l'unité d'économie, sans complaisance." if fr
            else "Structure the market study and unit economics, no wishful thinking.",
            "input": f"Projet de {nom} à {ville}, capital {capital:,} francs." if fr else f"{nom}'s venture in {ville}, {capital:,} francs capital.",
            "output": out, "difficulty": "avancé"}

FABRIQUES_PROFESSIONS = [prof_marketing, prof_ecommerce, prof_service_client, prof_finance,
                         prof_comptabilite, prof_droit, prof_education, prof_rh,
                         prof_immobilier, prof_agriculture, prof_logistique, prof_journalisme,
                         prof_tourisme, prof_projets, prof_entrepreneuriat]

# ═══════════════════ sciences (20 000) — faits EXACTS ═══════════════════

FAITS = [
    # (sujet_fr, sujet_en, fait_fr, fait_en, faux_fr, faux_en)
    ("la vitesse de la lumière", "the speed of light",
     "environ 300 000 km par seconde dans le vide", "about 300,000 km per second in vacuum",
     "environ 300 000 km par heure", "about 300,000 km per hour"),
    ("l'ébullition de l'eau au niveau de la mer", "water boiling at sea level",
     "à environ 100 °C", "at about 100 °C",
     "à environ 50 °C", "at about 50 °C"),
    ("la gravité terrestre", "Earth's gravity",
     "d'environ 9,8 m/s² au niveau de la mer", "about 9.8 m/s² at sea level",
     "d'environ 98 m/s²", "about 98 m/s²"),
    ("la formule de l'eau", "the formula of water",
     "H₂O : deux atomes d'hydrogène pour un atome d'oxygène", "H₂O: two hydrogen atoms for one oxygen atom",
     "HO₂", "HO₂"),
    ("le sel de table", "table salt",
     "chlorure de sodium (NaCl)", "sodium chloride (NaCl)",
     "chlorure de potassium", "potassium chloride"),
    ("la rouille du fer", "iron rust",
     "une réaction du fer avec l'oxygène et l'eau", "a reaction of iron with oxygen and water",
     "une réaction avec l'azote seul", "a reaction with nitrogen alone"),
    ("l'électricité statique", "static electricity",
     "une accumulation de charges électriques à la surface d'un objet", "an accumulation of electric charges on an object's surface",
     "un courant permanent dans un circuit", "a permanent current in a circuit"),
    ("la fonte de la glace", "ice melting",
     "un changement d'état solide → liquide à 0 °C (pression normale)", "a solid → liquid state change at 0 °C (normal pressure)",
     "une réaction chimique qui libère de la chaleur", "a chemical reaction releasing heat"),
    ("la dissolution du sucre dans l'eau", "sugar dissolving in water",
     "une séparation des molécules dans l'eau — un changement physique", "molecules spreading in water — a physical change",
     "une réaction chimique qui crée un nouveau composé", "a chemical reaction creating a new compound"),
    ("les insectes", "insects",
     "six pattes et trois segments de corps (tête, thorax, abdomen)", "six legs and three body segments (head, thorax, abdomen)",
     "huit pattes comme les araignées", "eight legs like spiders"),
    ("le sang humain", "human blood",
     "des globules rouges, globules blancs, plaquettes et plasma", "red cells, white cells, platelets and plasma",
     "uniquement de l'eau et du fer", "only water and iron"),
    ("la lune et les marées", "the moon and tides",
     "les marées sont liées principalement à l'attraction de la Lune", "tides are linked mainly to the Moon's attraction",
     "aux vents dominants seulement", "to prevailing winds only"),
    ("les volcans", "volcanoes",
     "des ouvertures de la croûte laissant remonter du magma", "openings in the crust letting magma rise",
     "des montagnes formées uniquement par l'érosion", "mountains formed only by erosion"),
    ("l'énergie des aliments", "food energy",
     "mesurée en kilocalories ou kilojoules", "measured in kilocalories or kilojoules",
     "mesurée en watts", "measured in watts"),
    ("la protection solaire", "sun protection",
     "l'indice SPF mesure la protection contre les UVB", "the SPF index measures UVB protection",
     "l'indice SPF mesure la température de la peau", "the SPF index measures skin temperature"),
    ("la photosynthèse", "photosynthesis",
     "les plantes consomment du CO₂ et libèrent de l'oxygène à la lumière", "plants consume CO₂ and release oxygen in light",
     "les plantes consomment de l'oxygène la nuit pour fabriquer du sucre", "plants consume oxygen at night to make sugar"),
    ("la température corporelle humaine normale", "normal human body temperature",
     "d'environ 37 °C", "about 37 °C",
     "d'environ 42 °C", "about 42 °C"),
    ("le porteur d'oxygène du sang", "the blood's oxygen carrier",
     "l'hémoglobine des globules rouges", "hemoglobin in red blood cells",
     "les plaquettes", "platelets"),
    ("le Soleil", "the Sun",
     "une étoile, la plus proche de la Terre", "a star, the closest one to Earth",
     "une planète géante", "a giant planet"),
    ("la révolution de la Terre", "Earth's orbit",
     "environ 365 jours autour du Soleil", "about 365 days around the Sun",
     "environ 24 heures autour du Soleil", "about 24 hours around the Sun"),
    ("la révolution de la Lune", "the Moon's orbit",
     "environ 27 jours autour de la Terre", "about 27 days around Earth",
     "environ 7 jours autour de la Terre", "about 7 days around Earth"),
    ("l'année-lumière", "a light-year",
     "la distance parcourue par la lumière en un an", "the distance light travels in one year",
     "une unité de temps", "a unit of time"),
    ("Mars", "Mars",
     "la quatrième planète du système solaire", "the fourth planet from the Sun",
     "la deuxième planète du système solaire", "the second planet from the Sun"),
    ("le Sahara", "the Sahara",
     "le plus grand désert chaud du monde", "the largest hot desert in the world",
     "le plus grand désert froid du monde", "the largest cold desert in the world"),
    ("le Kilimandjaro", "Mount Kilimanjaro",
     "en Tanzanie, plus haut sommet d'Afrique", "in Tanzania, Africa's highest peak",
     "au Kenya", "in Kenya"),
    ("la loi d'Ohm", "Ohm's law",
     "U = R × I (tension = résistance × courant)", "U = R × I (voltage = resistance × current)",
     "U = R ÷ I", "U = R ÷ I"),
    ("un condensateur", "a capacitor",
     "un composant qui stocke des charges électriques", "a component that stores electric charges",
     "un composant qui amplifie le courant", "a component that amplifies current"),
    ("la boucle robotique", "the robotics loop",
     "capteurs → décision → actionneurs, en boucle fermée", "sensors → decision → actuators, in closed loop",
     "actionneurs → décision → capteurs", "actuators → decision → sensors"),
    ("la déforestation", "deforestation",
     "réduit l'absorption de CO₂ et dégrade les sols", "reduces CO₂ absorption and degrades soils",
     "augmente l'absorption de CO₂", "increases CO₂ absorption"),
    ("le blanchiment des coraux", "coral bleaching",
     "provoqué notamment par un réchauffement de l'eau", "caused notably by water warming",
     "causé par un refroidissement extrême de l'eau", "caused by extreme water cooling"),
    ("les énergies renouvelables", "renewable energies",
     "solaire, éolienne, hydraulique, géothermie, biomasse", "solar, wind, hydro, geothermal, biomass",
     "charbon et gaz naturel", "coal and natural gas"),
    ("le principe du levier", "the lever principle",
     "une petite force sur un grand bras équilibre une grande force sur un petit bras", "a small force on a long arm balances a large force on a short arm",
     "une force double donne un bras quadruple", "a doubled force gives a quadrupled arm"),
    ("le son dans l'eau et l'air", "sound in water vs air",
     "le son se propage plus vite dans l'eau que dans l'air", "sound travels faster in water than in air",
     "le son se propage plus vite dans l'air que dans l'eau", "sound travels faster in air than in water"),
    ("le pH acide", "acidic pH",
     "un pH inférieur à 7", "a pH below 7",
     "un pH supérieur à 7", "a pH above 7"),
    ("l'ADN", "DNA",
     "porte l'information héréditaire des êtres vivants", "carries the hereditary information of living beings",
     "sert uniquement de réserve d'énergie", "only serves as an energy store"),
    ("l'équateur", "the equator",
     "traverse l'Afrique centrale", "crosses central Africa",
     "passe par l'Europe du Sud", "runs through southern Europe"),
    ("l'unité de résistance", "the unit of resistance",
     "l'ohm (symbole Ω)", "the ohm (symbol Ω)",
     "le volt (symbole V)", "the volt (symbol V)"),
    ("la conversion d'énergie d'une lampe solaire", "a solar lamp's energy conversion",
     "lumière → électricité (panneau) → lumière (LED), avec stockage batterie", "light → electricity (panel) → light (LED), with battery storage",
     "électricité → charbon → lumière", "electricity → coal → light"),
    ("le recyclage", "recycling",
     "réduit l'extraction de matières premières et les déchets", "reduces raw-material extraction and waste",
     "augmente toujours l'empreinte carbone", "always increases the carbon footprint"),
]

def fab_sciences_directe(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet_fr, sujet_en, fait_fr, fait_en, _, _ = rng.choice(FAITS)
    qui = rng.choice(NOMS_FR if fr else NAMES_EN)
    gabarits_fr = [
        (f"{qui} demande : que sait-on sur {sujet_fr} ?", f"{fait_fr.capitalize()}."),
        (f"{qui} prépare un exposé : explique {sujet_fr} en une phrase.", f"{fait_fr.capitalize()} — phrase unique, sans extrapolation."),
        (f"{qui} révise : rappelle le fait essentiel sur {sujet_fr}.", f"{fait_fr.capitalize()} (fait de référence)."),
        (f"{qui} interroge : {sujet_fr}, c'est quoi exactement ?", f"{fait_fr.capitalize()}."),
        (f"Fiche de révision demandée par {qui} : {sujet_fr}.", f"{fait_fr.capitalize()} — à retenir tel quel."),
        (f"{qui} corrige un quiz : donne la réponse établie sur {sujet_fr}.", f"{fait_fr.capitalize()}.")]
    gabarits_en = [
        (f"{qui} asks: what do we know about {sujet_en}?", f"{fait_en.capitalize()}."),
        (f"{qui} prepares a talk: explain {sujet_en} in one sentence.", f"{fait_en.capitalize()} — single sentence, no extrapolation."),
        (f"{qui} is revising: recall the key fact about {sujet_en}.", f"{fait_en.capitalize()} (reference fact)."),
        (f"{qui} asks: {sujet_en}, what exactly is it?", f"{fait_en.capitalize()}."),
        (f"Revision card requested by {qui}: {sujet_en}.", f"{fait_en.capitalize()} — to be memorized as is."),
        (f"{qui} grades a quiz: give the established answer about {sujet_en}.", f"{fait_en.capitalize()}.")]
    inp, out = rng.choice(gabarits_fr if fr else gabarits_en)
    return {"task_type": "science_fact", "language": "fr" if fr else "en",
            "instruction": "Réponds par le fait établi, sans extrapoler." if fr else "Answer with the established fact, no extrapolation.",
            "input": inp, "output": out, "difficulty": "facile"}

def fab_sciences_vrai_faux(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet_fr, sujet_en, fait_fr, fait_en, faux_fr, faux_en = rng.choice(FAITS)
    affirm_fr = rng.choice([(fait_fr, "VRAI"), (faux_fr, "FAUX")])
    affirm_en = rng.choice([(fait_en, "TRUE"), (faux_en, "FALSE")])
    if fr:
        affirmation, verdict = affirm_fr
        out = (f"{verdict}. " + (f"Le fait établi : {fait_fr}." if verdict == "FAUX" else
                                 "C'est bien le fait établi, enseigné dans les références de base."))
    else:
        affirmation, verdict = affirm_en
        out = (f"{verdict}. " + (f"The established fact: {fait_en}." if verdict == "FALSE" else
                                 "That is indeed the established fact taught in basic references."))
    return {"task_type": "true_false_science", "language": "fr" if fr else "en",
            "instruction": "Juge l'affirmation et justifie par le fait établi." if fr
            else "Judge the statement and justify with the established fact.",
            "input": f"Affirmation : {affirmation}." if fr else f"Statement: {affirmation}.",
            "output": out, "difficulty": "facile"}

def fab_sciences_application(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet_fr, sujet_en, fait_fr, fait_en, _, _ = rng.choice(FAITS)
    ville = rng.choice(VILLES_FR if fr else CITIES_EN)
    situation_fr, situation_en = rng.choice([
        ("un projet scolaire", "a school project"), ("un atelier communautaire", "a community workshop"),
        ("une démonstration pratique", "a hands-on demo"), ("un débat de classe", "a class debate"),
        ("une visite guidée", "a guided tour"), ("un documentaire local", "a local documentary"),
        ("un quiz culturel", "a culture quiz"), ("une formation technique", "a technical training")])
    if fr:
        inp = (f"Mise en situation à {ville} : pendant {situation_fr}, quelqu'un applique {sujet_fr}. "
               f"Quel principe s'applique et pourquoi ?")
        out = (f"Principe : {fait_fr}.\nApplication : on s'appuie sur ce principe établi pour expliquer le "
               f"phénomène observé pendant {situation_fr}, en restant dans son périmètre — au-delà, "
               f"gen3 dit explicitement qu'il ne sait pas.")
    else:
        inp = (f"Field case in {ville}: during {situation_en}, someone applies {sujet_en}. "
               f"Which principle applies and why?")
        out = (f"Principle: {fait_en}.\nApplication: rely on this established principle to explain the "
               f"phenomenon observed during {situation_en}, staying within its scope — beyond that, "
               f"gen3 explicitly says it does not know.")
    return {"task_type": "science_application", "language": "fr" if fr else "en",
            "instruction": "Applique le principe établi à la situation, sans sur-généraliser." if fr
            else "Apply the established principle to the situation, without over-generalizing.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

FABRIQUES_SCIENCES = [fab_sciences_directe, fab_sciences_vrai_faux, fab_sciences_application]
