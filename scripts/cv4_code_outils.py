#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum v4 — Phases 3-5 : programmation, outils, RAG, bases de données (130 000).

  code          60 000 — React, Python, SQL, CSS, regex, API REST, complexité (paramétrisation large)
  tools         35 000 — appels d'outils/API en JSON strict + enchaînements multi-étapes
  rag_documents 20 000 — réponse ancrée sur des politiques PARAMÉTRÉES (30 % non répondables)
  databases     15 000 — SQL de lecture sur 4 schémas métier, agrégats et filtres variés
"""

from __future__ import annotations

import random

from cv4_pools import (CITIES_EN, ENTREPRISES, NOMS_FR, NAMES_EN, PRODUITS_EN,
                       PRODUITS_FR, VILLES_FR, MONTANTS, POURCENTAGES)

# ═══════════════════ code (60 000) ═══════════════════

COMPOSANTS_FR = [("Carte produit", "ProductCard"), ("Formulaire d'inscription", "SignupForm"),
                 ("Tableau de bord", "Dashboard"), ("Barre de navigation", "NavBar"),
                 ("Modale de confirmation", "ConfirmDialog"), ("Liste de tâches", "TaskList"),
                 ("Galerie d'images", "ImageGallery"), ("Panier d'achat", "ShoppingCart"),
                 ("Champ de recherche", "SearchField"), ("Grille tarifaire", "PricingGrid"),
                 ("Barre de progression", "ProgressBar"), ("Encart statistique", "StatCard"),
                 ("Sélecteur de date", "DatePicker"), ("Fil d'Ariane", "Breadcrumbs"),
                 ("Onglets", "Tabs"), ("Menu latéral", "SideMenu"),
                 ("Tableau triable", "SortableTable"), ("Pagination", "Pagination")]
COMPONENTS_EN = [("Product card", "ProductCard"), ("Signup form", "SignupForm"),
                 ("Dashboard", "Dashboard"), ("Navigation bar", "NavBar"),
                 ("Confirmation dialog", "ConfirmDialog"), ("Task list", "TaskList"),
                 ("Image gallery", "ImageGallery"), ("Shopping cart", "ShoppingCart"),
                 ("Search field", "SearchField"), ("Pricing grid", "PricingGrid"),
                 ("Progress bar", "ProgressBar"), ("Stat card", "StatCard"),
                 ("Date picker", "DatePicker"), ("Breadcrumbs", "Breadcrumbs"),
                 ("Tabs", "Tabs"), ("Side menu", "SideMenu"),
                 ("Sortable table", "SortableTable"), ("Pagination", "Pagination")]

PROPS_SETS = ["titre: string", "titre: string, sousTitre: string", "items: T[]",
              "items: T[], onSelection: (t: T) => void", "valeur: number, max: number",
              "visible: boolean, onFermer: () => void", "libelle: string, obligatoire?: boolean",
              "filtres: Record<string, string>", "chargement: boolean, erreur?: string",
              "image: string, alt: string", "total: number, devise: string",
              "etapes: string[], active: number", "options: {id: string; label: string}[]",
              "selection: string | null, onChange: (id: string) => void",
              "source: string[], colonne: number", "limite: number, onLoadMore: () => void",
              "verrouille: boolean, motif?: string", "compact: boolean, afficherIcone: boolean",
              "entete: string[], lignes: T[][]", "erreurGlobal?: string, onReessayer: () => void"]

EXIGENCES = [("accessibilité ARIA", "ARIA accessibility"),
             ("état de chargement + erreur", "loading + error states"),
             ("responsive mobile-first", "mobile-first responsive"),
             ("clavier Entrée/Échap", "Enter/Escape keyboard"),
             ("mémoïsation des listes", "memoized lists"),
             ("contraste AA vérifié", "AA contrast checked"),
             ("libellés i18n prêts", "i18n-ready labels"),
             ("annulation de requête (AbortController)", "request cancellation (AbortController)"),
             ("gestion du focus à l'ouverture", "focus management on open"),
             ("débounce sur la saisie", "input debouncing")]

VARS_ETAT = ["donnees", "items", "resultats", "liste", "entries", "chargementEnCours",
             "selectionActive", "filtreActuel", "page", "compteur"]

def fab_react(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom_fr, Nom = rng.choice(COMPOSANTS_FR if fr else COMPONENTS_EN)
    prop = rng.choice(PROPS_SETS)
    exigence_fr, exigence_en = rng.choice(EXIGENCES)
    etat = rng.choice(VARS_ETAT)
    seuil = rng.choice([5, 10, 20, 50, 100, 250])
    defaut = rng.choice([0, 1, 12, 25, "''"])
    if fr:
        code = (f"const [{etat}, set{etat.capitalize()}] = useState({defaut});\n"
                f"useEffect(() => {{ if ({etat}.length > {seuil}) chargePlus(); }}, [{etat}]);\n"
                f"export function {Nom}(props: {{ {prop} }}) {{\n"
                f"  // Contrat : {exigence_fr}\n"
                f"  return <section aria-label={{props.titre ?? \"{nom_fr}\"}}>{{/* rendu */}}</section>;\n}}")
        inp = (f"Composant : {nom_fr} | props : {prop} | exigence : {exigence_fr} | "
               f"état : {etat} (défaut {defaut}, seuil {seuil})")
        out = (f"Gabarit TypeScript React :\n{code}\n\n"
               f"Revue : a11y (aria-label), exigence « {exigence_fr} », seuil de pagination à {seuil}, "
               f"états contrôlés sans dépendance externe.")
    else:
        code = (f"const [{etat}, set{etat.capitalize()}] = useState({defaut});\n"
                f"useEffect(() => {{ if ({etat}.length > {seuil}) loadMore(); }}, [{etat}]);\n"
                f"export function {Nom}(props: {{ {prop} }}) {{\n"
                f"  // Contract: {exigence_en}\n"
                f"  return <section aria-label={{props.titre ?? \"{Nom}\"}}>{{/* render */}}</section>;\n}}")
        inp = (f"Component: {Nom} | props: {prop} | requirement: {exigence_en} | "
               f"state: {etat} (default {defaut}, threshold {seuil})")
        out = (f"TypeScript React scaffold:\n{code}\n\n"
               f"Review: a11y (aria-label), requirement \"{exigence_en}\", pagination threshold at {seuil}, "
               f"controlled states without external deps.")
    return {"task_type": "react_component", "language": "fr" if fr else "en",
            "instruction": "Écris le composant typé minimal conforme, puis 3 points de revue." if fr
            else "Write the minimal compliant typed component, then 3 review points.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

OPS_PY = [("somme_cumulee", "cumulative sum"), ("moyenne_ponderee", "weighted average"),
          ("remise", "discount"), ("prix_ttc", "gross price"), ("capitalisation", "compound interest"),
          ("taux_conversion", "conversion rate"), ("marge_pourcent", "margin percent"),
          ("arrondi_bancaire", "bankers rounding"), ("duree_formattee", "formatted duration"),
          ("tri_multi_cles", "multi-key sort")]

def fab_python(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    op_fr, op_en = rng.choice(OPS_PY)
    a = rng.randint(2, 999)
    b = rng.randint(2, 999)
    p = rng.choice(POURCENTAGES)
    t = rng.choice([2, 3, 4, 5])
    exemples = {
        "somme_cumulee": (f"def somme_cumulee(valeurs: list[int]) -> list[int]:\n"
                          f"    total, resultat = 0, []\n"
                          f"    for v in valeurs:\n        total += v\n        resultat.append(total)\n"
                          f"    return resultat",
                          f" somme_cumulee([{a}, {b}]) = [{a}, {a + b}]",
                          f" somme_cumulee([{a}, {b}]) = [{a}, {a + b}]"),
        "moyenne_ponderee": (f"def moyenne_ponderee(notes: list[float], poids: list[float]) -> float:\n"
                            f"    if not notes or sum(poids) == 0:\n        raise ValueError('entrees invalides')\n"
                            f"    return sum(n * w for n, w in zip(notes, poids)) / sum(poids)",
                            f" ; cas vide → ValueError",
                            f" ; empty case → ValueError"),
        "remise": (f"def remise(prix: float, pourcent: float) -> float:\n"
                   f"    if prix < 0 or not 0 <= pourcent <= 100:\n        raise ValueError('parametres invalides')\n"
                   f"    return round(prix * (1 - pourcent / 100), 2)",
                   f" ; remise({a}, {p}) = {round(a * (1 - p / 100), 2)}",
                   f" ; remise({a}, {p}) = {round(a * (1 - p / 100), 2)}"),
        "prix_ttc": (f"def prix_ttc(ht: float, taux: float) -> float:\n"
                     f"    return round(ht * (1 + taux / 100), 2)",
                     f" ; prix_ttc({a}, {p}) = {round(a * (1 + p / 100), 2)}",
                     f" ; prix_ttc({a}, {p}) = {round(a * (1 + p / 100), 2)}"),
        "capitalisation": (f"def capitalisation(capital: float, taux: float, ans: int) -> float:\n"
                           f"    return round(capital * (1 + taux / 100) ** ans, 2)",
                           f" ; capitalisation({a}, {p}, {t}) = {round(a * (1 + p / 100) ** t, 2)}",
                           f" ; capitalisation({a}, {p}, {t}) = {round(a * (1 + p / 100) ** t, 2)}"),
        "taux_conversion": (f"def taux_conversion(visites: int, achats: int) -> float:\n"
                            f"    if visites <= 0:\n        raise ValueError('visites doit etre positif')\n"
                            f"    return round(achats / visites * 100, 2)",
                            f" ; taux_conversion({b}, {a}) = {round(a / b * 100, 2)} %",
                            f" ; taux_conversion({b}, {a}) = {round(a / b * 100, 2)}%"),
        "marge_pourcent": (f"def marge_pourcent(cout: float, prix: float) -> float:\n"
                           f"    if prix <= 0:\n        raise ValueError('prix doit etre positif')\n"
                           f"    return round((prix - cout) / prix * 100, 1)",
                           f" ; marge_pourcent({a}, {b}) = {round((b - a) / b * 100, 1)} %",
                           f" ; marge_pourcent({a}, {b}) = {round((b - a) / b * 100, 1)}%"),
        "arrondi_bancaire": (f"from decimal import Decimal, ROUND_HALF_EVEN\n"
                            f"def arrondi_bancaire(x: float, nd: int = 2) -> float:\n"
                            f"    return float(Decimal(str(x)).quantize(Decimal('0.01'), ROUND_HALF_EVEN))",
                            f" ; evite la dérive binaire des floats",
                            f" ; avoids binary float drift"),
        "duree_formattee": (f"def duree_formattee(secondes: int) -> str:\n"
                            f"    m, s = divmod(max(0, secondes), 60)\n"
                            f"    h, m = divmod(m, 60)\n"
                            f"    return f'{{h:02d}}:{{m:02d}}:{{s:02d}}'",
                            f" ; duree_formattee({a * 60 + b % 60}) = {a // 60:02d}:{a % 60:02d}:{b % 60:02d}",
                            f" ; duree_formattee({a * 60 + b % 60}) = {a // 60:02d}:{a % 60:02d}:{b % 60:02d}"),
        "tri_multi_cles": (f"def tri_multi_cles(lignes: list[dict]) -> list[dict]:\n"
                           f"    return sorted(lignes, key=lambda r: (r.get('priorite', 0), r.get('nom', '')))",
                           f" ; stabilité garantie par sorted (Timsort)",
                           f" ; stability guaranteed by sorted (Timsort)"),
    }
    code, verif_fr, verif_en = exemples[op_fr]
    if fr:
        inp = f"Fonction Python : {op_fr.replace('_', ' ')} — paramètres d'exemple : {a}, {b}, {p} %, {t}."
        out = f"{code}\n\nVérification{verif_fr}\nTests : cas nominal, bornes (0, négatif), entrée invalide → ValueError."
    else:
        inp = f"Python function: {op_en} — sample parameters: {a}, {b}, {p}%, {t}."
        out = f"{code}\n\nCheck{verif_en}\nTests: happy path, boundaries (0, negative), invalid input → ValueError."
    return {"task_type": "python_function", "language": "fr" if fr else "en",
            "instruction": "Écris la fonction typée et validée, puis ses tests essentiels." if fr
            else "Write the typed, validated function, then its key tests.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

BUGS = [
    ("boucle qui saute le dernier élément", "loop skipping the last item",
     "range(len(x)) mal borné → for élément in x, ou range(1, n+1)", "range(len(x)) off-by-one → for item in x, or range(1, n+1)"),
    ("comparaison de flottants avec ==", "float comparison with ==",
     "dérive binaire → abs(a-b) < epsilon ou Decimal", "binary drift → abs(a-b) < epsilon or Decimal"),
    ("mutation de liste pendant l'itération", "list mutated while iterating",
     "itérer sur list(x) ou construire une nouvelle liste", "iterate over list(x) or build a new list"),
    ("exception avalée par un except: pass", "exception swallowed by except: pass",
     "journaliser puis relancer, ou gérer explicitement", "log then re-raise, or handle explicitly"),
    ("requête SQL concaténée", "string-concatenated SQL",
     "requête paramétrée (%s / ?) + compte en droits minimaux", "parameterized query (%s / ?) + least-privilege account"),
    ("await manquant sur une coroutine", "missing await on a coroutine",
     "await explicite ou create_task supervisé", "explicit await or supervised create_task"),
    ("clé de dict accédée sans .get", "dict key accessed without .get",
     "r.get(cle, defaut) avec défaut explicite", "r.get(key, default) with an explicit default"),
    ("Date construite en heure locale au lieu d'UTC", "Date built in local time instead of UTC",
     "construire en UTC et convertir à l'affichage", "build in UTC and convert at display time"),
    ("promesse jamais résolue dans un composant", "promise never resolved in a component",
     "annuler la promesse au démontage (cleanup)", "cancel the promise on unmount (cleanup)"),
    ("dépassement d'index sur tableau vide", "index out of range on empty array",
     "garde : if not tableau: return / lever une erreur explicite", "guard: if not array: return / raise explicitly"),
]

def fab_debug(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sympt_fr, sympt_en, fix_fr, fix_en = rng.choice(BUGS)
    fichier = rng.choice(["panier.ts", "facture.py", "route.ts", "api.py", "ui.tsx",
                          "worker.py", "catalogue.ts", "paiement.py", "hooks.ts", "tasks.py"])
    ligne = rng.randint(10, 400)
    var = rng.choice(VARS_ETAT)
    if fr:
        inp = f"Dans {fichier} (ligne ~{ligne}), symptôme : {sympt_fr} (variable « {var} »). Diagnostic et correctif ?"
        out = (f"Diagnostic : cause racine classique — {fix_fr}.\n"
               f"Correctif minimal sur « {var} » + test de non-régression reproduisant le cas ligne {ligne}.")
    else:
        inp = f"In {fichier} (line ~{ligne}), symptom: {sympt_en} (variable \"{var}\"). Diagnosis and fix?"
        out = (f"Diagnosis: classic root cause — {fix_en}.\n"
               f"Minimal fix on \"{var}\" + a regression test reproducing the line-{ligne} case.")
    return {"task_type": "bug_fix", "language": "fr" if fr else "en",
            "instruction": "Cause racine, correctif minimal, test de non-régression." if fr
            else "Root cause, minimal fix, regression test.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

TABLES = [("commandes", "orders"), ("clients", "customers"), ("produits", "products"),
          ("factures", "invoices"), ("livraisons", "shipments"), ("avis", "reviews")]
COLS = [("montant", "amount"), ("total", "total"), ("prix", "price"), ("quantite", "quantity"),
        ("note", "rating"), ("delai_jours", "lead_days")]

def fab_sql(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    t_fr, t_en = rng.choice(TABLES)
    c_fr, c_en = rng.choice(COLS)
    p = rng.choice(POURCENTAGES)
    m = rng.choice(MONTANTS)
    ordre = rng.choice(["DESC", "ASC"])
    if fr:
        inp = (f"SQL : dans « {t_fr} », lister les {p} % lignes au plus {c_fr} {('plus grands' if ordre == 'DESC' else 'plus petits')}, "
               f"en excluant les montants sous {m} francs.")
        out = (f"SELECT * FROM {t_fr}\nWHERE {c_fr} >= {m}\nORDER BY {c_fr} {ordre}\n"
               f"LIMIT (SELECT CEIL(COUNT(*) * {p} / 100.0) FROM {t_fr} WHERE {c_fr} >= {m});\n"
               f"Index conseillé : ({c_fr}) — vérifier le plan EXPLAIN sur un échantillon.")
    else:
        inp = (f"SQL: in \"{t_en}\", list the top {p}% rows by {c_en} ({'highest' if ordre == 'DESC' else 'lowest'}), "
               f"excluding amounts under {m} francs.")
        out = (f"SELECT * FROM {t_en}\nWHERE {c_en} >= {m}\nORDER BY {c_en} {ordre}\n"
               f"LIMIT (SELECT CEIL(COUNT(*) * {p} / 100.0) FROM {t_en} WHERE {c_en} >= {m});\n"
               f"Suggested index: ({c_en}) — check the EXPLAIN plan on a sample.")
    return {"task_type": "sql_query", "language": "fr" if fr else "en",
            "instruction": "Requête lisible + considération d'index." if fr else "Readable query + index consideration.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

MOTIFS = [("+237", r"\+237[0-9]{9}", "numéro camerounais : +237 suivi de 9 chiffres", "Cameroonian number: +237 then 9 digits"),
          ("REF", r"[A-Z]{{3}}-[0-9]{{4}}", "code produit : 3 majuscules, tiret, 4 chiffres", "product code: 3 uppercase, dash, 4 digits"),
          ("CMD", r"(?i)\b(commande|order)[-_]?[0-9]{{6,10}}\b", "référence de commande insensible à la casse", "case-insensitive order reference"),
          ("IP", r"^\d{{1,3}}(\.\d{{1,3}}){{3}}$", "adresse IPv4 souple (plages à valider en plus)", "loose IPv4 (validate ranges separately)"),
          ("DATE", r"^(0[1-9]|[12][0-9]|3[01])/(0[1-9]|1[0-2])/\d{{4}}$", "date JJ/MM/AAAA stricte", "strict DD/MM/YYYY date"),
          ("CODEP", r"^[1-9][0-9]{{3}}$", "code postal à 4 chiffres sans zéro initial", "4-digit postal code, no leading zero")]

def fab_regex(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    genre, motif, expl_fr, expl_en = rng.choice(MOTIFS)
    if genre == "+237":
        exemple = f"+2376{rng.randint(10000000, 99999999)}"
    elif genre == "REF":
        exemple = f"{rng.choice(['ABC', 'KIT', 'ZAN'])}-{rng.randint(1000, 9999)}"
    elif genre == "CMD":
        exemple = f"{rng.choice(['cmd', 'CMD', 'order'])}-{rng.randint(100000, 999999)}"
    elif genre == "IP":
        exemple = f"{rng.randint(1, 255)}.{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(1, 254)}"
    elif genre == "DATE":
        exemple = f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{rng.randint(1970, 2026)}"
    else:
        exemple = str(rng.randint(1000, 9999))
    if fr:
        inp = f"Regex : reconnaître {expl_fr}. Motif, exemple valide et un piège."
        out = (f"Motif : `{motif.format('') if '{{' in motif else motif}`\nExemple valide : {exemple}\n"
               f"Piège : ancrer (^/$) et tester les cas limites (zéro initial, séparateurs absents).")
    else:
        inp = f"Regex: match {expl_en}. Pattern, valid example and one pitfall."
        out = (f"Pattern: `{motif.format('') if '{{' in motif else motif}`\nValid example: {exemple}\n"
               f"Pitfall: anchor (^/$) and test edge cases (leading zero, missing separators).")
    return {"task_type": "regex_authoring", "language": "fr" if fr else "en",
            "instruction": "Motif regex + exemple valide + piège à éviter." if fr
            else "Regex pattern + valid example + pitfall.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

RESSOURCES = [("commandes", "orders"), ("clients", "customers"), ("produits", "products"),
              ("factures", "invoices"), ("avis", "reviews"), ("remboursements", "refunds"),
              ("livraisons", "shipments"), ("utilisateurs", "users")]
VERBES = [("GET", "list", "200 avec Pagination{items, next}", "200 with Pagination{items, next}"),
          ("POST", "create", "201 + Location: /api/…/{id}", "201 + Location: /api/…/{id}"),
          ("PATCH", "update", "200 avec l'état mis à jour ; 404 si absent", "200 with updated state; 404 if missing"),
          ("DELETE", "delete", "204 ; 409 si contrainte de référence", "204; 409 on reference constraint"),
          ("GET", "detail", "200 avec l'entité ; 404 si absente", "200 with the entity; 404 if missing")]

def fab_api_rest(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    r_fr, r_en = rng.choice(RESSOURCES)
    verbe, action, statut_fr, statut_en = rng.choice(VERBES)
    limite = rng.choice([10, 20, 50, 100])
    filtre = rng.choice(["statut", "date", "ville", "categorie", "montant_min", "status", "category"])
    if verbe == "GET":
        chemin = f"/api/{r_fr}?{filtre}=…&page=2&limit={limite}"
    elif verbe == "POST":
        chemin = f"/api/{r_fr}"
    else:
        chemin = f"/api/{r_fr}/{{id}}"
    if fr:
        inp = f"Concevoir : {verbe} {chemin} (ressource : {r_fr}, action : {action})."
        out = (f"Contrat : {verbe} {chemin} → {statut_fr}\n"
               f"Erreurs : 400 validation par champ, 401 sans session, 403 hors périmètre, 429 (Retry-After).\n"
               f"Garde-fous : logs sans PII, Idempotency-Key sur POST, pagination bornée à {limite}.")
    else:
        inp = f"Design: {verbe} {chemin} (resource: {r_en}, action: {action})."
        out = (f"Contract: {verbe} {chemin} → {statut_en}\n"
               f"Errors: 400 per-field validation, 401 without session, 403 out of scope, 429 (Retry-After).\n"
               f"Guardrails: no-PII logs, Idempotency-Key on POST, pagination capped at {limite}.")
    return {"task_type": "rest_api_design", "language": "fr" if fr else "en",
            "instruction": "Contrat (statuts, erreurs, garde-fous) en 5 lignes maximum." if fr
            else "Contract (statuses, errors, guardrails) in at most 5 lines.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

ALGOS = [("double boucle de comparaison", "nested comparison loop", "O(n²)", "hashing/pre-sorting to reach O(n log n)", "hachage/pré-tri pour passer en O(n log n)"),
         ("recherche linéaire dans une table triée", "linear search in a sorted table", "O(n)", "binary search in O(log n)", "recherche binaire en O(log n)"),
         ("tri par sélection", "selection sort", "O(n²)", "the built-in Timsort in O(n log n)", "le tri intégré (Timsort) en O(n log n)"),
         ("récursion naïve de Fibonacci", "naive Fibonacci recursion", "O(2^n)", "memoization in O(n)", "mémoïsation en O(n)"),
         ("concaténation de chaînes en boucle", "string concatenation in a loop", "O(n²)", "join() in O(n)", "join() en O(n)"),
         ("recherche dans une liste non triée", "lookup in an unsorted list", "O(n)", "a set/dict in O(1) amortized", "un set/dict en O(1) amorti")]

def fab_complexite(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    algo_fr, algo_en, cplx, amel_en, amel_fr = rng.choice(ALGOS)
    n = rng.choice([100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000])
    if fr:
        inp = f"Pour n = {n:,} : coût d'une {algo_fr} ? Amélioration à privilégier ?"
        out = (f"Complexité {cplx} — à n = {n:,}, coût prohibitif si le chemin est critique.\n"
               f"Amélioration : {amel_fr}. Mesurer avant/après (échantillon réaliste), jamais à l'aveugle.")
    else:
        inp = f"For n = {n:,}: cost of a {algo_en}? Improvement to prefer?"
        out = (f"Complexity {cplx} — at n = {n:,}, prohibitive if on the hot path.\n"
               f"Improvement: {amel_en}. Measure before/after (realistic sample), never blindly.")
    return {"task_type": "complexity_analysis", "language": "fr" if fr else "en",
            "instruction": "Complexité, impact concret, amélioration." if fr else "Complexity, concrete impact, improvement.",
            "input": inp, "output": out, "difficulty": "avancé"}

def fab_css(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    layout = rng.choice([("grille responsive 3 colonnes", "3-column responsive grid", "grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem;"),
                         ("centrage vertical et horizontal", "vertical and horizontal centering", "display: grid; place-items: center; min-height: 100dvh;"),
                         ("barre collante en bas de viewport", "sticky bottom bar", "position: sticky; bottom: 0; z-index: 10; padding-bottom: env(safe-area-inset-bottom);"),
                         ("colonnes égales sans media queries", "equal columns without media queries", "display: flex; flex-wrap: wrap; flex: 1 1 260px;"),
                         ("espacement vertical rythmé", "rhythmic vertical spacing", "display: flex; flex-direction: column; gap: clamp(0.75rem, 2vw, 1.5rem);")])
    nom_fr, nom_en, css = layout
    if fr:
        inp = f"CSS : {nom_fr}, sans framework, accessible."
        out = f"Solution :\n```css\n{css}\n```\nRevue : contraste du texte ≥ 4,5:1, focus visible, tailles tactiles ≥ 44 px."
    else:
        inp = f"CSS: {nom_en}, framework-free, accessible."
        out = f"Solution:\n```css\n{css}\n```\nReview: text contrast ≥ 4.5:1, visible focus, touch targets ≥ 44 px."
    return {"task_type": "css_layout", "language": "fr" if fr else "en",
            "instruction": "Propose le CSS minimal et 3 points d'accessibilité." if fr
            else "Give the minimal CSS and 3 accessibility points.",
            "input": inp, "output": out, "difficulty": "facile"}

FABRIQUES_CODE = [fab_react, fab_python, fab_debug, fab_sql, fab_regex, fab_api_rest,
                  fab_complexite, fab_css]

# ═══════════════════ tools (35 000) ═══════════════════

OUTILS_FR = [
    ("rechercher_meteo", ["ville", "date"]),
    ("creer_rappel", ["titre", "quand"]),
    ("envoyer_email", ["destinataire", "objet", "corps"]),
    ("consulter_agenda", ["debut", "fin"]),
    ("rechercher_produit", ["terme", "prix_max"]),
    ("passer_commande", ["produit_id", "quantite"]),
    ("reserver_salle", ["salle", "creneau"]),
    ("convertir_devise", ["montant", "depuis", "vers"]),
    ("lister_fichiers", ["dossier"]),
    ("calculer_itineraire", ["origine", "destination", "mode"]),
    ("planifier_livraison", ["adresse", "creneau"]),
    ("consulter_stock", ["produit_id"]),
]
OUTILS_EN = [
    ("search_weather", ["city", "date"]),
    ("create_reminder", ["title", "when"]),
    ("send_email", ["recipient", "subject", "body"]),
    ("check_calendar", ["start", "end"]),
    ("search_product", ["term", "max_price"]),
    ("place_order", ["product_id", "quantity"]),
    ("book_room", ["room", "slot"]),
    ("convert_currency", ["amount", "from", "to"]),
    ("list_files", ["folder"]),
    ("plan_route", ["origin", "destination", "mode"]),
    ("schedule_delivery", ["address", "slot"]),
    ("check_stock", ["product_id"]),
]

DESTINATAIRES = ["client@zanbara.tech", "support@kanouma.co", "ventes@baobab.finance",
                 "contact@kora.shop", "ops@sahellogistics.com", "info@wouridigital.io"]

def fab_appel_outil(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    (nom, args) = rng.choice(OUTILS_FR if fr else OUTILS_EN)
    ville = rng.choice(VILLES_FR if fr else CITIES_EN)
    jour, mois, heure = rng.randint(1, 28), rng.randint(1, 12), rng.randint(8, 18)
    vals = {
        "ville": ville, "city": ville,
        "date": f"{jour:02d}/{mois:02d}/2026",
        "when": (f"{rng.choice(JOURS_F)} à {heure}h" if fr else f"{rng.choice(JOURS_F)} at {heure}h"),
        "titre": rng.choice(["rappeler le client", "payer la facture", "préparer la réunion",
                             "valider le devis", "renouveler le stock", "call the client", "pay the invoice"]),
        "title": rng.choice(["call the client", "pay the invoice", "review the quote"]),
        "quand": f"demain {heure}h" if fr else f"tomorrow {heure}h",
        "destinataire": rng.choice(DESTINATAIRES), "recipient": rng.choice(DESTINATAIRES),
        "objet": rng.choice(["Suivi de dossier", "Facture en retard", "Confirmation de rendez-vous",
                             "Proposition commerciale", "Case follow-up", "Late invoice", "Meeting confirmation"]),
        "subject": rng.choice(["Case follow-up", "Late invoice", "Meeting confirmation"]),
        "corps": rng.choice(["Merci pour votre retour.", "Pouvez-vous confirmer le créneau ?", "Le document est joint."]),
        "body": rng.choice(["Thanks for your reply.", "Can you confirm the slot?", "Document attached."]),
        "debut": f"2026-{mois:02d}-{jour:02d}T{heure}:00", "start": f"2026-{mois:02d}-{jour:02d}T{heure}:00",
        "fin": f"2026-{mois:02d}-{jour:02d}T{heure + 1}:00", "end": f"2026-{mois:02d}-{jour:02d}T{heure + 1}:00",
        "terme": rng.choice(PRODUITS_FR if fr else PRODUITS_EN), "term": rng.choice(PRODUITS_EN),
        "prix_max": rng.choice(MONTANTS), "max_price": rng.choice(MONTANTS),
        "produit_id": f"SKU-{rng.randint(1000, 9999)}", "product_id": f"SKU-{rng.randint(1000, 9999)}",
        "quantite": rng.randint(1, 20), "quantity": rng.randint(1, 20),
        "salle": rng.choice(["Baobab", "Kora", "Sahel", "Wouri", "Manding"]), "room": rng.choice(["Baobab", "Kora", "Sahel", "Wouri"]),
        "creneau": f"{heure}h-{heure + 1}h" if fr else f"{heure}-{heure + 1}h", "slot": f"{heure}-{heure + 1}",
        "montant": rng.choice(MONTANTS), "amount": rng.choice(MONTANTS),
        "depuis": rng.choice(["FCFA", "EUR", "USD"]), "from": rng.choice(["FCFA", "EUR", "USD"]),
        "vers": rng.choice(["EUR", "USD", "FCFA"]), "to": rng.choice(["EUR", "USD", "FCFA"]),
        "dossier": rng.choice(["documents/factures", "rapports/2026", "contrats/clients", "invoices/2026"]),
        "folder": rng.choice(["documents/invoices", "reports/2026", "contracts/clients"]),
        "origine": ville, "origin": ville,
        "destination": rng.choice([v for v in (VILLES_FR if fr else CITIES_EN) if v != ville]),
        "mode": rng.choice(["voiture", "train", "bus", "car", "train", "bus"]),
        "adresse": f"{rng.randint(1, 200)} rue du Marché, {ville}", "address": f"{rng.randint(1, 200)} Market Street, {ville}",
    }
    valeurs = {a: str(vals[a]) for a in args}
    import json as _json
    appel = _json.dumps({"outil": nom, "arguments": valeurs}, ensure_ascii=False) if fr else \
            _json.dumps({"tool": nom, "arguments": valeurs}, ensure_ascii=False)
    if fr:
        inp = f"Transforme en appel d'outil JSON : « {nom.replace('_', ' ')} — {', '.join(args)} »."
        out = f"```json\n{appel}\n```\nAucun champ inventé : toute donnée manquante doit être demandée à l'utilisateur."
    else:
        inp = f"Turn into a JSON tool call: \"{nom.replace('_', ' ')} — {', '.join(args)}\"."
        out = f"```json\n{appel}\n```\nNo invented fields: any missing data must be asked to the user."
    return {"task_type": "tool_call_json", "language": "fr" if fr else "en",
            "instruction": "Émets UNIQUEMENT l'appel d'outil JSON attendu." if fr
            else "Emit ONLY the expected JSON tool call.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

JOURS_F = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"]

def fab_chaine_outils(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    ville = rng.choice(VILLES_FR if fr else CITIES_EN)
    produit = rng.choice(PRODUITS_FR if fr else PRODUITS_EN)
    heure = rng.randint(8, 17)
    if fr:
        inp = (f"Planifier : « trouve le {produit} le moins cher à {ville}, réserve une salle si le prix "
               f"dépasse le budget, puis crée un rappel pour comparer {rng.choice(JOURS_F)} à {heure}h. »")
        out = ("Ordre d'appels :\n"
               '1. {"outil": "rechercher_produit", "arguments": {"terme": "' + produit + '", "prix_max": null}}\n'
               '2. {"outil": "reserver_salle", "arguments": {"salle": "<à confirmer>", "creneau": "<selon budget>"}} — CONDITIONNEL (prix > budget)\n'
               f'3. {{"outil": "creer_rappel", "arguments": {{"titre": "comparer les prix", "quand": "{rng.choice(JOURS_F)} {heure}h"}}}}\n'
               "Dépendances : l'étape 2 dépend du prix trouvé (1) ; l'étape 3 s'exécute dans tous les cas. "
               "Si (1) échoue : demander le produit, ne rien inventer.")
    else:
        inp = (f"Plan: \"find the cheapest {produit} in {ville}, book a room if the price exceeds the budget, "
               f"then set a reminder to compare {rng.choice(JOURS_F)} at {heure}.\"")
        out = ("Call order:\n"
               '1. {"tool": "search_product", "arguments": {"term": "' + produit + '", "max_price": null}}\n'
               '2. {"tool": "book_room", "arguments": {"room": "<to confirm>", "slot": "<per budget>"}} — CONDITIONAL (price > budget)\n'
               f'3. {{"tool": "create_reminder", "arguments": {{"title": "compare prices", "when": "{rng.choice(JOURS_F)} {heure}"}}}}\n'
               "Dependencies: step 2 depends on the found price (1); step 3 always runs. "
               "If (1) fails: ask for the product, invent nothing.")
    return {"task_type": "tool_chain", "language": "fr" if fr else "en",
            "instruction": "Ordre des appels, conditions et repli honnête." if fr
            else "Call order, conditions and honest fallback.",
            "input": inp, "output": out, "difficulty": "avancé"}

FABRIQUES_TOOLS = [fab_appel_outil, fab_chaine_outils]

# ═══════════════════ rag_documents (20 000) — politiques PARAMÉTRÉES ═══════════════════

def fab_rag(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    delai = rng.choice([7, 10, 14, 21, 30])
    jours_remb = rng.choice([3, 5, 7, 10])
    mois_garantie = rng.choice([12, 24, 36])
    delai_livr = rng.choice([2, 3, 5, 7])
    heure_limite = rng.choice([14, 16, 18])
    duplicata_mois = rng.choice([12, 24, 36])
    if fr:
        passage = (f"[Politique commerciale — extraits]\n"
                   f"Retours : acceptés pendant {delai} jours après réception, produit non utilisé ; "
                   f"remboursement sous {jours_remb} jours ouvrés après contrôle.\n"
                   f"Garantie : {mois_garantie} mois sur les défauts de fabrication ; usage non conforme exclu.\n"
                   f"Livraison : {delai_livr} jours ouvrés en ville ; toute commande passée après {heure_limite} h "
                   f"part le jour suivant.\nFacturation : duplicata disponible pendant {duplicata_mois} mois.")
        questions = [
            (f"Quel est le délai de retour ?", f"{delai} jours après réception (produit non utilisé)."),
            (f"Quand serai-je remboursé après un retour accepté ?", f"Sous {jours_remb} jours ouvrés après contrôle."),
            (f"Combien de temps dure la garantie ?", f"{mois_garantie} mois sur les défauts de fabrication."),
            (f"Une commande passée à {heure_limite + 1} h part quand ?", f"Le jour suivant (seuil : {heure_limite} h)."),
            (f"Combien de temps peut-on demander un duplicata ?", f"Pendant {duplicata_mois} mois."),
            (f"Le délai de livraison en zone rurale est-il le même ?", None),
        ]
        question, bonne = rng.choice(questions)
        if bonne is not None:
            out = (f"Réponse (ancrée dans le passage) : {bonne}\n"
                   f"Je ne cite que ce que le passage contient — aucune extrapolation.")
        else:
            out = ("Non précisé dans le passage : il ne donne que le délai en ville "
                   f"({delai_livr} jours ouvrés) et le seuil d'expédition ({heure_limite} h). "
                   "Pour la zone rurale, consulter la politique complète ou le service client.")
    else:
        passage = (f"[Commercial policy — excerpts]\n"
                   f"Returns: accepted within {delai} days of delivery, unused product; "
                   f"refund within {jours_remb} business days after inspection.\n"
                   f"Warranty: {mois_garantie} months on manufacturing defects; non-compliant use excluded.\n"
                   f"Shipping: {delai_livr} business days in town; any order placed after {heure_limite} "
                   f"ships the next day.\nBilling: duplicates available for {duplicata_mois} months.")
        questions = [
            ("What is the return window?", f"{delai} days after delivery (unused product)."),
            ("When am I refunded after an accepted return?", f"Within {jours_remb} business days after inspection."),
            ("How long does the warranty last?", f"{mois_garantie} months on manufacturing defects."),
            (f"An order placed at {heure_limite + 1} ships when?", f"The next day (threshold: {heure_limite})."),
            ("How long can a duplicate be requested?", f"For {duplicata_mois} months."),
            ("Is the rural delivery delay the same?", None),
        ]
        question, bonne = rng.choice(questions)
        if bonne is not None:
            out = (f"Answer (grounded in the passage): {bonne}\n"
                   f"I only cite what the passage contains — no extrapolation.")
        else:
            out = ("Not stated in the passage: it only gives the in-town delay "
                   f"({delai_livr} business days) and the shipping threshold ({heure_limite}). "
                   "For rural areas, check the full policy or customer service.")
    return {"task_type": "grounded_qa", "language": "fr" if fr else "en",
            "instruction": "Réponds UNIQUEMENT à partir du passage ; si l'info n'y est pas, dis-le." if fr
            else "Answer ONLY from the passage; if the info is not in it, say so.",
            "input": f"{passage}\n\nQuestion : {question}" if fr else f"{passage}\n\nQuestion: {question}",
            "output": out, "difficulty": "intermédiaire",
            "metadata_extra": {"repondable": bonne is not None}}

FABRIQUES_RAG = [fab_rag]

# ═══════════════════ databases (15 000) ═══════════════════

# 12 tables structurées : (nom_fr, nom_en, colonne_catégorielle, valeurs, colonne_numérique, colonne_date)
TABLES_DB = [
    ("commandes", "orders", "ville", ("ville", VILLES_FR, CITIES_EN), "total", "date"),
    ("clients", "customers", "ville", ("ville", VILLES_FR, CITIES_EN), "points_fidelite", "inscription"),
    ("produits", "products", "categorie", ("catégorie", ["electronique", "maison", "bureau", "jardin"], ["electronics", "home", "office", "garden"]), "prix", None),
    ("factures", "invoices", "statut", ("statut", ["payee", "en_attente", "retard"], ["paid", "pending", "late"]), "montant", "emission"),
    ("livraisons", "shipments", "transporteur", ("transporteur", ["express", "standard", "eco"], ["express", "standard", "eco"]), "poids_kg", "expedition"),
    ("avis", "reviews", "note_type", ("type", ["produit", "service", "livraison"], ["product", "service", "delivery"]), "note", "publication"),
    ("emprunts", "loans", "secteur", ("secteur", ["roman", "essai", "jeunesse"], ["fiction", "essay", "youth"]), "duree_jours", "retour"),
    ("consultations", "visits", "specialite", ("spécialité", ["generaliste", "pediatrie", "chirurgie"], ["general", "pediatrics", "surgery"]), "duree_min", "jour"),
    ("notes", "scores", "matiere", ("matière", ["maths", "francais", "sciences"], ["math", "french", "science"]), "valeur", None),
    ("reservations", "bookings", "salle", ("salle", ["Baobab", "Kora", "Sahel"], ["Baobab", "Kora", "Sahel"]), "participants", "creneau"),
    ("stocks", "inventory", "entrepot", ("entrepôt", ["central", "nord", "port"], ["central", "north", "port"]), "quantite", "maj"),
    ("tickets", "tickets", "priorite", ("priorité", ["basse", "normale", "haute"], ["low", "normal", "high"]), "resolution_h", "ouverture"),
]
SCHEMAS_DOC = [
    ("boutique", "shop", ["clients(id, nom, ville)", "produits(id, nom, prix, stock)",
                          "commandes(id, client_id, date, total)", "lignes(id, commande_id, produit_id, quantite)"]),
    ("bibliotheque", "library", ["ouvrages(id, titre, auteur, annee)", "adherents(id, nom, ville)",
                                 "emprunts(id, ouvrage_id, adherent_id, date_retour)"]),
    ("clinique", "clinic", ["patients(id, nom, annee_naissance)", "medecins(id, nom, specialite)",
                            "consultations(id, patient_id, medecin_id, date, motif)"]),
    ("ecole", "school", ["eleves(id, nom, classe)", "cours(id, intitule, prof)",
                         "notes(id, eleve_id, cours_id, valeur)"]),
]

def fab_sql_schéma(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom_fr, nom_en, tables = rng.choice(SCHEMAS_DOC)
    t1, t2 = rng.sample(tables, k=2)
    t1n, t2n = t1.split('(')[0], t2.split('(')[0]
    cle = t2n + "_id"
    jointure = cle if cle in t1 else t1n + "_id" if (t1n + "_id") in t2 else "id"
    limite = rng.choice([5, 10, 20, 50, 100, 200, 500, 1000])
    sens = rng.choice(["DESC", "ASC"])
    if fr:
        inp = (f"Schéma « {nom_fr} » : {'; '.join(tables)}.\n"
               f"Question : compter les lignes de « {t1n} » liées à « {t2n} », top {limite}, tri {sens}.")
        out = (f"SELECT {t1n}.{jointure}, COUNT(*) AS total\n"
               f"FROM {t1n} JOIN {t2n} ON {t1n}.{jointure} = {t2n}.id\n"
               f"GROUP BY 1 ORDER BY total {sens} LIMIT {limite};\n"
               f"Colonnes citées d'après le schéma fourni — vérifier les noms exacts avant exécution.")
    else:
        inp = (f"Schema \"{nom_en}\": {'; '.join(tables)}.\n"
               f"Question: count rows of \"{t1n}\" linked to \"{t2n}\", top {limite}, {sens} sort.")
        out = (f"SELECT {t1n}.{jointure}, COUNT(*) AS total\n"
               f"FROM {t1n} JOIN {t2n} ON {t1n}.{jointure} = {t2n}.id\n"
               f"GROUP BY 1 ORDER BY total {sens} LIMIT {limite};\n"
               f"Columns cited from the given schema — verify exact names before running.")
    return {"task_type": "sql_join", "language": "fr" if fr else "en",
            "instruction": "SQL de lecture fiable ; citer seulement les colonnes du schéma." if fr
            else "Reliable read-only SQL; cite only schema columns.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

def fab_sql_agregat(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    t_fr, t_en, cat, (cat_fr, vals_fr, vals_en), num, date_col = rng.choice(TABLES_DB)
    tn = t_fr if fr else t_en
    col_cat = cat_fr if fr else cat
    valeur = rng.choice(vals_fr if fr else vals_en)
    agg = rng.choice(["SUM", "AVG", "MAX", "MIN", "COUNT"])
    limite = rng.choice([5, 10, 20, 50, 100, 200, 500, 1000])
    sens = rng.choice(["DESC", "ASC"])
    filtre = rng.random() < 0.5
    if filtre:
        if fr:
            inp = f"Table « {tn} » (colonnes : id, {col_cat}, {num}, {date_col or 'aucune date'}) : {agg}({num}) pour {col_cat} = '{valeur}', limite {limite}."
            out = (f"SELECT {col_cat}, {agg}({num}) AS resultat\nFROM {tn}\n"
                   f"WHERE {col_cat} = '{valeur}'\nGROUP BY {col_cat} LIMIT {limite};\n"
                   f"Index conseillé : ({col_cat}, {num}).")
        else:
            inp = f"Table \"{tn}\" (columns: id, {col_cat}, {num}, {date_col or 'no date'}): {agg}({num}) for {col_cat} = '{valeur}', limit {limite}."
            out = (f"SELECT {col_cat}, {agg}({num}) AS resultat\nFROM {tn}\n"
                   f"WHERE {col_cat} = '{valeur}'\nGROUP BY {col_cat} LIMIT {limite};\n"
                   f"Suggested index: ({col_cat}, {num}).")
    else:
        if fr:
            inp = f"Table « {tn} » : {agg}({num}) par {col_cat}, toutes valeurs confondues, top {limite}, tri {sens}."
            out = (f"SELECT {col_cat}, {agg}({num}) AS resultat\nFROM {tn}\n"
                   f"GROUP BY {col_cat} ORDER BY resultat {sens} LIMIT {limite};\n"
                   f"Index conseillé : ({col_cat}, {num}) si la table grossit.")
        else:
            inp = f"Table \"{tn}\": {agg}({num}) per {col_cat}, all values, top {limite}, {sens} sort."
            out = (f"SELECT {col_cat}, {agg}({num}) AS resultat\nFROM {tn}\n"
                   f"GROUP BY {col_cat} ORDER BY resultat {sens} LIMIT {limite};\n"
                   f"Suggested index: ({col_cat}, {num}) as the table grows.")
    return {"task_type": "sql_aggregate", "language": "fr" if fr else "en",
            "instruction": "Agrégation lisible + index conseillé." if fr else "Readable aggregation + suggested index.",
            "input": inp, "output": out, "difficulty": "facile"}

def fab_sql_seuil(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    t_fr, t_en, cat, (cat_fr, vals_fr, vals_en), num, date_col = rng.choice(TABLES_DB)
    tn = t_fr if fr else t_en
    seuil = rng.choice([10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000])
    limite = rng.choice([5, 10, 20, 50, 100, 200, 500, 1000])
    sens = rng.choice(["DESC", "ASC"])
    op = rng.choice([">=", ">", "<=", "<"])
    if fr:
        inp = f"Table « {tn} » : lister les lignes où {num} {op} {seuil:,}, triées par {num} {sens}, limite {limite}."
        out = (f"SELECT * FROM {tn}\nWHERE {num} {op} {seuil:,}\n"
               f"ORDER BY {num} {sens} LIMIT {limite};\n"
               f"Index conseillé : ({num}) — vérifier le plan EXPLAIN sur un échantillon.")
    else:
        inp = f"Table \"{tn}\": list rows where {num} {op} {seuil:,}, sorted by {num} {sens}, limit {limite}."
        out = (f"SELECT * FROM {tn}\nWHERE {num} {op} {seuil:,}\n"
               f"ORDER BY {num} {sens} LIMIT {limite};\n"
               f"Suggested index: ({num}) — check the EXPLAIN plan on a sample.")
    return {"task_type": "sql_filter", "language": "fr" if fr else "en",
            "instruction": "Requête filtrée triée + index conseillé." if fr else "Filtered sorted query + suggested index.",
            "input": inp, "output": out, "difficulty": "facile"}

def fab_sql_date(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    t_fr, t_en, cat, (cat_fr, vals_fr, vals_en), num, date_col = rng.choice(
        [t for t in TABLES_DB if t[5] is not None])
    tn = t_fr if fr else t_en
    annee = rng.choice([2024, 2025, 2026])
    agg = rng.choice(["COUNT", "SUM", "AVG"])
    limite = rng.choice([5, 10, 20, 50, 100])
    if fr:
        inp = f"Table « {tn} » : {agg}({num if agg != 'COUNT' else '*'}) pour l'année {annee} (colonne {date_col}), top {limite} par {cat_fr}."
        out = (f"SELECT {cat_fr}, {agg}({num if agg != 'COUNT' else '*'}) AS resultat\nFROM {tn}\n"
               f"WHERE {date_col} >= '{annee}-01-01' AND {date_col} < '{annee + 1}-01-01'\n"
               f"GROUP BY {cat_fr} ORDER BY resultat DESC LIMIT {limite};\n"
               f"Index conseillé : ({date_col}) — la plage d'années reste sargable.")
    else:
        inp = f"Table \"{tn}\": {agg}({num if agg != 'COUNT' else '*'}) for year {annee} (column {date_col}), top {limite} per {cat}."
        out = (f"SELECT {cat}, {agg}({num if agg != 'COUNT' else '*'}) AS resultat\nFROM {tn}\n"
               f"WHERE {date_col} >= '{annee}-01-01' AND {date_col} < '{annee + 1}-01-01'\n"
               f"GROUP BY {cat} ORDER BY resultat DESC LIMIT {limite};\n"
               f"Suggested index: ({date_col}) — the year range stays sargable.")
    return {"task_type": "sql_temporal", "language": "fr" if fr else "en",
            "instruction": "Filtre temporel sargable + agrégation." if fr else "Sargable time filter + aggregation.",
            "input": inp, "output": out, "difficulty": "intermédiaire"}

FABRIQUES_DB = [fab_sql_schéma, fab_sql_agregat, fab_sql_seuil, fab_sql_date]
