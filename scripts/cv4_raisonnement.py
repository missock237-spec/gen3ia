#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum v4 — Phase 2 : raisonnement et mathématiques (165 000 lignes).

  reasoning        45 000 — déductions logiques vérifiables (syllogismes, suites, classements)
  math             90 000 — calcul exact programmé (arithmétique, %, équations, géométrie, taux)
  problem_solving  30 000 — plans de résolution structurés par situation
"""

from __future__ import annotations

import random

from cv4_pools import (CITIES_EN, NOMS_FR, NAMES_EN, OBJETS_FR, OBJECTS_EN,
                       PRODUITS_EN, PRODUITS_FR, VILLES_FR, MONTANTS, POURCENTAGES)

# ═══════════════════ reasoning (45 000) ═══════════════════

CATEGORIES_FR = ["roses", "fruits du verger", "outils de jardin", "livres de poche",
                 "tapis artisanaux", "appareils photo", "vélos de ville", "plantes médicinales",
                 "fromages fermiers", "instruments de musique", "cahiers recyclés", "lampes solaires"]
CATEGORIES_EN = ["roses", "orchard fruits", "garden tools", "paperbacks",
                 "handmade rugs", "cameras", "city bikes", "medicinal plants",
                 "farm cheeses", "musical instruments", "recycled notebooks", "solar lamps"]

def fab_syllogisme(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    cat_a = rng.choice(CATEGORIES_FR) if fr else rng.choice(CATEGORIES_EN)
    cat_b = rng.choice([c for c in (CATEGORIES_FR if fr else CATEGORIES_EN) if c != cat_a])
    lieu = rng.choice(VILLES_FR) if fr else rng.choice(CITIES_EN)
    n = rng.randint(3, 12)
    if fr:
        majeure = f"Tous les articles vendus à {lieu} qui portent une étiquette verte sont des {cat_b}."
        mineure = f"{n} {cat_a} de ce marché portent une étiquette verte."
        question = "Que peut-on déduire CERTAINEMENT ?"
        reponse = f"Ces {n} {cat_a} sont des {cat_b} (par le syllogisme : étiquette verte → {cat_b}, or ils ont une étiquette verte)."
    else:
        majeure = f"All items sold in {lieu} that carry a green tag are {cat_b}."
        mineure = f"{n} {cat_a} from this market carry a green tag."
        question = "What can be CERTAINLY deduced?"
        reponse = f"Those {n} {cat_a} are {cat_b} (by syllogism: green tag → {cat_b}, and they have green tags)."
    return {
        "task_type": "syllogism",
        "language": "fr" if fr else "en",
        "instruction": "Déduis uniquement ce qui est certain ; signale explicitement ce qui ne peut pas être conclu." if fr
                       else "Deduce only what is certain; explicitly state what cannot be concluded.",
        "input": f"{majeure}\n{mineure}\n{question}" if fr else f"{majeure}\n{mineure}\n{question}",
        "output": reponse,
        "difficulty": "intermédiaire",
    }

def fab_suite(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    genre = rng.choice(["arith", "geo", "carres", "fib"])
    if genre == "arith":
        a, r = rng.randint(2, 20), rng.randint(2, 9)
        seq = [a + r * i for i in range(5)]
        suiv = a + r * 5
        explication = "différence constante" if fr else "constant difference"
    elif genre == "geo":
        a, r = rng.randint(1, 5), rng.choice([2, 3])
        seq = [a * r ** i for i in range(5)]
        suiv = a * r ** 5
        explication = "raison géométrique" if fr else "geometric ratio"
    elif genre == "carres":
        a = rng.randint(2, 9)
        seq = [(a + i) ** 2 for i in range(5)]
        suiv = (a + 5) ** 2
        explication = "carrés successifs" if fr else "consecutive squares"
    else:
        f1, f2 = rng.randint(1, 4), rng.randint(2, 5)
        seq = [f1, f2]
        for _ in range(3):
            seq.append(seq[-1] + seq[-2])
        suiv = seq[-1] + seq[-2]
        explication = "somme des deux précédents" if fr else "sum of the two previous terms"
    texte = ", ".join(map(str, seq))
    if fr:
        inp = f"Suite : {texte}, ?\nQuel est le terme suivant ? Justifie en une phrase."
        out = f"{suiv} — la règle est : {explication}."
    else:
        inp = f"Sequence: {texte}, ?\nWhat is the next term? Justify in one sentence."
        out = f"{suiv} — the rule is: {explication}."
    return {
        "task_type": "number_sequence",
        "language": "fr" if fr else "en",
        "instruction": "Trouve le terme suivant et nomme la règle." if fr else "Find the next term and name the rule.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

def fab_classement(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    noms = rng.sample(NOMS_FR if fr else NAMES_EN, k=rng.randint(3, 5))
    tailles = rng.sample(range(150, 200), k=len(noms))
    couples = list(zip(noms, tailles))
    rng.shuffle(couples)
    if fr:
        lignes = "\n".join(f"{n} mesure {t} cm." for n, t in couples)
        question = "Qui est le plus grand ? Et qui est le plus petit ?"
        maxi = max(couples, key=lambda c: c[1]); mini = min(couples, key=lambda c: c[1])
        reponse = f"Le plus grand : {maxi[0]} ({maxi[1]} cm) ; le plus petit : {mini[0]} ({mini[1]} cm)."
    else:
        lignes = "\n".join(f"{n} is {t} cm tall." for n, t in couples)
        question = "Who is the tallest? And who is the shortest?"
        maxi = max(couples, key=lambda c: c[1]); mini = min(couples, key=lambda c: c[1])
        reponse = f"Tallest: {maxi[0]} ({maxi[1]} cm); shortest: {mini[0]} ({mini[1]} cm)."
    return {
        "task_type": "ordering_puzzle",
        "language": "fr" if fr else "en",
        "instruction": "Classe les informations puis réponds exactement." if fr else "Sort the facts then answer exactly.",
        "input": f"{lignes}\n{question}" if fr else f"{lignes}\n{question}",
        "output": reponse,
        "difficulty": "facile",
    }

def fab_logique_conditionnelle(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    objet = rng.choice(OBJETS_FR) if fr else rng.choice(OBJECTS_EN)
    produit = rng.choice(PRODUITS_FR) if fr else rng.choice(PRODUITS_EN)
    m = rng.choice(MONTANTS)
    au_dessus = rng.random() < 0.6
    montant_cas = m + rng.randint(1, 500) if au_dessus else max(10, m - rng.randint(1, 50))
    if fr:
        regles = (f"Règles du magasin : 1) Toute commande de {produit} au-dessus de {m} francs offre la livraison. "
                  f"2) La livraison offerte inclut l'assurance. 3) L'assurance ne couvre PAS le {objet} hors coffret.")
        cas = f"une commande de {produit} à {montant_cas} francs"
        if au_dessus:
            reponse = (f"{cas} → livraison offerte (règle 1) → assurance incluse (règle 2). "
                       f"Le {objet} hors coffret n'est PAS couvert (règle 3).")
        else:
            reponse = (f"{cas} → montant sous le seuil de {m} francs → pas de livraison offerte, "
                       f"donc pas d'assurance automatique (règles 1-2).")
    else:
        regles = (f"Store rules: 1) Any {produit} order above {m} francs gets free shipping. "
                  f"2) Free shipping includes insurance. 3) Insurance does NOT cover the {objet} outside its case.")
        montant_cas = m + rng.randint(1, 500) if rng.random() < 0.6 else max(10, m - rng.randint(1, 50))
        cas = f"a {produit} order of {montant_cas} francs"
        if montant_cas > m:
            reponse = (f"{cas} → free shipping (rule 1) → insurance included (rule 2). "
                       f"The {objet} outside its case is NOT covered (rule 3).")
        else:
            reponse = (f"{cas} → below the {m}-franc threshold → no free shipping, "
                       f"therefore no automatic insurance (rules 1-2).")
    return {
        "task_type": "conditional_logic",
        "language": "fr" if fr else "en",
        "instruction": "Applique les règles dans l'ordre et conclus rigoureusement." if fr else "Apply the rules in order and conclude rigorously.",
        "input": f"{regles}\nCas : {cas}." if fr else f"{regles}\nCase: {cas}.",
        "output": reponse,
        "difficulty": "avancé",
    }

# ═══════════════════ math (90 000) ═══════════════════

def _fmt(x: float) -> str:
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return f"{x:.2f}".rstrip("0").rstrip(".")

def fab_arithmetique(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    a, b, c, d = (rng.randint(2, 999) for _ in range(4))
    if rng.random() < 0.5:
        expr_val = (a + b) * c - d
        inp = f"({a} + {b}) × {c} − {d}"
        explication = "parenthèses, puis multiplication, puis soustraction" if fr else "parentheses, then multiplication, then subtraction"
    else:
        expr_val = a * b + c * d
        inp = f"{a} × {b} + {c} × {d}"
        explication = "deux multiplications d'abord, puis addition" if fr else "both multiplications first, then addition"
    if fr:
        out = f"{_fmt(expr_val)} — on calcule dans l'ordre : {explication}."
        q = "Calcule en respectant les priorités opératoires."
    else:
        out = f"{_fmt(expr_val)} — compute in order: {explication}."
        q = "Compute respecting operator precedence."
    return {
        "task_type": "arithmetic",
        "language": "fr" if fr else "en",
        "instruction": q,
        "input": inp,
        "output": out,
        "difficulty": "facile",
    }

def fab_pourcentage(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    p = rng.choice(POURCENTAGES)
    n = rng.randint(100, 50_000)
    genre = rng.choice(["part", "hausse", "baisse"])
    if genre == "part":
        val = n * p / 100
        if fr:
            inp, q = f"Calculer {p} % de {n:,} francs.", f"{p} % de {n:,} francs = {p} ÷ 100 × {n:,} = {_fmt(val)} francs."
        else:
            inp, q = f"Compute {p}% of {n:,} francs.", f"{p}% of {n:,} francs = {p} ÷ 100 × {n:,} = {_fmt(val)} francs."
    elif genre == "hausse":
        val = n * (1 + p / 100)
        if fr:
            inp, q = f"Un prix de {n:,} francs augmente de {p} %. Nouveau prix ?", f"{n:,} × (1 + {p}/100) = {_fmt(val)} francs."
        else:
            inp, q = f"A price of {n:,} francs increases by {p}%. New price?", f"{n:,} × (1 + {p}/100) = {_fmt(val)} francs."
    else:
        val = n * (1 - p / 100)
        if fr:
            inp, q = f"Un prix de {n:,} francs baisse de {p} %. Nouveau prix ?", f"{n:,} × (1 − {p}/100) = {_fmt(val)} francs."
        else:
            inp, q = f"A price of {n:,} francs drops by {p}%. New price?", f"{n:,} × (1 − {p}/100) = {_fmt(val)} francs."
    return {
        "task_type": "percentage",
        "language": "fr" if fr else "en",
        "instruction": "Résous et montre le calcul en une ligne." if fr else "Solve and show the computation in one line.",
        "input": inp,
        "output": q,
        "difficulty": "facile",
    }

def fab_equation(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    a = rng.randint(2, 19)
    x = rng.randint(2, 99)
    b = rng.randint(1, 300)
    c = a * x + b
    if fr:
        inp, out = f"Résous : {a}x + {b} = {c}", f"x = {x} — on soustrait {b} puis on divise par {a} : ({c} − {b}) ÷ {a} = {x}."
    else:
        inp, out = f"Solve: {a}x + {b} = {c}", f"x = {x} — subtract {b} then divide by {a}: ({c} − {b}) ÷ {a} = {x}."
    return {
        "task_type": "linear_equation",
        "language": "fr" if fr else "en",
        "instruction": "Résous l'équation et explique la démarche en une phrase." if fr else "Solve the equation and explain the step in one sentence.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

def fab_geometrie(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    forme = rng.choice(["rectangle", "cercle", "triangle"])
    if forme == "rectangle":
        l, L = rng.randint(2, 99), rng.randint(2, 99)
        aire, per = l * L, 2 * (l + L)
        if fr:
            inp = f"Rectangle : longueur {L} m, largeur {l} m. Aire et périmètre ?"
            out = f"Aire = {L} × {l} = {aire} m² ; périmètre = 2 × ({L} + {l}) = {per} m."
        else:
            inp = f"Rectangle: length {L} m, width {l} m. Area and perimeter?"
            out = f"Area = {L} × {l} = {aire} m²; perimeter = 2 × ({L} + {l}) = {per} m."
    elif forme == "cercle":
        r = rng.randint(2, 99)
        aire = round(3.14159 * r * r, 2)
        cir = round(2 * 3.14159 * r, 2)
        if fr:
            inp = f"Cercle de rayon {r} cm (π ≈ 3,14159). Aire et circonférence ?"
            out = f"Aire ≈ π × {r}² = {aire} cm² ; circonférence ≈ 2π × {r} = {cir} cm."
        else:
            inp = f"Circle of radius {r} cm (π ≈ 3.14159). Area and circumference?"
            out = f"Area ≈ π × {r}² = {aire} cm²; circumference ≈ 2π × {r} = {cir} cm."
    else:
        b, h = rng.randint(3, 99), rng.randint(2, 99)
        aire = b * h / 2
        if fr:
            inp = f"Triangle : base {b} cm, hauteur {h} cm. Aire ?"
            out = f"Aire = base × hauteur ÷ 2 = {b} × {h} ÷ 2 = {_fmt(aire)} cm²."
        else:
            inp = f"Triangle: base {b} cm, height {h} cm. Area?"
            out = f"Area = base × height ÷ 2 = {b} × {h} ÷ 2 = {_fmt(aire)} cm²."
    return {
        "task_type": "geometry",
        "language": "fr" if fr else "en",
        "instruction": "Applique la formule et donne le résultat avec son unité." if fr else "Apply the formula and give the result with its unit.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

def fab_proportion(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    produit = rng.choice(PRODUITS_FR) if fr else rng.choice(PRODUITS_EN)
    n1 = rng.choice([2, 3, 4, 5, 6])
    prix_n1 = rng.randint(150, 9_900)
    n2 = n1 * rng.randint(2, 8)
    prix_n2 = prix_n1 // n1 * n2
    if fr:
        inp = f"{n1} {produit}s coûtent {prix_n1} francs. Quel prix pour {n2} ?"
        out = f"Prix unitaire = {prix_n1} ÷ {n1} = {prix_n1 // n1} francs ; pour {n2} : {prix_n1 // n1} × {n2} = {prix_n2} francs."
    else:
        inp = f"{n1} {produit}s cost {prix_n1} francs. Price for {n2}?"
        out = f"Unit price = {prix_n1} ÷ {n1} = {prix_n1 // n1} francs; for {n2}: {prix_n1 // n1} × {n2} = {prix_n2} francs."
    return {
        "task_type": "proportion",
        "language": "fr" if fr else "en",
        "instruction": "Passe par le prix unitaire puis multiplie." if fr else "Go through the unit price then multiply.",
        "input": inp,
        "output": out,
        "difficulty": "facile",
    }

def fab_vitesse(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    v = rng.randint(20, 130)
    t = rng.randint(1, 12)
    genre = rng.choice(["distance", "temps", "vitesse"])
    if genre == "distance":
        d = v * t
        if fr:
            inp = f"Un véhicule roule à {v} km/h pendant {t} h. Distance ?"
            out = f"d = v × t = {v} × {t} = {d} km."
        else:
            inp = f"A vehicle travels at {v} km/h for {t} h. Distance?"
            out = f"d = v × t = {v} × {t} = {d} km."
    elif genre == "temps":
        d = v * t
        if fr:
            inp = f"Un trajet de {d} km à {v} km/h. Durée ?"
            out = f"t = d ÷ v = {d} ÷ {v} = {t} h."
        else:
            inp = f"A {d} km trip at {v} km/h. Duration?"
            out = f"t = d ÷ v = {d} ÷ {v} = {t} h."
    else:
        d = v * t
        if fr:
            inp = f"{d} km parcourus en {t} h. Vitesse moyenne ?"
            out = f"v = d ÷ t = {d} ÷ {t} = {v} km/h."
        else:
            inp = f"{d} km covered in {t} h. Average speed?"
            out = f"v = d ÷ t = {d} ÷ {t} = {v} km/h."
    return {
        "task_type": "rate_problem",
        "language": "fr" if fr else "en",
        "instruction": "Applique la formule d = v × t avec les unités." if fr else "Apply d = v × t with units.",
        "input": inp,
        "output": out,
        "difficulty": "facile",
    }

# ═══════════════════ problem_solving (30 000) ═══════════════════

SITUATIONS_FR = [
    ("retard de livraison client", ["confirmer les faits auprès du transporteur", "contacter le client avec un délai honnête",
                                    "proposer un geste commercial proportionné", "ajouter une alerte automatique de retard"]),
    ("dépassement de budget projet", ["figer le périmètre restant", "reclasser les tâches par valeur",
                                      "renégocier 2 lignes de coûts", "mettre en place un suivi hebdomadaire"]),
    ("panne du système de facturation", ["basculer sur le processus papier temporaire", "informer les équipes concernées",
                                         "corriger la cause racine en environnement de test", "planifier la reprise et la purge des files"]),
    ("conflit d'agenda entre deux réunions clés", ["identifier la réunion bloquante", "proposer une délégation pour l'une",
                                                   "décaler avec une justification factuelle", "confirmer les deux participants"]),
    ("stock insuffisant avant une promotion", ["vérifier les ventes réelles attendues", "bloquer le stock disponible",
                                               "limiter la promotion par commande", "commander en express le complément"]),
    ("note client en baisse sur un service", ["analyser les 20 derniers avis", "interviewer 3 clients insatisfaits",
                                              "corriger les 2 causes les plus citées", "re-mesurer après 30 jours"]),
]
SITUATIONS_EN = [
    ("customer delivery delay", ["confirm the facts with the carrier", "contact the customer with an honest ETA",
                                 "offer a proportionate goodwill gesture", "add an automatic delay alert"]),
    ("project budget overrun", ["freeze the remaining scope", "re-rank tasks by value",
                                "renegotiate 2 cost lines", "set up weekly tracking"]),
    ("billing system outage", ["switch to the temporary paper process", "inform the affected teams",
                               "fix the root cause in staging", "schedule recovery and queue purge"]),
    ("calendar clash between two key meetings", ["identify the blocking meeting", "propose a delegate for one",
                                                 "reschedule with a factual reason", "confirm with both attendees"]),
    ("low stock before a promotion", ["check the real expected sales", "lock the available stock",
                                      "cap the promotion per order", "express-order the shortfall"]),
    ("falling customer rating on a service", ["analyze the last 20 reviews", "interview 3 unhappy customers",
                                              "fix the 2 most cited causes", "re-measure after 30 days"]),
]

def fab_plan_resolution(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    situation, etapes = rng.choice(SITUATIONS_FR if fr else SITUATIONS_EN)
    n = rng.randint(3, 4)
    contrat = rng.choice([2, 3, 5, 7, 14])
    if fr:
        inp = (f"Situation : {situation}. Contrainte : une réponse satisfaisante est attendue "
               f"sous {contrat} jours. Construis un plan en {n} étapes.")
        out = "Plan :\n" + "\n".join(f"{i+1}. {e} (jour {1 + i * max(1, contrat // n)})"
                                     for i, e in enumerate(etapes[:n]))
    else:
        inp = (f"Situation: {situation}. Constraint: a satisfactory answer is expected within "
               f"{contrat} days. Build a {n}-step plan.")
        out = "Plan:\n" + "\n".join(f"{i+1}. {e} (day {1 + i * max(1, contrat // n)})"
                                    for i, e in enumerate(etapes[:n]))
    return {
        "task_type": "solution_plan",
        "language": "fr" if fr else "en",
        "instruction": "Décompose en étapes ordonnées, chacune avec un jalon temporel et un critère de réussite." if fr
                       else "Break it into ordered steps, each with a time milestone and a success criterion.",
        "input": inp,
        "output": out + ("\nCritère de réussite final : situation clôturée et vérifiée." if fr
                         else "\nFinal success criterion: situation closed and verified."),
        "difficulty": "intermédiaire",
    }

def fab_choix_argumente(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    produit_a = rng.choice(PRODUITS_FR) if fr else rng.choice(PRODUITS_EN)
    produit_b = rng.choice([p for p in (PRODUITS_FR if fr else PRODUITS_EN) if p != produit_a])
    pa, pb = rng.choice(MONTANTS), rng.choice(MONTANTS)
    budget = max(pa, pb) + rng.choice([0, 200, 500, 1000])
    if fr:
        inp = (f"Contexte : budget {budget} francs. Option A : {produit_a} à {pa} francs (garantie 1 an). "
               f"Option B : {produit_b} à {pb} francs (garantie 2 ans). Usage : quotidien, intensif.")
        out = (f"Recommandation : {'Option A' if pa <= pb else 'Option B'} si le critère principal est le prix immédiat, "
               f"mais l'usage intensif quotidien plaide pour la garantie la plus longue — "
               f"Option {'B' if pa <= pb else 'A'} (garantie 2 ans, écart de prix de {abs(pa - pb)} francs dans le budget). "
               f"À vérifier avant achat : disponibilité des pièces et coût des consommables.")
    else:
        inp = (f"Context: {budget}-franc budget. Option A: {produit_a} at {pa} francs (1-year warranty). "
               f"Option B: {produit_b} at {pb} francs (2-year warranty). Usage: daily, intensive.")
        out = (f"Recommendation: Option {'A' if pa <= pb else 'B'} if the main criterion is upfront price, "
               f"but intensive daily usage argues for the longest warranty — "
               f"Option {'B' if pa <= pb else 'A'} (2-year warranty, price gap of {abs(pa - pb)} francs within budget). "
               f"Check before buying: parts availability and consumable costs.")
    return {
        "task_type": "decision_with_tradeoffs",
        "language": "fr" if fr else "en",
        "instruction": "Compare les options sur des critères explicites, tranche, et liste les risques." if fr
                       else "Compare options on explicit criteria, decide, and list the risks.",
        "input": inp,
        "output": out,
        "difficulty": "avancé",
    }

FABRIQUES_REASONING = [fab_syllogisme, fab_suite, fab_classement, fab_logique_conditionnelle]
FABRIQUES_MATH = [fab_arithmetique, fab_pourcentage, fab_equation, fab_geometrie,
                  fab_proportion, fab_vitesse]
FABRIQUES_PROBLEM = [fab_plan_resolution, fab_choix_argumente]
