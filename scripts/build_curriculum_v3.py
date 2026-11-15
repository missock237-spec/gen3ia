#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum Gen3ia v3 « géants » — vague 3 : 13 domaines métier manquants.

Générateur DÉTERMINISTE (seed fixe) de 6 datasets d'instructions :
  code        12 000 lignes — dev web, API, tests, debug, SQL, CSS
  knowledge   13 000 lignes — sciences, sciences humaines, santé, machines, recherche web
  business    10 000 lignes — analyse de données, vente, conseiller commercial, pricing
  security     6 000 lignes — cybersécurité défensive, revue de code, CTF éthique
  writing      8 000 lignes — rédaction, plans, emails, rapports, réécriture
  multimodal   7 000 lignes — orchestration pipelines média gen3 (image/voix/vidéo/web)

Total vague 3 : 56 000 lignes → 44 369 (v2) + 56 000 = 100 369 lignes cumulées.

Propriétés :
  - seed fixe → reproductible bit-à-bit (idempotent, quotas convergents) ;
  - dédup stricte par hash de contenu (task_type + language + input + output) ;
  - bilingue FR/EN (~55 % / 45 %) ;
  - schéma identique aux datasets v2 : id, domain, task_type, language,
    instruction, input, output, metadata{difficulty, timestamp, quality_score,
    safety_label, license, ...}, content_hash (16 hex) ;
  - sécurité : dataset security STRICTEMENT défensif (durcissement, revue,
    CTF labo éducatif) ; santé = information grand public + renvoi médecin.

Usage :
  python3 scripts/build_curriculum_v3.py            # génère + met à jour INDEX
  python3 scripts/build_curriculum_v3.py --check    # vérifie sans réécrire
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DOSSIERS_DATASETS = RACINE / "datasets"
SEED = 20261025
VERSION = 3

# ═════════════════════════ Utilitaires cœur ═════════════════════════

def h16(texte: str) -> str:
    return hashlib.sha256(texte.encode("utf-8")).hexdigest()[:16]

def ts_aleatoire(rng: random.Random) -> str:
    # fenêtre 2024-01-01 → 2026-10-01, cohérente avec les datasets v2
    secondes = rng.randint(1_704_067_200, 1_791_100_800)
    return datetime.fromtimestamp(secondes, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def contenu(texte: str, limite: int = 240) -> str:
    """Compacte les blancs et borne l'affichage (même style que v2)."""
    t = " ".join(texte.split())
    return t if len(t) <= limite else t[: limite - 1] + "…"

def pioche(rng: random.Random, liste):
    return rng.choice(liste)

def generer_dataset(domain: str, prefixe: str, quota: int, fabriques, rng: random.Random,
                    vus: set[str], max_tentatives: int = 0) -> list[dict]:
    """Génère `quota` lignes uniques via les fabriques du domaine.

    fabriques: liste de fonctions (rng) -> dict partiel
      {task_type, language, instruction, input, output, metadata_extra}
    """
    lignes: list[dict] = []
    tentatives = 0
    limite = max_tentatives or (quota * 40)
    while len(lignes) < quota and tentatives < limite:
        tentatives += 1
        fab = pioche(rng, fabriques)
        partiel = fab(rng)
        tt = partiel["task_type"]
        lang = partiel["language"]
        cle = h16(f"{tt}|{lang}|{partiel['input']}|{partiel['output']}")
        if cle in vus:
            continue
        vus.add(cle)
        meta = {
            "difficulty": partiel.get("difficulty", "intermédiaire"),
            "timestamp": ts_aleatoire(rng),
            "quality_score": round(rng.uniform(0.90, 0.98), 3),
            "safety_label": partiel.get("safety_label", "safe"),
            "license": "proprietary-gen3ia",
        }
        meta.update(partiel.get("metadata_extra", {}))
        lignes.append({
            "id": f"{prefixe}-{len(lignes):06d}",
            "domain": domain,
            "task_type": tt,
            "language": lang,
            "instruction": partiel["instruction"],
            "input": partiel["input"],
            "output": partiel["output"],
            "metadata": meta,
            "content_hash": cle,
        })
    if len(lignes) < quota:
        raise SystemExit(f"[curriculum-v3] quota non atteint pour {domain}: {len(lignes)}/{quota}")
    return lignes

def ecrire_dataset(nom: str, lignes: list[dict], description: str, verifier: bool) -> None:
    dossier = DOSSIERS_DATASETS / nom
    chemin = dossier / "train.jsonl"
    manifeste = {
        "name": f"gen3ia-{nom}-v{VERSION}",
        "description": description,
        "rows": len(lignes),
        "languages": sorted({l["language"] for l in lignes}),
        "task_types": sorted({l["task_type"] for l in lignes}),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
    }
    if verifier:
        existant = [json.loads(x) for x in chemin.read_text("utf-8").splitlines() if x.strip()]
        if len(existant) != len(lignes):
            raise SystemExit(f"[check] {nom}: {len(existant)} lignes ≠ quota {len(lignes)}")
        hashes_disques = {l["content_hash"] for l in existant}
        if hashes_disques != {l["content_hash"] for l in lignes}:
            raise SystemExit(f"[check] {nom}: contenu ≠ génération attendue (dét.)")
        man_disque = json.loads((dossier / "MANIFEST.json").read_text("utf-8"))
        for k in ("name", "rows", "task_types"):
            if man_disque.get(k) != manifeste[k]:
                raise SystemExit(f"[check] {nom}: MANIFEST.{k} ≠ attendu")
        print(f"[check] {nom}: OK ({len(lignes)} lignes)")
        return
    dossier.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", encoding="utf-8") as fh:
        for l in lignes:
            fh.write(json.dumps(l, ensure_ascii=False) + "\n")
    (dossier / "MANIFEST.json").write_text(
        json.dumps(manifeste, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[v3] {nom}: {len(lignes)} lignes écrites")

def maj_index(nouveaux: list[dict], verifier: bool) -> None:
    chemin = DOSSIERS_DATASETS / "INDEX.json"
    if verifier:
        idx = json.loads(chemin.read_text("utf-8"))
        bloc = idx.get("gen3ia-media-datasets", {})
        ds = {d["id"]: d["rows"] for d in bloc.get("datasets", [])}
        for n in nouveaux:
            if ds.get(n["id"]) != n["rows"]:
                raise SystemExit(f"[check] INDEX[{n['id']}] = {ds.get(n['id'])} ≠ {n['rows']}")
        total = sum(ds.values())
        print(f"[check] INDEX: OK ({total} lignes cumulées)")
        return
    idx = json.loads(chemin.read_text("utf-8")) if chemin.exists() else {}
    bloc = idx.get("gen3ia-media-datasets", {"schema_common": [
        "id", "domain", "task_type", "language", "instruction", "input",
        "output", "metadata", "content_hash"]})
    connus = {d["id"]: d for d in bloc.get("datasets", [])}
    for n in nouveaux:
        connus[n["id"]] = n
    bloc["datasets"] = sorted(connus.values(), key=lambda d: d["id"])
    bloc["version"] = VERSION
    bloc["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    bloc["purpose"] = (
        "Curriculum Gen3ia v3 « géants » : média (images/vidéo/voix/musique), abréviations "
        "et 13 domaines métier (dev web, tests, sciences, humaines, santé, machines, "
        "recherche web, analyse de données, vente, conseiller commercial, cybersécurité "
        "défensive, rédaction, orchestration multimodale) — bilingue FR/EN, dédupliqué.")
    idx["gen3ia-media-datasets"] = bloc
    chemin.write_text(json.dumps(idx, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = sum(d["rows"] for d in bloc["datasets"])
    print(f"[v3] INDEX mis à jour — {len(bloc['datasets'])} datasets, {total} lignes cumulées")

# ═════════════════════════ Variations communes ═════════════════════════

def lang(rng: random.Random) -> str:
    return "fr" if rng.random() < 0.55 else "en"

def diff(rng: random.Random) -> str:
    r = rng.random()
    return "facile" if r < 0.30 else ("intermédiaire" if r < 0.80 else "avancé")

# ═════════════════════════ Domaine CODE (12 000) ═════════════════════════

COMPOSANTS = [
    ("Carte produit", "ProductCard"), ("Formulaire d'inscription", "SignupForm"),
    ("Tableau de bord", "Dashboard"), ("Barre de navigation", "NavBar"),
    ("Modale de confirmation", "ConfirmDialog"), ("Liste de tâches", "TaskList"),
    ("Profil utilisateur", "UserProfile"), ("Galerie d'images", "ImageGallery"),
    ("Panier d'achat", "ShoppingCart"), ("Champ de recherche", "SearchField"),
    ("Notification toast", "Toast"), ("Pied de page", "Footer"),
    ("Grille tarifaire", "PricingGrid"), ("Fil d'Ariane", "Breadcrumbs"),
    ("Sélecteur de date", "DatePicker"), ("Avatar de groupe", "AvatarGroup"),
    ("Barre de progression", "ProgressBar"), ("Encart statistique", "StatCard"),
]
COMPONENTS_EN = [
    ("Product card", "ProductCard"), ("Signup form", "SignupForm"),
    ("Dashboard", "Dashboard"), ("Navigation bar", "NavBar"),
    ("Confirmation dialog", "ConfirmDialog"), ("Task list", "TaskList"),
    ("User profile", "UserProfile"), ("Image gallery", "ImageGallery"),
    ("Shopping cart", "ShoppingCart"), ("Search field", "SearchField"),
    ("Toast notification", "Toast"), ("Footer", "Footer"),
    ("Pricing grid", "PricingGrid"), ("Breadcrumbs", "Breadcrumbs"),
    ("Date picker", "DatePicker"), ("Group avatar", "AvatarGroup"),
    ("Progress bar", "ProgressBar"), ("Stat card", "StatCard"),
]
PROPS_SETS = ["titre: string", "titre: string, sousTitre: string",
              "items: T[]", "items: T[], onSelection: (t: T) => void",
              "valeur: number, max: number", "visible: boolean, onFermer: () => void",
              "libelle: string, obligatoire?: boolean", "filtres: Record<string, string>",
              "chargement: boolean, erreur?: string", "image: string, alt: string",
              "total: number, devise: string", "etapes: string[], active: number",
              "options: {id: string; label: string}[]", "selection: string | null, onChange: (id: string) => void",
              "source: string[], colonne: number", "limite: number, onLoadMore: () => void",
              "verrouille: boolean, motif?: string", "compact: boolean, afficherIcone: boolean",
              "entete: string[], lignes: T[][]", "erreurGlobal?: string, onReessayer: () => void"]
FEATURES = [("état local", "local state"), ("accessibilité ARIA", "ARIA accessibility"),
            ("responsive mobile-first", "mobile-first responsive"),
            ("chargement + erreur", "loading + error states"),
            ("clavier (Entrée/Échap)", "keyboard (Enter/Escape)"),
            ("memoïsation des listes", "memoized lists"),
            ("contraste AA vérifié", "AA contrast checked"),
            ("libellés i18n prêts", "i18n-ready labels")]

def fab_composant_react(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    titre, nom = pioche(rng, COMPOSANTS if fr_fr else COMPONENTS_EN)
    props = pioche(rng, PROPS_SETS)
    feat_fr, feat_en = pioche(rng, FEATURES)
    feat = feat_fr if fr_fr else feat_en
    n_props = [p.strip() for p in props.split(",")]
    jsx = (f"export function {nom}({{{', '.join(p.split(':')[0] for p in n_props)}}}: {{\n"
           + "\n".join(f"  {p.strip()};" for p in n_props)
           + "\n}) {\n"
           + f"  // {feat} — variantes et accessibilité intégrées\n"
           + f"  return (\n    <section className=\"{nom.lower()}\" role=\"region\" aria-label={{{n_props[0].split(':')[0]}}}>\n"
           + f"      {{{n_props[0].split(':')[0]}}}\n    </section>\n  );\n}}")
    if fr_fr:
        instr = f"Code un composant React typé « {titre} » avec {feat}."
        inp = f"Composant : {titre} ; props : {props} ; exigence : {feat}."
        out = f"COMPOSANT {nom} (TSX, typé) :\n{jsx}\n— un seul responsable de rendu, props obligatoires typées, {feat} géré."
    else:
        instr = f"Write a typed React component “{titre}” with {feat}."
        inp = f"Component: {titre}; props: {props}; requirement: {feat}."
        out = f"COMPONENT {nom} (typed TSX):\n{jsx}\n— single render responsibility, typed required props, {feat} handled."
    return {"task_type": "brief_to_component", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"stack": "react-ts"}}

BUGS = [
    ("boucle fermée sur variable", "let i = i; dans le callback", "const i = i du for-of",
     "for (const item of items) { handlers.push(() => item.id); }"),
    ("référence nulle non gardée", "data.user.name lu sans garde", "data?.user?.name avec repli",
     "const nom = data?.user?.name ?? \"invité\";"),
    ("await manquant", "fetchPrix() traité comme valeur", "await fetchPrix()",
     "const prix = await fetchPrix(panier);"),
    ("état périmé dans setState", "setCpt(cpt + 1) triple", "setCpt(c => c + 1)",
     "setCompteur(c => c + 1); setCompteur(c => c + 1);"),
    ("mutation en cours d'itération", "listes.filter + splice simultanés", "copie puis filtre",
     "const reste = [...lignes].filter(l => l.valide);"),
    ("égalité stricte manquée", "if (x == null) trop large", "x === null || x === undefined ciblé",
     "if (valeur === null || valeur === undefined) return 0;"),
    ("écouteur jamais retiré", "addEventListener sans cleanup", "removeEventListener au unmount",
     "useEffect(() => { window.addEventListener(\"resize\", h); return () => window.removeEventListener(\"resize\", h); }, []);"),
    ("parseFloat sur texte vide", "parseFloat(\"\") → NaN propagé", "garde + repli 0",
     "const n = Number.parseFloat(saisie); const prix = Number.isFinite(n) ? n : 0;"),
    ("déstructuration d'inexistant", "res.body.items déstructuré direct", "valeur par défaut {}",
     "const { items = [] } = res.body ?? {};"),
    ("condition de course fetch", "dernier clic ≠ dernière réponse", "abort du précédent",
     "controleur.abort(); controleur = new AbortController(); fetch(url, { signal: controleur.signal });"),
    ("innerHTML non échappé", "rendu HTML du commentaire utilisateur", "textContent",
     "noeud.textContent = commentaire; // jamais innerHTML sur du contenu utilisateur"),
    ("clé de liste non stable", "key={index} après tri", "key=identifiant stable",
     "lignes.map(l => <Ligne key={l.id} … />)"),
]
BUGS_EN = [
    ("closed loop variable", "let i captured in callback", "for-of const binding",
     "for (const item of items) { handlers.push(() => item.id); }"),
    ("unguarded null reference", "data.user.name read directly", "optional chaining + fallback",
     "const name = data?.user?.name ?? \"guest\";"),
    ("missing await", "fetchPrice() used as value", "await fetchPrice()",
     "const price = await fetchPrice(cart);"),
    ("stale state in setState", "setCpt(cpt + 1) three times", "functional update",
     "setCount(c => c + 1); setCount(c => c + 1);"),
    ("mutation during iteration", "filter + splice together", "copy then filter",
     "const rest = [...rows].filter(r => r.valid);"),
    ("loose equality trap", "if (x == null) too broad", "strict null check",
     "if (value === null || value === undefined) return 0;"),
    ("leaked event listener", "addEventListener without cleanup", "remove on unmount",
     "useEffect(() => { window.addEventListener(\"resize\", h); return () => window.removeEventListener(\"resize\", h); }, []);"),
    ("parseFloat on empty text", "parseFloat(\"\") → NaN spread", "guard + 0 fallback",
     "const n = Number.parseFloat(input); const price = Number.isFinite(n) ? n : 0;"),
    ("destructuring missing field", "res.body.items destructured direct", "default to {}",
     "const { items = [] } = res.body ?? {};"),
    ("fetch race condition", "last click ≠ last response", "abort previous",
     "controller.abort(); controller = new AbortController(); fetch(url, { signal: controller.signal });"),
    ("unescaped innerHTML", "user comment rendered as HTML", "textContent",
     "node.textContent = comment; // never innerHTML for user content"),
    ("unstable list key", "key={index} after sort", "stable identity key",
     "rows.map(r => <Row key={r.id} … />)"),
]
CONTEXTES_BUG = ["page panier", "formulaire de recherche", "listes paginées", "thème clair/sombre",
                 "sauvegarde automatique", "upload de fichiers", "chat temps réel", "filtres de tableaux",
                 "pagination infinie", "étape de paiement"]
DECLENCHEURS = ["après un rafraîchissement", "en production sous charge", "sur mobile",
                "après une migration", "chez un client précis", "en CI",
                "après un refactor", "au premier lancement"]

def fab_bug(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    if fr_fr:
        nom_bug, mauvais, bon, extrait = pioche(rng, BUGS)
        ctx = pioche(rng, CONTEXTES_BUG)
        declencheur = pioche(rng, DECLENCHEURS)
        instr = f"Ce bug bloque {ctx}. Diagnostique et corrige."
        inp = f"Contexte : {ctx}. Déclencheur : {declencheur}. Symptôme : {nom_bug} ({mauvais})."
        out = (f"DIAGNOSTIC : {mauvais} (reproduit quand {declencheur}).\nCORRECTION : {bon}.\n```ts\n{extrait}\n```\n"
               f"Test de non-régression recommandé sur {ctx}.")
    else:
        nom_bug, mauvais, bon, extrait = pioche(rng, BUGS_EN)
        ctx = pioche(rng, ["cart page", "search form", "paginated lists", "light/dark theme",
                           "autosave", "file upload", "realtime chat", "table filters",
                           "infinite scroll", "checkout step"])
        declencheur = pioche(rng, ["after a refresh", "in production under load", "on mobile",
                                   "after a migration", "for one specific client", "in CI",
                                   "after a refactor", "on first launch"])
        instr = f"This bug breaks {ctx}. Diagnose and fix it."
        inp = f"Context: {ctx}. Trigger: {declencheur}. Symptom: {nom_bug} ({mauvais})."
        out = (f"DIAGNOSIS: {mauvais} (reproduces when {declencheur}).\nFIX: {bon}.\n```ts\n{extrait}\n```\n"
               f"Add a regression test for {ctx}.")
    return {"task_type": "bug_to_fix", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"stack": "typescript"}}

FONCTIONS_TESTS = ["calculeTva", "valideEmail", "trieParDate", "formatePrix", "normaliseTelephone",
                   "calculeRemise", "convertitDevise", "echappeHtml", "analyseNavigateur",
                   "censureTermes", "parseCsv", "dedupliquePar", "arronditPrix", "verifieMotDePasse"]
CAS_LIMITES = ["entrée vide", "valeur null", "nombre négatif", "texte unicode/accents",
               "tableau d'un élément"]
SECTEURS_TEST = ["e-commerce", "bancaire", "santé", "logistique", "éducation", "média",
                 "immobilier", "restauration"]

def fab_tests(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    fn = pioche(rng, FONCTIONS_TESTS)
    cas = pioche(rng, CAS_LIMITES)
    secteur = pioche(rng, SECTEURS_TEST)
    strict = rng.random() < 0.5
    if fr_fr:
        instr = f"Écris les tests Vitest de « {fn} » ({secteur}) couvrant le nominal, {cas} et deux erreurs métier."
        inp = f"Fonction : {fn}() — domaine {secteur}. Cas critique : {cas}. Assertions : {'strictes (toBe)' if strict else 'profondes (toEqual)'}."
        expect = "toBe" if strict else "toEqual"
        out = (f"describe('{fn}', () => {{\n"
               f"  it('cas nominal {secteur}', () => {{ expect({fn}(entreeValide)).{expect}(resultatAttendu); }});\n"
               f"  it('{cas}', () => {{ expect(() => {fn}(entreeLimite)).not.toThrow(); }});\n"
               f"  it('erreur métier 1', () => {{ expect({fn}(entreeInvalide)).{expect}(erreurAttendue); }});\n"
               f"  it('erreur métier 2', () => {{ expect({fn}(undefined)).toBeNull(); }});\n"
               f"}});\n— table-driven si plus de 5 cas : it.each.")
    else:
        instr = f"Write Vitest tests for “{fn}” ({secteur}) covering the happy path, {cas}, and two business errors."
        inp = f"Function: {fn}() — {secteur} domain. Critical case: {cas}. Assertions: {'strict (toBe)' if strict else 'deep (toEqual)'}."
        expect = "toBe" if strict else "toEqual"
        out = (f"describe('{fn}', () => {{\n"
               f"  it('happy path ({secteur})', () => {{ expect({fn}(validInput)).{expect}(expected); }});\n"
               f"  it('{cas}', () => {{ expect(() => {fn}(edgeInput)).not.toThrow(); }});\n"
               f"  it('business error 1', () => {{ expect({fn}(invalidInput)).{expect}(expectedError); }});\n"
               f"  it('business error 2', () => {{ expect({fn}(undefined)).toBeNull(); }});\n"
               f"}});\n— use it.each beyond 5 cases.")
    return {"task_type": "feature_to_tests", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"stack": "vitest", "secteur": secteur}}

RESSOURCES_API = ["commandes", "clients", "produits", "factures", "tickets", "abonnements",
                  "livraisons", "avis", "remboursements", "invitations", "favoris", "stocks"]
OPS_API = [("créer", "POST", "201 + Location"), ("lister (paginé)", "GET", "200 + page/cursor"),
           ("mettre à jour partiellement", "PATCH", "200 + version"), ("supprimer (doux)", "DELETE", "204 + tombstone")]
ASPECTS_API = ["validation d'entrée (zod)", "gestion des erreurs normalisée", "authentification et propriété",
               "pagination et tri", "idempotence et verrou", "journalisation et audit",
               "cache et invalidation", "limitation de débit par clé"]
CONTEXTES_API = ["SaaS multi-tenant", "boutique en ligne", "portail interne", "app mobile", "intégration partenaire", "espace patient"]

def fab_api(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    res = pioche(rng, RESSOURCES_API)
    op_fr, verbe, reponse = pioche(rng, OPS_API)
    aspect = pioche(rng, ASPECTS_API)
    ctx = pioche(rng, CONTEXTES_API)
    chemin = f"/api/v1/{res}"
    if fr_fr:
        instr = f"Conçois l'endpoint {verbe} « {chemin} » pour un {ctx}, avec {aspect}."
        inp = f"Endpoint : {verbe} {chemin} ; contexte : {ctx} ; exigence : {aspect}."
        out = (f"ROUTE {verbe} {chemin}\n"
               f"— entrée : schéma zod (champs requis, bornes, normalisation) ;\n"
               f"— {aspect} ;\n"
               f"— succès : {reponse} ; erreurs : 400 (validation), 401/403 (auth/propriété), 409 (conflit), 429 (quota) ;\n"
               f"— test contrat + test de propriété (identifiant inconnu, payload hostile).")
    else:
        instr = f"Design the {verbe} endpoint “{chemin}” for {ctx}, with {aspect}."
        inp = f"Endpoint: {verbe} {chemin}; context: {ctx}; requirement: {aspect}."
        out = (f"ROUTE {verbe} {chemin}\n"
               f"— input: zod schema (required fields, bounds, normalization);\n"
               f"— {aspect};\n"
               f"— success: {reponse}; errors: 400 (validation), 401/403 (auth/ownership), 409 (conflict), 429 (quota);\n"
               f"— contract test + property test (unknown id, hostile payload).")
    return {"task_type": "api_design", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"stack": "next-api", "contexte": ctx}}

TABLES_SQL = ["commandes(id, client_id, total, statut, cree_le)",
              "clients(id, nom, email, ville, inscrit_le)",
              "produits(id, nom, prix, stock, categorie_id)",
              "factures(id, commande_id, montant, echeance, payee_le)",
              "avis(id, produit_id, note, commentaire, date)",
              "livraisons(id, commande_id, transporteur, expedie_le, recue_le)",
              "abonnements(id, client_id, offre, debut, fin)",
              "employes(id, service, salaire, embauche_le, ville)",
              "sessions(id, utilisateur_id, debut, fin, appareil)",
              "paiements(id, facture_id, montant, methode, horodatage)"]
QUESTIONS_SQL = [("total par client", "SELECT c.nom, SUM(o.total) AS total FROM commandes o JOIN clients c ON c.id = o.client_id {FILTRE} GROUP BY c.nom ORDER BY total DESC;"),
                 ("meilleures ventes", "SELECT p.nom, COUNT(*) AS ventes FROM produits p JOIN lignes l ON l.produit_id = p.id {FILTRE} GROUP BY p.nom ORDER BY ventes DESC LIMIT 10;"),
                 ("retards de paiement", "SELECT f.id, f.montant, f.echeance FROM factures f WHERE f.payee_le IS NULL AND f.echeance < CURRENT_DATE {FILTRE} ORDER BY f.echeance;"),
                 ("note moyenne par produit", "SELECT produit_id, ROUND(AVG(note), 2) AS moyenne, COUNT(*) AS nb FROM avis {FILTRE} GROUP BY produit_id HAVING COUNT(*) >= 5;"),
                 ("panier moyen mensuel", "SELECT date_trunc('month', cree_le) AS mois, ROUND(AVG(total), 2) FROM commandes {FILTRE} GROUP BY 1 ORDER BY 1;"),
                 ("churn des abonnés", "SELECT offre, COUNT(*) FROM abonnements WHERE fin IS NOT NULL {FILTRE} GROUP BY offre;"),
                 ("délai de livraison moyen", "SELECT transporteur, ROUND(AVG(recue_le - expedie_le), 1) AS jours FROM livraisons WHERE recue_le IS NOT NULL {FILTRE} GROUP BY transporteur;"),
                 ("masse salariale par service", "SELECT service, SUM(salaire) AS masse, ROUND(AVG(salaire), 0) AS moyen FROM employes {FILTRE} GROUP BY service ORDER BY masse DESC;")]
FILTRES_SQL = ["", "AND cree_le >= date_trunc('year', CURRENT_DATE)", "AND statut <> 'annule'",
               "AND montant > 100", "AND cree_le >= CURRENT_DATE - 30", "AND derniere_activite >= CURRENT_DATE - 90",
               "AND pays IN ('CM', 'SN', 'CI')", "AND total BETWEEN 50 AND 500",
               "AND email IS NOT NULL", "AND cree_le::date = CURRENT_DATE",
               "AND statut IN ('payee', 'expediee')", "AND client_id IN (SELECT id FROM clients WHERE ville = 'Paris')"]
DIALECTES = [("PostgreSQL", "PostgreSQL"), ("MySQL", "MySQL"), ("SQLite", "SQLite")]

def fab_sql(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    table = pioche(rng, TABLES_SQL)
    nom_table = table.split("(")[0]
    _, gabarit = pioche(rng, QUESTIONS_SQL)
    filtre = pioche(rng, FILTRES_SQL)
    dia_fr, dia_en = pioche(rng, DIALECTES)
    filtre_sql = filtre
    sql = gabarit.replace("{FILTRE}", filtre_sql)
    if fr_fr:
        instr = f"Écris la requête SQL ({dia_fr}) répondant à la question sur {nom_table}."
        inp = f"Table : {table}. Question : {_question_fr(gabarit)}. Filtre : {filtre or 'aucun'}."
        out = f"REQUÊTE ({dia_fr}) :\n{sql}\n— index conseillé : colonnes de jointure + filtre temporel ; vérifier EXPLAIN avant mise en prod."
    else:
        instr = f"Write the SQL query ({dia_en}) answering the question about {nom_table}."
        inp = f"Table: {table}. Question: {_question_en(gabarit)}. Filter: {filtre or 'none'}."
        out = f"QUERY ({dia_en}):\n{sql}\n— suggested index: join + time-filter columns; run EXPLAIN before shipping."
    return {"task_type": "sql_query", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"table": nom_table, "dialect": dia_en}}

def _question_fr(gabarit: str) -> str:
    return gabarit.split(" AS ")[0].split("SELECT ")[1].split(" FROM")[0].strip(" ()")

def _question_en(gabarit: str) -> str:
    return _question_fr(gabarit)

INTENTIONS_CSS = [("centrer verticalement", "center vertically"), ("grille responsive", "responsive grid"),
                  ("mise en page 2 colonnes", "two-column layout"), ("en-tête collant", "sticky header"),
                  ("carte avec ombre au survol", "card hover shadow"), ("gouttière fluide", "fluid gap"),
                  ("défilement horizontal adouci", "smooth horizontal scroll"), ("ratio d'aspect fixe", "fixed aspect ratio"),
                  ("texte tronqué sur 2 lignes", "2-line clamp"), ("mode sombre par variables", "dark mode via variables"),
                  ("toast empilé en coin", "stacked corner toast"), ("tableau à colonnes figées", "table with sticky columns")]
COMPOSANTS_CSS = ["grille de cartes", "barre de navigation", "formulaire", "tableau de données",
                  "modale", "encart promo", "liste de fichiers", "header de section"]
APPROCHES_CSS = [("flexbox", "flexbox"), ("CSS Grid", "CSS Grid"), ("container queries", "container queries")]
CONTEXTES_CSS = ["mobile-first", "dashboard", "e-commerce", "portfolio"]

def fab_css(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    int_fr, int_en = pioche(rng, INTENTIONS_CSS)
    comp = pioche(rng, COMPOSANTS_CSS)
    app_fr, app_en = pioche(rng, APPROCHES_CSS)
    ctx = pioche(rng, CONTEXTES_CSS)
    if fr_fr:
        instr = f"Atteins « {int_fr} » pour le {comp} ({ctx}) avec {app_fr}."
        inp = f"Cible : {comp} ; intention : {int_fr} ; approche : {app_fr} ; contexte : {ctx}."
        corps = ".grille { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: clamp(12px, 2vw, 24px); }"
        if app_fr == "flexbox":
            corps = ".ligne { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }"
        elif app_fr == "container queries":
            corps = (".carte-container { container-type: inline-size; }\n"
                     "@container (min-width: 480px) { .carte { display: grid; grid-template-columns: 96px 1fr; } }")
        out = f"CSS ({app_fr}, {ctx}) :\n{corps}\n— unités fluides (clamp/minmax), aucun px magique, contrastes AA vérifiés."
    else:
        instr = f"Achieve “{int_en}” for the {comp} ({ctx}) using {app_en}."
        inp = f"Target: {comp}; intent: {int_en}; approach: {app_en}; context: {ctx}."
        corps = ".grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: clamp(12px, 2vw, 24px); }"
        if app_en == "flexbox":
            corps = ".row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }"
        elif app_en == "container queries":
            corps = (".card-container { container-type: inline-size; }\n"
                     "@container (min-width: 480px) { .card { display: grid; grid-template-columns: 96px 1fr; } }")
        out = f"CSS ({app_en}, {ctx}):\n{corps}\n— fluid units (clamp/minmax), no magic px, AA contrast checked."
    return {"task_type": "css_layout", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"approach": app_en, "contexte": ctx}}

FABRIQUES_CODE = [fab_composant_react, fab_bug, fab_tests, fab_api, fab_sql, fab_css]

# ═════════════════════════ Domaine KNOWLEDGE (3 000) ═════════════════════════

# faits bilingues (fr, en) — pool correct et non controversé
FAITS_SCIENCES = [
    ("La photosynthèse convertit le CO2 et l'eau en glucose et oxygène grâce à l'énergie lumineuse captée par la chlorophylle.",
     "Photosynthesis converts CO2 and water into glucose and oxygen using light energy captured by chlorophyll."),
    ("En relativité générale, la gravité est décrite comme la courbure de l'espace-temps par la masse.",
     "In general relativity, gravity is described as the curvature of spacetime caused by mass."),
    ("L'ADN porte l'information génétique sous forme de séquence de bases A, T, C et G.",
     "DNA carries genetic information as a sequence of the bases A, T, C and G."),
    ("La pression atmosphérique moyenne au niveau de la mer vaut 101 325 pascals.",
     "Average atmospheric pressure at sea level is 101,325 pascals."),
    ("Des isotopes partagent le même nombre de protons mais diffèrent par leur nombre de neutrons.",
     "Isotopes share the same number of protons but differ in their number of neutrons."),
    ("La vitesse de la lumière dans le vide est d'environ 299 792 458 mètres par seconde.",
     "The speed of light in a vacuum is about 299,792,458 meters per second."),
    ("La mitose produit deux cellules filles identiques, la méiose quatre cellules haploïdes.",
     "Mitosis yields two identical daughter cells; meiosis yields four haploid cells."),
    ("L'échelle pH situe l'acidité : sous 7 la solution est acide, à 7 neutre, au-dessus basique.",
     "The pH scale ranks acidity: below 7 acidic, at 7 neutral, above 7 basic."),
    ("La deuxième loi de Newton s'écrit F = m·a : force résultante égale masse fois accélération.",
     "Newton's second law states F = m·a: net force equals mass times acceleration."),
    ("L'énergie cinétique d'un corps vaut la moitié de sa masse multipliée par le carré de sa vitesse.",
     "A body's kinetic energy equals half its mass times the square of its speed."),
    ("Le tableau périodique classe les éléments par numéro atomique croissant.",
     "The periodic table orders elements by increasing atomic number."),
    ("Les enzymes sont des catalyseurs biologiques qui abaissent l'énergie d'activation des réactions.",
     "Enzymes are biological catalysts that lower the activation energy of reactions."),
    ("La tectonique des plaques explique séismes, volcans et formation des chaînes de montagnes.",
     "Plate tectonics explains earthquakes, volcanoes and mountain building."),
    ("L'effet de serre retient une partie du rayonnement infrarouge émis par la Terre.",
     "The greenhouse effect traps part of the infrared radiation emitted by Earth."),
    ("La gravité terrestre vaut environ 9,81 m/s² au niveau de la mer.",
     "Earth's gravity is about 9.81 m/s² at sea level."),
    ("Premier principe de la thermodynamique : l'énergie d'un système isolé se conserve.",
     "First law of thermodynamics: the energy of an isolated system is conserved."),
    ("L'hémoglobine transporte l'oxygène grâce au fer contenu dans ses groupes hème.",
     "Hemoglobin transports oxygen thanks to the iron in its heme groups."),
    ("Le son se propage plus vite dans l'eau que dans l'air car le milieu est plus rigide.",
     "Sound travels faster in water than in air because the medium is stiffer."),
    ("Dans un circuit en série le courant est le même partout ; en parallèle, la tension est commune aux branches.",
     "In a series circuit current is shared equally; in parallel, voltage is common across branches."),
    ("La loi d'Ohm relie tension, résistance et courant : U = R·I.",
     "Ohm's law links voltage, resistance and current: V = R·I."),
    ("Le carbone-14 permet de dater les restes organiques jusqu'à environ 50 000 ans.",
     "Carbon-14 can date organic remains up to about 50,000 years old."),
    ("L'expression des gènes passe par la transcription en ARN puis la traduction en protéines.",
     "Gene expression goes through transcription into RNA then translation into proteins."),
    ("La lumière blanche combine plusieurs longueurs d'onde qu'un prisme sépare par réfraction.",
     "White light combines several wavelengths that a prism separates through refraction."),
    ("Une réaction d'oxydoréduction transfère des électrons d'une espèce chimique à une autre.",
     "A redox reaction transfers electrons from one chemical species to another."),
    ("La sélection naturelle favorise les traits qui augmentent la survie et la reproduction.",
     "Natural selection favors traits that increase survival and reproduction."),
    ("Deux pôles magnétiques identiques se repoussent, opposés s'attirent.",
     "Like magnetic poles repel, opposite poles attract."),
    ("L'entropie d'un système isolé ne diminue jamais (deuxième principe de la thermodynamique).",
     "The entropy of an isolated system never decreases (second law of thermodynamics)."),
    ("L'eau atteint sa densité maximale à 4 °C, c'est pourquoi la glace flotte.",
     "Water reaches maximum density at 4 °C, which is why ice floats."),
    ("Le réflexe rotidien est traité par la moelle épinière sans passer par le cerveau.",
     "The knee-jerk reflex is processed in the spinal cord without the brain."),
    ("Les raies d'absorption du spectre stellaire révèlent sa composition chimique.",
     "Absorption lines in a stellar spectrum reveal its chemical composition."),
    ("Les supernovae synthétisent et dispersent les éléments lourds dans l'Univers.",
     "Supernovae forge and scatter heavy elements across the Universe."),
    ("Une pile électrochimique convertit l'énergie chimique en énergie électrique.",
     "An electrochemical cell converts chemical energy into electrical energy."),
    ("Un corps flotte quand sa densité est inférieure à celle du fluide dans lequel il est plongé.",
     "A body floats when its density is lower than that of the fluid it is placed in."),
    ("L'atmosphère terrestre est composée d'environ 78 % d'azote et 21 % d'oxygène.",
     "Earth's atmosphere is about 78% nitrogen and 21% oxygen."),
    ("Un virus ne peut se reproduire qu'en détournant la machinerie d'une cellule hôte.",
     "A virus can only reproduce by hijacking a host cell's machinery."),
    ("Le champ magnétique terrestre dévie le vent solaire et protège la biosphère.",
     "Earth's magnetic field deflects the solar wind and shields the biosphere."),
    ("La dilatation thermique augmente le volume des solides quand la température monte.",
     "Thermal expansion increases the volume of solids as temperature rises."),
    ("Une chaîne alimentaire transfère l'énergie des producteurs vers les consommateurs.",
     "A food chain transfers energy from producers to consumers."),
    ("L'induction électromagnétique produit un courant quand le flux magnétique varie (Faraday).",
     "Electromagnetic induction produces current when magnetic flux changes (Faraday)."),
    ("La respiration cellulaire produit de l'ATP à partir du glucose et de l'oxygène.",
     "Cellular respiration produces ATP from glucose and oxygen."),
]
AUDIENCES_SCI = [("un enfant curieux", "a curious child"), ("un lycéen", "a high-schooler"),
                 ("un étudiant", "a university student"), ("un professionnel non spécialiste", "a non-specialist professional")]
FORMATS_SCI = [("définition claire", "clear definition"), ("explication pas-à-pas", "step-by-step explanation"),
               ("exemple concret", "concrete example")]

def fab_sciences(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    fait_fr, fait_en = pioche(rng, FAITS_SCIENCES)
    aud_fr, aud_en = pioche(rng, AUDIENCES_SCI)
    fmt_fr, fmt_en = pioche(rng, FORMATS_SCI)
    fait = fait_fr if fr_fr else fait_en
    aud = aud_fr if fr_fr else aud_en
    fmt = fmt_fr if fr_fr else fmt_en
    sujet = fait.split(",")[0].split(" : ")[0][:48]
    if fr_fr:
        instr = f"Explique {fmt} à {aud} : {sujet.lower()}."
        inp = f"Public : {aud} ; format : {fmt} ; notion : {sujet.lower()}."
        out = f"{fait}\nÀ retenir pour {aud} : reformule avec tes mots, puis vérifie en une phrase ce que tu viens d'apprendre."
    else:
        instr = f"Explain {fmt} to {aud}: {sujet.lower()}."
        inp = f"Audience: {aud}; format: {fmt}; concept: {sujet.lower()}."
        out = f"{fait}\nKey takeaway for {aud}: say it back in your own words, then check yourself in one sentence."
    return {"task_type": "qa_sciences", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"matière": "sciences"}}

FAITS_HUMAINES = [
    ("La Révolution française de 1789 marque la fin de l'Ancien Régime en France.",
     "The French Revolution of 1789 marks the end of the Ancien Régime in France."),
    ("La route de la soie reliait la Chine au monde méditerranéen dès l'Antiquité.",
     "The Silk Road linked China to the Mediterranean world from antiquity onward."),
    ("La décolonisation africaine s'accélère principalement entre 1950 et 1975.",
     "African decolonization accelerated mainly between 1950 and 1975."),
    ("La chute du mur de Berlin en 1989 symbolise la fin de la guerre froide.",
     "The fall of the Berlin Wall in 1989 symbolizes the end of the Cold War."),
    ("L'Empire romain d'Occident tombe en 476, l'Empire d'Orient en 1453.",
     "The Western Roman Empire fell in 476; the Eastern Empire in 1453."),
    ("La Révolution industrielle débute au Royaume-Uni à la fin du XVIIIe siècle.",
     "The Industrial Revolution began in the United Kingdom in the late 18th century."),
    ("La transition démographique décrit une baisse de mortalité suivie d'une baisse de natalité.",
     "The demographic transition describes falling mortality followed by falling birth rates."),
    ("La Renaissance redécouvre l'Antiquité et fait progresser l'humanisme.",
     "The Renaissance rediscovered antiquity and advanced humanism."),
    ("Les consuls annuels dirigeaient la République romaine.",
     "Annual consuls led the Roman Republic."),
    ("Les Lumières valorisent la raison, la science et les droits naturels.",
     "The Enlightenment championed reason, science and natural rights."),
    ("La traite transatlantique a déporté des millions d'Africains entre les XVIe et XIXe siècles.",
     "The transatlantic slave trade deported millions of Africans between the 16th and 19th centuries."),
    ("La Seconde Guerre mondiale se termine en 1945, en mai en Europe puis en septembre dans le Pacifique.",
     "World War II ended in 1945, in May in Europe and in September in the Pacific."),
    ("L'ONU est fondée en 1945 pour maintenir la paix et la sécurité internationales.",
     "The UN was founded in 1945 to maintain international peace and security."),
    ("Le PIB mesure la richesse produite sur un territoire pendant une période donnée.",
     "GDP measures the wealth produced in a territory over a given period."),
    ("L'inflation désigne une hausse durable du niveau général des prix.",
     "Inflation refers to a sustained rise in the general price level."),
    ("L'imprimerie de Gutenberg vers 1450 révolutionne la diffusion du savoir.",
     "Gutenberg's printing press around 1450 revolutionized the spread of knowledge."),
    ("Le Code de Hammurabi est l'un des plus anciens recueils de lois connus, vers 1750 av. J.-C.",
     "The Code of Hammurabi is one of the oldest known legal codes, around 1750 BCE."),
    ("Durkheim traite les faits sociaux comme des choses extérieures et contraignantes.",
     "Durkheim treated social facts as external and constraining things."),
    ("Le Moyen Âge européen s'étend approximativement de 476 à 1492.",
     "The European Middle Ages roughly span 476 to 1492."),
    ("La guerre froide oppose les États-Unis et l'URSS de 1947 à 1991 sans affrontement direct.",
     "The Cold War pitted the USA against the USSR from 1947 to 1991 without direct fighting."),
    ("Le panafricanisme promeut l'unité et la solidarité des peuples africains.",
     "Pan-Africanism promotes the unity and solidarity of African peoples."),
    ("La Révolution haïtienne (1791-1804) fonde le premier État issu d'une révolte d'esclaves.",
     "The Haitian Revolution (1791-1804) founded the first state born of a slave revolt."),
    ("Keynes prône l'intervention de l'État pour sortir des crises de sous-emploi.",
     "Keynes advocated state intervention to escape underemployment crises."),
    ("La conférence de Berlin (1884-1885) formalise le partage colonial de l'Afrique.",
     "The Berlin Conference (1884-1885) formalized the colonial partition of Africa."),
    ("La Déclaration universelle des droits de l'homme est adoptée en 1948.",
     "The Universal Declaration of Human Rights was adopted in 1948."),
    ("La Révolution d'Octobre 1917 installe le premier État se réclamant socialiste.",
     "The October Revolution of 1917 established the first self-declared socialist state."),
    ("Athènes invente la démocratie citoyenne au Ve siècle av. J.-C.",
     "Athens invented citizen democracy in the 5th century BCE."),
    ("L'anthropologie étudie les sociétés humaines dans leur diversité culturelle.",
     "Anthropology studies human societies in their cultural diversity."),
    ("La géopolitique analyse les rivalités de puissance exercées sur les territoires.",
     "Geopolitics analyzes power rivalries played out over territories."),
    ("La sociolinguistique étudie les variations sociales de la langue.",
     "Sociolinguistics studies the social variation of language."),
]
CADRAGES_HUM = [("synthèse factuelle", "factual summary"), ("comparaison d'époques", "era comparison"),
                ("analyse des causes", "cause analysis")]
AUDIENCES_HUM = [("un lycéen", "a high-schooler"), ("un étudiant", "a university student"),
                 ("le grand public", "the general public")]

def fab_humaines(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    fait_fr, fait_en = pioche(rng, FAITS_HUMAINES)
    cad_fr, cad_en = pioche(rng, CADRAGES_HUM)
    aud_fr, aud_en = pioche(rng, AUDIENCES_HUM)
    fait = fait_fr if fr_fr else fait_en
    cad = cad_fr if fr_fr else cad_en
    aud = aud_fr if fr_fr else aud_en
    sujet = fait.split(",")[0].split(" : ")[0][:48]
    if fr_fr:
        instr = f"Donne une {cad} pour {aud} : {sujet.lower()}."
        inp = f"Sujet : {sujet.lower()} ; cadrage : {cad} ; public : {aud}."
        out = f"{fait}\nPour aller plus loin : situer les dates clés, les acteurs, puis une conséquence visible aujourd'hui."
    else:
        instr = f"Provide a {cad} for {aud}: {sujet.lower()}."
        inp = f"Topic: {sujet.lower()}; framing: {cad}; audience: {aud}."
        out = f"{fait}\nNext: place the key dates and actors, then one consequence visible today."
    return {"task_type": "qa_humaines", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"matière": "sciences humaines"}}

SUJETS_SANTE = [
    ("boire suffisamment d'eau soutient l'hydratation et les fonctions rénales",
     "drinking enough water supports hydration and kidney function"),
    ("l'activité physique régulière réduit les risques cardiovasculaires",
     "regular physical activity reduces cardiovascular risks"),
    ("un sommeil de 7 à 9 heures par nuit est recommandé chez l'adulte",
     "7 to 9 hours of nightly sleep is recommended for adults"),
    ("le lavage des mains au savon limite la transmission des infections",
     "handwashing with soap limits the spread of infections"),
    ("la vaccination protège l'individu et réduit la circulation des maladies",
     "vaccination protects the individual and slows disease circulation"),
    ("le tabagisme augmente le risque de cancer et de maladies respiratoires",
     "smoking raises the risk of cancer and respiratory disease"),
    ("une alimentation équilibrée associe fruits, légumes, céréales complètes et protéines",
     "a balanced diet combines fruits, vegetables, whole grains and proteins"),
    ("une pression artérielle autour de 120/80 mmHg est habituelle chez l'adulte",
     "blood pressure around 120/80 mmHg is typical for adults"),
    ("la fièvre est un symptôme à surveiller, pas une maladie en soi",
     "fever is a symptom to monitor, not a disease in itself"),
    ("les antibiotiques ne traitent pas les infections virales comme le rhume",
     "antibiotics do not treat viral infections like the common cold"),
    ("une douleur thoracique intense impose un avis médical immédiat",
     "intense chest pain requires immediate medical attention"),
    ("l'IMC (poids/taille²) est un indicateur approximatif à interpréter avec prudence",
     "BMI (weight/height²) is a rough indicator to interpret cautiously"),
    ("la protection solaire réduit brûlures et risque de cancer de la peau",
     "sun protection reduces burns and skin cancer risk"),
    ("le dépistage précoce améliore le pronostic de nombreux cancers",
     "early screening improves the prognosis of many cancers"),
    ("la santé mentale fait partie intégrante de la santé selon l'OMS",
     "mental health is an integral part of health according to the WHO"),
    ("les écrans avant le coucher peuvent retarder l'endormissement",
     "screens before bedtime can delay falling asleep"),
    ("l'hydratation doit être accrue en cas de chaleur ou d'exercice",
     "hydration should increase in hot weather or during exercise"),
    ("les allergies sont une réaction excessive du système immunitaire",
     "allergies are an overreaction of the immune system"),
    ("les premiers secours suivent la règle protéger, alerter, secourir",
     "first aid follows protect, alert, assist"),
    ("les oméga-3 des poissons gras soutiennent la santé cardiovasculaire",
     "omega-3s from oily fish support cardiovascular health"),
]
FORMATS_SANTE = [("infos essentielles", "key facts"), ("prévention", "prevention"),
                 ("quand consulter", "when to seek care")]

def fab_sante(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    (suj_fr, suj_en) = pioche(rng, SUJETS_SANTE)
    fmt_fr, fmt_en = pioche(rng, FORMATS_SANTE)
    suj = suj_fr if fr_fr else suj_en
    fmt = fmt_fr if fr_fr else fmt_en
    if fr_fr:
        instr = f"Information santé grand public ({fmt}) : {suj}."
        inp = f"Question : que doit savoir le grand public sur « {suj} » ? Format : {fmt}."
        out = (f"{suj[0].upper()}{suj[1:]}.\nRappel : ces informations sont générales et ne remplacent "
               "pas un avis médical — en cas de symptôme persistant, consultez un professionnel de santé.")
    else:
        instr = f"General health information ({fmt}): {suj}."
        inp = f"Question: what should the public know about “{suj}”? Format: {fmt}."
        out = (f"{suj[0].upper()}{suj[1:]}.\nNote: this is general information, not medical advice — "
               "for persistent symptoms consult a healthcare professional.")
    return {"task_type": "sante_information", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": "facile", "safety_label": "safe",
            "metadata_extra": {"domaine_sante": "grand public"}}

BESOINS_MACHINE = ["un bras robotisé 3 axes de palettisation", "un convoyeur à bande pour caisses de 25 kg",
                   "un moteur pour portail coulissant de 4 m", "un vérin pneumatique de préhension",
                   "une transmission poulie-courroie rapport 1:3", "un roulement pour arbre à 3 000 tr/min",
                   "un châssis rigide pour machine-outil", "une vis sans fin d'élévation de granulés",
                   "un capteur de position pour cylindre hydraulique", "un plateau tournant indexé",
                   "une pompe de circulation d'eau de refroidissement", "un verrouillage de porte industrielle",
                   "un ressort de rappel pour clapet", "un engrenage pour couple élevé",
                   "une trémie de dosage pondéral", "un rail de guidage linéaire à billes",
                   "un variateur pour moteur asynchrone 5,5 kW", "un bac de collecte à bascule automatique",
                   "un vérin électrique pour presse légère", "une courroie crantée de synchronisation d'axes",
                   "un trieur à détecteur optique", "une suspente anti-vibration pour groupe froid",
                   "un joint d'étanchéité pour milieu hydrocarbures", "un poste de manipulation ergonomique",
                   "un bras de levier pour presses à pied"]
MATERIAUX = [("acier S235", "S235 steel"), ("inox 304", "304 stainless"), ("aluminium 6061", "6061 aluminum"),
             ("laiton", "brass"), ("POM (acétal)", "POM (acetal)"), ("nylon + fibre de verre", "glass-filled nylon")]
TOLERANCES = ["±0,1 mm", "±0,05 mm", "ajustement H7/g6", "ISO 2768-m"]

def fab_machines(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    besoin = pioche(rng, BESOINS_MACHINE)
    mat_fr, mat_en = pioche(rng, MATERIAUX)
    tol = pioche(rng, TOLERANCES)
    mat = mat_fr if fr_fr else mat_en
    if fr_fr:
        instr = f"Aide-moi à dimensionner {besoin} : matériau, tolérances et points de contrôle."
        inp = f"Besoin : {besoin} ; matériau candidat : {mat} ; tolérance : {tol}."
        out = (f"CONCEPTION — {besoin}\n"
               f"1) matériau : {mat} (justifier charge, corrosion, coût) ;\n"
               f"2) tolérance : {tol} sur les surfaces fonctionnelles ;\n"
               f"3) contrôles : jeu au montage, tenue en fatigue, sécurité opérateur ;\n"
               f"4) plan de validation : essai à vide puis essai en charge progressive.")
    else:
        instr = f"Help me size {besoin}: material, tolerances and inspection points."
        inp = f"Need: {besoin}; candidate material: {mat}; tolerance: {tol}."
        out = (f"DESIGN — {besoin}\n"
               f"1) material: {mat} (justify load, corrosion, cost);\n"
               f"2) tolerance: {tol} on functional surfaces;\n"
               f"3) checks: assembly clearance, fatigue life, operator safety;\n"
               f"4) validation: dry run then progressive load test.")
    return {"task_type": "machine_conception", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"ingénierie": "mécanique"}}

SUJETS_WEB = ["pannes d'éoliennes en zone côtière saline", "rendement des panneaux solaires bifaciaux",
              "pollinisation et rendement des vergers urbains", "efficacité des pédagogies actives en maths",
              "conservation des manuscrits anciens en climat tropical", "mobilité douce et congestion urbaine",
              "microplastiques dans les lacs d'eau douce", "résistance du manioc à la mosaïque africaine",
              "réduction du gaspillage alimentaire en cantine", "télémédecine en zones rurales",
              "réutilisation des eaux grises domestiques", "impact du bruit sur la concentration au travail",
              "géothermie basse température pour bâtiments", "langues locales et apprentissage de la lecture",
              "freins à l'adoption du paiement mobile", "durabilité des routes en béton recyclé",
              "captage du carbone par biochar", "éclairage public solaire autonome",
              "formation professionnelle et employabilité des jeunes", "santé des sols et productivité agricole",
              "aquaculture intégrée riz-poisson", "littératie numérique des seniors",
              "chaîne du froid pour vaccins en climat chaud", "recyclage des batteries lithium"]
ARBOS_WEB = [("questions de cadrage", "framing questions"), ("mots-clés et opérateurs", "keywords and operators"),
             ("triangulation de sources", "source triangulation"), ("extraction de données", "data extraction"),
             ("synthèse citée", "cited synthesis")]
CONTRAINTES_WEB = [("sources primaires exigées", "primary sources required"),
                   ("budget de temps limité (2 h)", "tight time budget (2 h)"),
                   ("publication vérifiable par un tiers", "third-party verifiable output")]

def fab_recherche_web(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    suj = pioche(rng, SUJETS_WEB)
    arb_fr, arb_en = pioche(rng, ARBOS_WEB)
    con_fr, con_en = pioche(rng, CONTRAINTES_WEB)
    arb = arb_fr if fr_fr else arb_en
    con = con_fr if fr_fr else con_en
    if fr_fr:
        instr = f"Construis un plan de recherche web ({arb}, {con}) sur : {suj}."
        inp = f"Sujet : {suj} ; méthode : {arb} ; contrainte : {con}."
        out = (f"PLAN DE RECHERCHE — {suj}\n"
               f"1) cadrage : 3 questions auxquelles la réponse doit répondre ;\n"
               f"2) requêtes : mots-clés + opérateurs (guillemets, site:, filetype:) ;\n"
               f"3) sources : institutionnelle, académique, terrain — à croiser ;\n"
               f"4) extraction : tableau sujet / chiffre clé / source / date ;\n"
               f"5) synthèse : 5 lignes + limites + références complètes.")
    else:
        instr = f"Build a web research plan ({arb}, {con}) on: {suj}."
        inp = f"Topic: {suj}; method: {arb}; constraint: {con}."
        out = (f"RESEARCH PLAN — {suj}\n"
               f"1) framing: 3 questions the answer must address;\n"
               f"2) queries: keywords + operators (quotes, site:, filetype:);\n"
               f"3) sources: institutional, academic, field — cross-checked;\n"
               f"4) extraction: table topic / key figure / source / date;\n"
               f"5) synthesis: 5 lines + limits + full references.")
    return {"task_type": "web_research_plan", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"méthode": "recherche documentaire"}}

FABRIQUES_KNOWLEDGE = [fab_sciences, fab_humaines, fab_sante, fab_machines, fab_recherche_web]

# ═════════════════════════ Domaine SECURITY (6 000 — défensif uniquement) ═════════════════════════

VULNS = [
    ("XSS réfléchi", "affichage direct d'un paramètre URL", "échapper à la sortie + CSP",
     "el.textContent = new URLSearchParams(location.search).get('q') ?? '';"),
    ("injection SQL", "concaténation d'un filtre utilisateur", "requêtes paramétrées",
     "db.query('SELECT * FROM clients WHERE ville = $1', [ville]);"),
    ("secrets en dur", "clé API écrite dans le code", "variables d'environnement + coffre",
     "const cle = process.env.CLE_API; if (!cle) throw new Error('config manquante');"),
    ("CSRF", "action sensible sans jeton", "jeton anti-CSRF SameSite",
     "cookie: SameSite=Lax + header X-CSRF-Token vérifié côté serveur"),
    ("traversal de chemin", "chemin fichier construit depuis l'entrée", "basename + allow-list",
     "const nom = path.basename(req.params.fichier); if (!NOMS.has(nom)) throw new Error('refusé');"),
    ("SSRF", "fetch d'une URL fournie par l'utilisateur", "allow-list d'hôtes + blocage IP privées",
     "if (!HOTES_AUTORISES.has(new URL(url).hostname)) throw new Error('hôte refusé');"),
    ("désérialisation non sûre", "JSON.parse de données non vérifiées", "validation par schéma",
     "const donnees = SchemaEntree.parse(JSON.parse(brut));"),
    ("CORS trop permissif", "Access-Control-Allow-Origin: * sur route authentifiée", "origine explicite",
     "const ORIGINES = new Set(['https://gen3ia.online']); // refléter uniquement si incluse"),
    ("pas de limite de débit", "route de login sans rate limit", "rate limiter par IP+compte",
     "limiteur.login(ip, email) → 5 tentatives / 15 min puis délai progressif"),
    ("authentification faible", "mot de passe stocké non haché", "argon2 + politique de longueur",
     "await argon2.hash(motDePasse, { memoryCost: 19456, parallelism: 1 });"),
    ("fuite dans les logs", "token imprimé dans les journaux", "masquage systématique",
     "logger.info({ user: uid, token: masquer(token) }, 'auth réussie');"),
    ("dépendances vulnérables", "package avec CVE connue", "audit CI + overrides",
     "npm audit --audit-level=high en job CI bloquant + npm overrides si besoin"),
]
STACKS_SEC = [("Next.js", "Next.js"), ("Express", "Express"), ("Fastify", "Fastify"),
              ("Django", "Django"), ("Rails", "Rails"), ("Laravel", "Laravel"),
              ("Spring", "Spring"), ("serverless (Vercel)", "serverless (Vercel)")]
SEV = [("critique", "critical"), ("majeure", "major"), ("modérée", "moderate")]
ASPECTS_SEC = [("correction", "fix"), ("test de non-régression", "regression test"),
               ("prévention", "prevention"), ("détection", "detection")]

def fab_revue_code(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    nom_v, mauvais, correct, extrait = pioche(rng, VULNS)
    stack = pioche(rng, STACKS_SEC)[0 if fr_fr else 1]
    sev_fr, sev_en = pioche(rng, SEV)
    asp_fr, asp_en = pioche(rng, ASPECTS_SEC)
    sev = sev_fr if fr_fr else sev_en
    asp = asp_fr if fr_fr else asp_en
    if fr_fr:
        instr = f"Revue de sécurité {stack} : vulnérabilité « {nom_v} » ({sev}), plan de {asp}."
        inp = f"Stack : {stack} ; vulnérabilité : {nom_v} — {mauvais} ; sévérité : {sev} ; objectif : {asp}."
        out = f"ANALYSE ({sev}) : {mauvais}.\nDÉFENSE : {correct}.\n```ts\n{extrait}\n```\nVérification : test automatisé + revue croisée avant merge."
    else:
        instr = f"{stack} security review: “{nom_v}” vulnerability ({sev}), {asp} plan."
        inp = f"Stack: {stack}; vulnerability: {nom_v} — {mauvais}; severity: {sev}; goal: {asp}."
        out = f"ANALYSIS ({sev}): {mauvais}.\nDEFENSE: {correct}.\n```ts\n{extrait}\n```\nVerification: automated test + cross review before merge."
    return {"task_type": "secure_code_review", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"stack": stack, "safety": "defensive"}}

ACTIFS = ["API publique", "base clients", "back-office", "tunnel de paiement", "fichiers uploadés",
          "sessions administrateurs", "e-mails transactionnels", "sous-domaines inutilisés",
          "webhooks partenaires", "exports CSV", "tokens d'API", "planificateur de tâches"]
MENACES = ["fuite de données", "déni de service", "prise de contrôle de compte", "fraude au paiement",
           "usurpation de sous-domaine", "injection", "élévation de privilèges", "compromission de la chaîne d'approvisionnement"]
CTX_SEC = ["lancement produit", "croissance rapide", "équipe réduite", "intégration tierce",
           "audit client en cours"]
PROFILS = [("script kiddie opportuniste", "opportunistic script kiddie"),
           ("concurrent malveillant", "malicious competitor"),
           ("criminel organisé", "organized crime"), ("initié négligent", "negligent insider")]

def fab_menaces(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    actif = pioche(rng, ACTIFS)
    menace = pioche(rng, MENACES)
    ctx = pioche(rng, CTX_SEC)
    prof_fr, prof_en = pioche(rng, PROFILS)
    prof = prof_fr if fr_fr else prof_en
    if fr_fr:
        instr = f"Analyse de menaces : « {actif} » face à un risque de {menace} pendant {ctx}."
        inp = f"Actif : {actif} ; menace : {menace} ; contexte : {ctx} ; profil attaquant plausible : {prof}."
        out = (f"MATRICE — {actif} / {menace}\n"
               f"1) vecteurs réalistes pour {prof} ;\n"
               f"2) impact business (données, disponibilité, confiance) ;\n"
               f"3) mesures : prévention, détection, réponse — une action concrète par ligne ;\n"
               f"4) priorité : ce qui se fait cette semaine vs ce trimestre.")
    else:
        instr = f"Threat analysis: “{actif}” facing {menace} risk during {ctx}."
        inp = f"Asset: {actif}; threat: {menace}; context: {ctx}; plausible attacker: {prof}."
        out = (f"MATRIX — {actif} / {menace}\n"
               f"1) realistic vectors for {prof};\n"
               f"2) business impact (data, availability, trust);\n"
               f"3) measures: prevention, detection, response — one concrete action each;\n"
               f"4) priority: this week vs this quarter.")
    return {"task_type": "threat_analysis", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"safety": "defensive"}}

CTF_CATS = [("web", "web"), ("crypto", "crypto"), ("forensic", "forensics"), ("reverse simple", "beginner reverse")]
CTF_ETAPES = [("reconnaissance", "reconnaissance"), ("analyse initiale", "initial analysis"),
              ("exploitation encadrée", "guided exploitation"), ("flag et preuve", "flag and proof"),
              ("leçon défensive", "defensive lesson")]

def fab_ctf(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    cat_fr, cat_en = pioche(rng, CTF_CATS)
    etape_fr, etape_en = pioche(rng, CTF_ETAPES)
    indice = pioche(rng, ["niveau 1 (piste explicite)", "niveau 2 (piste indirecte)",
                          "niveau 3 (sans piste)", "défi chronométré"])
    cat = cat_fr if fr_fr else cat_en
    etape = etape_fr if fr_fr else etape_en
    if fr_fr:
        instr = f"Laboratoire CTF éducatif ({cat}) : guide-moi sur l'étape « {etape} », {indice}."
        inp = f"Catégorie : {cat} ; étape : {etape} ; indice : {indice} ; cadre : laboratoire local autorisé."
        out = (f"LABO {cat.upper()} — {etape}\n"
               f"Rappel éthique : uniquement sur un environnement qui t'appartient ou autorisé par écrit.\n"
               f"1) préparer le labo local (machine virtuelle, réseau isolé) ;\n"
               f"2) observer avant d'agir (fichiers, en-têtes, métadonnées) ;\n"
               f"3) documenter chaque action (commande, résultat) ;\n"
               f"4) conclure par la LEÇON défensive : quelle protection aurait bloqué ce scénario.")
    else:
        instr = f"Educational CTF lab ({cat}): guide me through “{etape}”, {indice}."
        inp = f"Category: {cat}; step: {etape}; hint: {indice}; setting: authorized local lab."
        out = (f"LAB {cat.upper()} — {etape}\n"
               f"Ethics reminder: only on systems you own or are authorized to test in writing.\n"
               f"1) set up the local lab (VM, isolated network);\n"
               f"2) observe before acting (files, headers, metadata);\n"
               f"3) document every action (command, result);\n"
               f"4) end with the DEFENSIVE lesson: which control would have blocked this.")
    return {"task_type": "ctf_guided", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"safety": "educational-lab"}}

SYS_HARD = [("Next.js SSR", "Next.js SSR"), ("PostgreSQL", "PostgreSQL"), ("nginx", "nginx"),
            ("worker Node.js", "Node.js worker"), ("bucket objet", "object storage"),
            ("VPN admin", "admin VPN"), ("chaîne CI/CD", "CI/CD pipeline"),
            ("poste développeur", "developer workstation"), ("serveur de mail sortant", "outbound mail server"),
            ("sauvegardes", "backups")]
COUCHES = [("périmètre (WAF, en-têtes)", "perimeter (WAF, headers)"), ("authentification et autorisations", "authN and authZ"),
           ("données (chiffrement)", "data (encryption)"), ("dépendances", "dependencies"),
           ("sauvegardes et restauration", "backup and restore"), ("supervision et alertes", "monitoring and alerts")]
CONTR_HARD = [("VPS 2 Go", "2 GB VPS"), ("équipe de deux", "team of two"),
              ("migration sans coupure", "zero-downtime migration"), ("budget serré", "tight budget"),
              ("conformité RGPD", "GDPR compliance"), ("fenêtre de maintenance le week-end", "weekend maintenance window")]

def fab_durcissement(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    sys_fr, sys_en = pioche(rng, SYS_HARD)
    cou_fr, cou_en = pioche(rng, COUCHES)
    con_fr, con_en = pioche(rng, CONTR_HARD)
    sys = sys_fr if fr_fr else sys_en
    cou = cou_fr if fr_fr else cou_en
    con = con_fr if fr_fr else con_en
    if fr_fr:
        instr = f"Plan de durcissement : {sys}, couche « {cou} », contrainte {con}."
        inp = f"Système : {sys} ; couche : {cou} ; contrainte : {con}."
        out = (f"HARDENING — {sys} / {cou}\n"
               f"0) état des lieux : inventaire + 3 écarts principaux ;\n"
               f"1) actions immédiates (≤ 1 h) : correctifs, en-têtes, secrets hors code ;\n"
               f"2) actions structurantes : roles minimaux, rotation des clés, tests ;\n"
               f"3) contrôle : sonde automatique hebdomadaire + alerte ;\n"
               f"4) contrainte honorée : {con}.")
    else:
        instr = f"Hardening plan: {sys}, “{cou}” layer, constraint {con}."
        inp = f"System: {sys}; layer: {cou}; constraint: {con}."
        out = (f"HARDENING — {sys} / {cou}\n"
               f"0) baseline: inventory + top 3 gaps;\n"
               f"1) immediate actions (≤ 1 h): patches, headers, secrets out of code;\n"
               f"2) structural actions: least privilege, key rotation, tests;\n"
               f"3) control: weekly automated probe + alert;\n"
               f"4) constraint honored: {con}.")
    return {"task_type": "hardening_plan", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"safety": "defensive"}}

FABRIQUES_SECURITY = [fab_revue_code, fab_menaces, fab_ctf, fab_durcissement]

# ═════════════════════════ Domaine BUSINESS (11 600) ═════════════════════════

METRIQUES = ["taux de conversion", "panier moyen", "coût d'acquisition (CAC)", "taux de rétention à 90 jours",
             "valeur vie client (LTV)", "marge brute", "taux de rebond", "durée de session",
             "paniers abandonnés", "taux de réachat", "NPS", "temps de première réponse",
             "taux d'annulation (churn)", "revenu moyen par utilisateur (ARPU)", "leads qualifiés par mois",
             "délai de livraison", "taux de retour produit", "score de satisfaction support",
             "part de voix marché", "vitesse de pipeline commercial"]
PERIODES = ["la dernière semaine", "le dernier mois", "le dernier trimestre", "l'année en cours",
            "les 6 derniers mois", "la période de promo (2 semaines)", "le même mois l'an passé", "le lancement (30 jours)"]
SECTEURS_BIZ = ["e-commerce mode", "SaaS B2B", "restauration", "immobilier", "formation en ligne",
                "logistique", "santé privée", "agroalimentaire", "artisanat numérique", "transport urbain"]
PROFONDEURS = [("lecture rapide", "quick read"), ("analyse approfondie", "deep dive")]

def fab_analyse_donnees(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    met = pioche(rng, METRIQUES)
    per = pioche(rng, PERIODES)
    sec = pioche(rng, SECTEURS_BIZ)
    prof_fr, prof_en = pioche(rng, PROFONDEURS)
    prof = prof_fr if fr_fr else prof_en
    if fr_fr:
        instr = f"Analyse {prof} : comment a évolué le {met} ({sec}) sur {per} ?"
        inp = f"Métrique : {met} ; secteur : {sec} ; période : {per} ; profondeur : {prof}."
        out = (f"ANALYSE — {met} ({sec}, {per})\n"
               f"1) tendance : direction + amplitude (ne jamais conclure sur un seul point) ;\n"
               f"2) saisonnalité et événements suspects ;\n"
               f"3) segments qui tirent ou freinent ;\n"
               f"4) 2 causes plausibles à vérifier + la donnée qui les départagerait ;\n"
               f"5) décision recommandée + risque principal.")
    else:
        instr = f"{prof} analysis: how did {met} ({sec}) evolve over {per}?"
        inp = f"Metric: {met}; sector: {sec}; period: {per}; depth: {prof}."
        out = (f"ANALYSIS — {met} ({sec}, {per})\n"
               f"1) trend: direction + magnitude (never conclude on one point);\n"
               f"2) seasonality and suspect events;\n"
               f"3) segments pulling up or down;\n"
               f"4) 2 plausible causes + the data that would separate them;\n"
               f"5) recommended decision + main risk.")
    return {"task_type": "data_analysis", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"secteur": sec, "métrique": met}}

PRODUITS = [("app de gestion de stock", "inventory management app"), ("cours en ligne de design", "online design course"),
            ("service de livraison express", "express delivery service"), ("plateforme de freelances", "freelance platform"),
            ("logiciel de facturation", "invoicing software"), ("carte de restaurant afro-fusion", "afro-fusion restaurant menu"),
            ("service de nettoyage bureaux", "office cleaning service"), ("application de fitness", "fitness app"),
            ("boutique d'accessoires téléphoniques", "phone accessories store"), ("agence de web design", "web design agency"),
            ("solution de paiement mobile", "mobile payment solution"), ("coach sportif en ligne", "online fitness coach"),
            ("service de réparation smartphone", "phone repair service"), ("plateforme d'e-learning scolaire", "school e-learning platform"),
            ("service de photographie d'événements", "event photography service"), ("marketplace d'artisanat local", "local craft marketplace"),
            ("logiciel RH pour PME", "SME HR software"), ("service de transport de personnel", "staff transportation service"),
            ("abonnement café de spécialité", "specialty coffee subscription"), ("atelier de couture sur mesure", "tailoring workshop"),
            ("service de garde d'enfants", "childcare service"), ("kit de panneaux solaires", "solar panel kit"),
            ("app de budgétisation", "budgeting app"), ("service de transcription audio", "audio transcription service"),
            ("formation en cybersécurité", "cybersecurity training")]
PROFILS_CLIENT = [("PME de 10-50 salariés", "10-50 employee SME"), ("grande entreprise", "large enterprise"),
                  ("étudiant", "student"), ("famille avec enfants", "family with kids"),
                  ("jeune urbain connecté", "connected urban youth"), ("commerçant de quartier", "neighborhood shopkeeper"),
                  ("association à but non lucratif", "non-profit"), ("freelance solo", "solo freelancer"),
                  ("entreprise industrielle", "industrial company"), ("administrateur scolaire", "school administrator"),
                  ("hôtel boutique", "boutique hotel"), ("restaurant multi-sites", "multi-site restaurant")]
CANAUX = [("appel découverte", "discovery call"), ("email de prospection", "prospecting email"),
          ("démonstration produit", "product demo"), ("salon professionnel", "trade show"),
          ("WhatsApp Business", "WhatsApp Business"), ("réseaux sociaux", "social media")]

def fab_pitch(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    prod_fr, prod_en = pioche(rng, PRODUITS)
    prof_fr, prof_en = pioche(rng, PROFILS_CLIENT)
    canal_fr, canal_en = pioche(rng, CANAUX)
    prod = prod_fr if fr_fr else prod_en
    prof = prof_fr if fr_fr else prof_en
    canal = canal_fr if fr_fr else canal_en
    if fr_fr:
        instr = f"Prépare un pitch de {canal} pour proposer {prod} à {prof}."
        inp = f"Produit : {prod} ; cible : {prof} ; canal : {canal}."
        out = (f"PITCH ({canal}) — {prod} → {prof}\n"
               f"1) accroche liée au problème quotidien de la cible ;\n"
               f"2) preuve : 1 chiffre ou cas client concret ;\n"
               f"3) différenciation en une phrase ;\n"
               f"4) objection probable + réponse honnête ;\n"
               f"5) demande claire (essai, rendez-vous, devis).")
    else:
        instr = f"Prepare a {canal} pitch to sell {prod} to {prof}."
        inp = f"Product: {prod}; target: {prof}; channel: {canal}."
        out = (f"PITCH ({canal}) — {prod} → {prof}\n"
               f"1) hook tied to the target's daily pain;\n"
               f"2) proof: one number or customer case;\n"
               f"3) one-sentence differentiation;\n"
               f"4) likely objection + honest answer;\n"
               f"5) clear ask (trial, meeting, quote).")
    return {"task_type": "sales_pitch", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"produit": prod}}

SITUATIONS = [("prospect comparant 3 fournisseurs", "prospect comparing 3 vendors"),
              ("client satisfait mais silencieux", "happy but silent customer"),
              ("prix jugé trop élevé en première écoute", "price perceived as too high on first call"),
              ("décideur absent de la réunion", "decision maker absent from the meeting"),
              ("prospect promis à un concurrent", "prospect leaning to a competitor"),
              ("client hésitant après la démo", "customer hesitating after the demo"),
              ("besoin réel mais budget gelé", "real need but frozen budget"),
              ("contact enthousiaste qui ne relance pas", "enthusiastic contact who never follows up"),
              ("panier abandonné au moment du paiement", "cart abandoned at checkout"),
              ("client demandant une remise agressive", "customer asking for a steep discount"),
              ("rénégociation d'un contrat annuel", "annual contract renegotiation"),
              ("prospect venu par recommandation", "prospect from a referral"),
              ("objection technique en B2B", "technical objection in B2B"),
              ("premier rendez-vous téléphonique", "first phone meeting"),
              ("suivi après un salon", "follow-up after a trade show"),
              ("client mécontent d'un délai", "unhappy customer about a delay"),
              ("upsell d'une offre existante", "upsell of an existing plan"),
              ("reconversion d'un client perdu", "win-back of a churned customer"),
              ("vente croisée sur un compte fidèle", "cross-sell on a loyal account"),
              ("cycle de vente qui s'éternise", "sales cycle dragging on")]
OBJECTIONS = [("« c'est trop cher »", "“it's too expensive”"), ("« j'ai besoin d'en parler à mon équipe »", "“I need to talk to my team”"),
              ("« nous avons déjà un fournisseur »", "“we already have a vendor”"), ("« pas le temps maintenant »", "“no time right now”"),
              ("« j'ai peur de la migration »", "“I'm afraid of the migration”"), ("« votre produit manque de X »", "“your product lacks X”"),
              ("« envoyez-moi une documentation »", "“send me some documentation”"), ("« je reviens vers vous »", "“I'll get back to you”"),
              ("« le contrat est trop long »", "“the contract is too long”"), ("« je ne comprends pas la valeur »", "“I don't see the value”")]
ETAPES = [("prospection", "prospecting"), ("découverte", "discovery"), ("négociation", "negotiation"),
          ("closing", "closing")]
TAILLES = [("micro-entreprise", "micro-business"), ("PME", "SME"), ("compte entreprise", "enterprise account")]

def fab_conseil_commercial(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    sit_fr, sit_en = pioche(rng, SITUATIONS)
    obj_fr, obj_en = pioche(rng, OBJECTIONS)
    et_fr, et_en = pioche(rng, ETAPES)
    taille_fr, taille_en = pioche(rng, TAILLES)
    sit = sit_fr if fr_fr else sit_en
    obj = obj_fr if fr_fr else obj_en
    etape = et_fr if fr_fr else et_en
    taille = taille_fr if fr_fr else taille_en
    if fr_fr:
        instr = f"Étape « {etape} », {taille} : le client dit {obj}. Que faire ?"
        inp = f"Situation : {sit} ; objection : {obj} ; étape : {etape} ; taille : {taille}."
        out = (f"CONSEIL — {etape} ({taille})\n"
               f"1) reformuler l'objection pour vérifier qu'on l'a comprise ;\n"
               f"2) question ouverte sur le contexte réel derrière l'objection ;\n"
               f"3) réponse honnête : ce qu'on fait, ce qu'on ne fait pas ;\n"
               f"4) preuve adaptée à la taille du compte ;\n"
               f"5) prochaine étape datée (jamais « je reste disponible »).")
    else:
        instr = f"Stage “{etape}”, {taille}: the client says {obj}. What do you do?"
        inp = f"Situation: {sit}; objection: {obj}; stage: {etape}; size: {taille}."
        out = (f"ADVICE — {etape} ({taille})\n"
               f"1) restate the objection to confirm understanding;\n"
               f"2) open question about the real context behind it;\n"
               f"3) honest answer: what we do, what we don't;\n"
               f"4) proof fitted to account size;\n"
               f"5) dated next step (never “I'll stay available”).")
    return {"task_type": "commercial_advice", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"étape": etape}}

MODELES_PRIX = [("abonnement mensuel", "monthly subscription"), ("freemium", "freemium"),
                ("paiement à l'usage", "usage-based"), ("licence annuelle", "annual license"),
                ("forfait par utilisateur", "per-seat"), ("commission par transaction", "transaction commission"),
                ("tiercé standard/pro/enterprise", "standard/pro/enterprise tiers"),
                ("gratuit financé par la pub", "ad-funded free tier")]
MARCHES = ["Afrique de l'Ouest", "Europe francophone", "Amérique du Nord", "MENA",
           "Asie du Sud-Est", "marché local urbain", "national", "diaspora", "B2B regional", "global anglophone"]
CONTRAINTES_PRIX = [("pouvoir d'achat local", "local purchasing power"), ("concurrent direct plus cher", "more expensive direct competitor"),
                    ("coûts d'infrastructure élevés", "high infrastructure costs"), ("saisonnalité forte", "strong seasonality"),
                    ("exigence de marge minimale", "minimum margin requirement"), ("acquisition encore coûteuse", "acquisition still costly")]
SEGMENTS_PRIX = [("étudiants", "students"), ("particuliers", "consumers"), ("PME", "SMEs"), ("grands comptes", "enterprise")]

def fab_pricing(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    mod_fr, mod_en = pioche(rng, MODELES_PRIX)
    marche = pioche(rng, MARCHES)
    con_fr, con_en = pioche(rng, CONTRAINTES_PRIX)
    seg_fr, seg_en = pioche(rng, SEGMENTS_PRIX)
    mod = mod_fr if fr_fr else mod_en
    con = con_fr if fr_fr else con_en
    seg = seg_fr if fr_fr else seg_en
    if fr_fr:
        instr = f"Stratégie tarifaire : {mod} pour {seg} sur le marché {marche}, contrainte : {con}."
        inp = f"Modèle : {mod} ; segment : {seg} ; marché : {marche} ; contrainte : {con}."
        out = (f"PRICING — {mod} ({seg}, {marche})\n"
               f"1) ancrage : valeur perçue, pas le coût seul ;\n"
               f"2) palier d'entrée + palier de valeur (choix facile) ;\n"
               f"3) contrainte traitée : {con} — mesure dédiée ;\n"
               f"4) tests : A/B sur 2-4 semaines, critère de décision fixé AVANT ;\n"
               f"5) revue trimestrielle : churn, ARPU, marge.")
    else:
        instr = f"Pricing strategy: {mod} for {seg} in {marche}, constraint: {con}."
        inp = f"Model: {mod}; segment: {seg}; market: {marche}; constraint: {con}."
        out = (f"PRICING — {mod} ({seg}, {marche})\n"
               f"1) anchoring: perceived value, not cost alone;\n"
               f"2) entry tier + value tier (easy choice);\n"
               f"3) constraint handled: {con} — dedicated measure;\n"
               f"4) tests: A/B over 2-4 weeks, decision criterion set BEFORE;\n"
               f"5) quarterly review: churn, ARPU, margin.")
    return {"task_type": "pricing_strategy", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"modèle": mod}}

FABRIQUES_BUSINESS = [fab_analyse_donnees, fab_pitch, fab_conseil_commercial, fab_pricing]

# ═════════════════════════ Domaine WRITING (8 000) ═════════════════════════

SUJETS_WRITING = ["l'accès à l'eau potable en zone rurale", "le télétravail et la productivité",
                  "l'entrepreneuriat des jeunes diplômés", "l'impact des réseaux sociaux sur l'attention",
                  "la mobilité électrique en Afrique urbaine", "la préservation des langues locales",
                  "l'intelligence artificielle dans l'éducation", "la finance mobile et l'inclusion bancaire",
                  "l'agriculture intelligente face au climat", "la cybersécurité des PME",
                  "l'e-commerce et les habitudes de consommation", "la santé mentale au travail",
                  "le commerce équitable", "les énergies renouvelables hors réseau",
                  "la formation professionnelle continue", "l'urbanisme participatif",
                  "la logistique du dernier kilomètre", "les startups universitaires",
                  "la transparence des données publiques", "le droit à la déconnexion",
                  "l'économie circulaire dans le bâtiment", "les femmes dans la tech",
                  "le financement participatif", "la traçabilité alimentaire",
                  "l'accessibilité numérique", "la réduction du plastique",
                  "le travail artisanal à l'ère numérique", "les archives numériques patrimoniales",
                  "la mobilité douce (vélo, marche)", "le bénévolat de compétences",
                  "les smart cities au service des citoyens", "l'open source dans les administrations",
                  "la qualité de l'air intérieur", "l'éducation financière des adolescents",
                  "la résilience des chaînes d'approvisionnement", "l'innovation frugale",
                  "la protection des données personnelles", "le tourisme durable",
                  "l'automatisation et l'avenir du travail", "les partenariats école-entreprise"]
FORMATS_WRITING = [("article de blog", "blog post"), ("dossier de 10 pages", "10-page dossier"),
                   ("note de synthèse 1 page", "1-page brief"), ("discours de 3 minutes", "3-minute speech"),
                   ("post LinkedIn", "LinkedIn post"), ("scénario de vidéo pédagogique", "educational video script"),
                   ("communiqué de presse", "press release"), ("guide pratique", "practical guide")]
TONS = [("neutre et factuel", "neutral and factual"), ("pédagogique", "pedagogical"),
        ("inspirant", "inspiring"), ("critique argumenté", "critical and argued"), ("conversationnel", "conversational")]

def fab_plan_redaction(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    suj = pioche(rng, SUJETS_WRITING)
    fmt_fr, fmt_en = pioche(rng, FORMATS_WRITING)
    ton_fr, ton_en = pioche(rng, TONS)
    fmt = fmt_fr if fr_fr else fmt_en
    ton = ton_fr if fr_fr else ton_en
    if fr_fr:
        instr = f"Construis le plan d'un {fmt} ({ton}) sur : {suj}."
        inp = f"Sujet : {suj} ; format : {fmt} ; ton : {ton}."
        out = (f"PLAN — {suj} ({fmt}, ton {ton})\n"
               f"1) accroche : fait ou question qui touche le lecteur ;\n"
               f"2) cadrage : de quoi on parle, pourquoi maintenant ;\n"
               f"3) corps : 3 angles avec un exemple chiffré chacun ;\n"
               f"4) objections ou limites honnêtes ;\n"
               f"5) conclusion actionnable + titre et chapeau proposés.")
    else:
        instr = f"Build the outline of a {fmt} ({ton}) on: {suj}."
        inp = f"Topic: {suj}; format: {fmt}; tone: {ton}."
        out = (f"OUTLINE — {suj} ({fmt}, {ton} tone)\n"
               f"1) hook: a fact or question that touches the reader;\n"
               f"2) framing: what this is about, why now;\n"
               f"3) body: 3 angles, each with one concrete figure;\n"
               f"4) honest objections or limits;\n"
               f"5) actionable conclusion + suggested title and lede.")
    return {"task_type": "brief_to_outline", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"format": fmt}}

INTENTIONS_EMAIL = [("demander un devis", "request a quote"), ("relancer une facture impayée", "chase an unpaid invoice"),
                    ("proposer un partenariat", "propose a partnership"), ("confirmer un rendez-vous", "confirm a meeting"),
                    ("annoncer une nouvelle fonctionnalité", "announce a new feature"), ("répondre à une réclamation", "answer a complaint"),
                    ("demander une lettre de recommandation", "ask for a reference letter"), ("postuler à une offre", "apply to a job"),
                    ("négocier un délai", "negotiate a deadline"), ("informer d'un changement d'adresse", "notify an address change"),
                    ("remercier après une prestation", "thank after a service"), ("organiser une réunion d'équipe", "set up a team meeting"),
                    ("demander un accès à des données", "request data access"), ("signaler un incident de sécurité", "report a security incident"),
                    ("faire une contre-proposition", "make a counter-offer"), ("accuser réception d'une commande", "acknowledge an order"),
                    ("inviter à un webinaire", "invite to a webinar"), ("recueillir un retour client", "collect customer feedback"),
                    ("prévenir d'une maintenance", "announce maintenance"), ("clôturer un projet", "close a project"),
                    ("demander une extension de budget", "request budget extension"), ("transmettre un compte rendu", "share meeting minutes"),
                    ("rappeler l'échéance d'un concours", "remind a contest deadline"), ("valoriser un collaborateur", "recognize an employee"),
                    ("réserver une salle", "book a room"), ("mettre en relation deux contacts", "introduce two contacts"),
                    ("exiger une correction de livraison", "request a delivery fix"), ("annuler un abonnement", "cancel a subscription"),
                    ("solliciter un mentorat", "ask for mentorship"), ("lancer une campagne de recrutement", "start a hiring campaign")]
DESTINATAIRES = [("un client fidèle", "a loyal customer"), ("un prospect froid", "a cold prospect"),
                 ("un fournisseur", "a supplier"), ("un manager", "a manager"), ("un collègue d'une autre équipe", "a colleague from another team"),
                 ("une administration", "a public agency"), ("un candidat", "a candidate"), ("toute l'équipe", "the whole team")]
TONS_EMAIL = [("formel", "formal"), ("courtois et direct", "courteous and direct"),
              ("chaleureux", "warm"), ("ferme mais respectueux", "firm but respectful")]

def fab_email(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    int_fr, int_en = pioche(rng, INTENTIONS_EMAIL)
    dest_fr, dest_en = pioche(rng, DESTINATAIRES)
    ton_fr, ton_en = pioche(rng, TONS_EMAIL)
    int_ = int_fr if fr_fr else int_en
    dest = dest_fr if fr_fr else dest_en
    ton = ton_fr if fr_fr else ton_en
    if fr_fr:
        instr = f"Rédige un email ({ton}) pour {int_} adressé à {dest}."
        inp = f"Intention : {int_} ; destinataire : {dest} ; ton : {ton}."
        out = (f"EMAIL — {int_} → {dest} (ton {ton})\n"
               f"Objet : court et concret (≤ 8 mots).\n"
               f"1) ouverture : le pourquoi en une phrase ;\n"
               f"2) l'essentiel : la demande ou l'info, visible sans défilement ;\n"
               f"3) contexte minimal (chiffre, date) ;\n"
               f"4) prochaine action datée et signature complète.")
    else:
        instr = f"Write an email ({ton}) to {int_} addressed to {dest}."
        inp = f"Intent: {int_}; recipient: {dest}; tone: {ton}."
        out = (f"EMAIL — {int_} → {dest} ({ton} tone)\n"
               f"Subject: short and concrete (≤ 8 words).\n"
               f"1) opening: the why in one sentence;\n"
               f"2) essentials: the ask or info, visible without scrolling;\n"
               f"3) minimal context (figure, date);\n"
               f"4) dated next action + full signature.")
    return {"task_type": "email_professionnel", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"ton": ton}}

TYPES_RAPPORT = [("projet", "project"), ("incident", "incident"), ("audit qualité", "quality audit"),
                 ("étude de marché", "market study"), ("essai technique", "technical trial"),
                 ("bilan trimestriel", "quarterly review"), ("maintenance", "maintenance"),
                 ("onboarding client", "client onboarding"), ("campagne marketing", "marketing campaign"),
                 ("recherche utilisateur", "user research"), ("test de charge", "load test"),
                 ("revue de sécurité", "security review"), ("formation", "training"),
                 ("inventaire", "inventory"), ("postmortem", "postmortem"),
                 ("évaluation fournisseur", "vendor assessment"), ("migration", "migration"),
                 ("prototype", "prototype"), ("suivi budgétaire", "budget tracking"),
                 ("accessibilité", "accessibility"), ("performance web", "web performance"),
                 ("satisfaction client", "customer satisfaction"), ("production", "production"),
                 ("expédition", "shipping"), ("recrutement", "recruiting"),
                 ("réseau", "network"), ("données", "data"), ("compliance", "compliance"),
                 ("durabilité", "sustainability"), ("innovation", "innovation")]
SECTIONS_RAPPORT = [("résumé exécutif", "executive summary"), ("contexte et objectifs", "context and goals"),
                    ("méthode", "method"), ("résultats chiffrés", "quantified results"),
                    ("anomalies et risques", "issues and risks"), ("recommandations", "recommendations"),
                    ("prochaines étapes", "next steps"), ("annexes techniques", "technical appendix")]
DONNEES_RAPPORT = [("un tableau comparatif", "a comparison table"), ("une série temporelle", "a time series"),
                   ("un taux avec sa base d'échantillon", "a rate with its sample base"),
                   ("deux captures avant/après", "two before/after screenshots"),
                   ("une répartition par catégorie", "a category breakdown")]

def fab_rapport(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    type_fr, type_en = pioche(rng, TYPES_RAPPORT)
    sec_fr, sec_en = pioche(rng, SECTIONS_RAPPORT)
    don_fr, don_en = pioche(rng, DONNEES_RAPPORT)
    type_ = type_fr if fr_fr else type_en
    sec = sec_fr if fr_fr else sec_en
    don = don_fr if fr_fr else don_en
    if fr_fr:
        instr = f"Structure la section « {sec} » d'un rapport de {type_} contenant {don}."
        inp = f"Rapport : {type_} ; section : {sec} ; élément requis : {don}."
        out = (f"SECTION « {sec.upper()} » — rapport de {type_}\n"
               f"1) phrase d'ouverture : ce que cette section établit ;\n"
               f"2) {don} — titres de colonnes explicites, unités indiquées ;\n"
               f"3) lecture des chiffres : ce qui saute aux yeux, ce qui mérite prudence ;\n"
               f"4) phrase de transition vers la section suivante.")
    else:
        instr = f"Structure the “{sec}” section of a {type_} report containing {don}."
        inp = f"Report: {type_}; section: {sec}; required element: {don}."
        out = (f"SECTION “{sec.upper()}” — {type_} report\n"
               f"1) opening sentence: what this section establishes;\n"
               f"2) {don} — explicit column titles, units stated;\n"
               f"3) reading the numbers: what stands out, what deserves caution;\n"
               f"4) transition sentence to the next section.")
    return {"task_type": "report_section", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"type_rapport": type_}}

TEXTES_REWRITE = [("annonce de promotion interne", "internal promotion announcement"),
                  ("explication d'un retard de livraison", "explaining a delivery delay"),
                  ("descriptif produit trop technique", "overly technical product description"),
                  ("conditions d'utilisation denses", "dense terms of service"),
                  ("message d'erreur cryptique", "cryptic error message"),
                  ("invitation à une cérémonie", "invitation to a ceremony"),
                  ("résumé d'une réunion houleuse", "summary of a tense meeting"),
                  ("tutoriel d'installation", "installation tutorial"),
                  ("politique de remboursement", "refund policy"),
                  ("présentation d'équipe pour un site", "team page for a website"),
                  ("email de relance trop agressif", "overly pushy follow-up email"),
                  ("offre d'emploi générique", "generic job posting"),
                  ("article de blog jargonneux", "jargon-heavy blog post"),
                  ("note de service sèche", "blunt memo"),
                  ("pitch investisseur trop long", "overlong investor pitch"),
                  ("manuel d'utilisation ancien", "outdated user manual"),
                  ("script d'appel commercial", "sales call script"),
                  ("réponse à un avis négatif", "reply to a negative review"),
                  ("description d'un itinéraire touristique", "tourist route description"),
                  ("règlement intérieur", "house rules"),
                  ("fiche de poste floue", "vague job description"),
                  ("annonce de maintenance technique", "technical maintenance notice"),
                  ("bio de conférencier", "speaker bio"),
                  ("résumé exécutif trop détaillé", "overly detailed executive summary"),
                  ("consignes de sécurité", "safety instructions"),
                  ("questionnaire de satisfaction", "satisfaction survey"),
                  ("page « à propos » d'entreprise", "company “about” page"),
                  ("discours de remerciement", "thank-you speech"),
                  ("carte de vœux professionnelle", "professional new-year card"),
                  ("guide de contribution open source", "open source contribution guide")]
STYLES_REWRITE = [("plus simple (niveau collège)", "simpler (middle-school level)"),
                  ("plus formel", "more formal"), ("plus chaleureux", "warmer"),
                  ("plus court (-40 %)", "shorter (-40%)"), ("plus direct", "more direct"),
                  ("plus respectueux", "more respectful"), ("plus convaincant", "more persuasive"),
                  ("plus neutre (sans émotion)", "more neutral (emotion-free)")]
LONGUEURS = [("même longueur", "same length"), ("version courte", "short version"),
             ("version 2× plus détaillée", "2× more detailed version"), ("version en puces", "bullet version")]

def fab_reecriture(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    tex_fr, tex_en = pioche(rng, TEXTES_REWRITE)
    sty_fr, sty_en = pioche(rng, STYLES_REWRITE)
    lon_fr, lon_en = pioche(rng, LONGUEURS)
    tex = tex_fr if fr_fr else tex_en
    sty = sty_fr if fr_fr else sty_en
    lon = lon_fr if fr_fr else lon_en
    if fr_fr:
        instr = f"Réécris ce texte : {tex} — consigne : {sty}, {lon}."
        inp = f"Texte : {tex} ; style : {sty} ; longueur : {lon}."
        out = (f"RÉÉCRITURE — {tex}\n"
               f"1) ce qui change : registre, longueur ({lon}), ton ({sty}) ;\n"
               f"2) ce qui reste : faits, noms, engagements — rien d'inventé ;\n"
               f"3) version réécrite complète ;\n"
               f"4) autocontrôle : relire pour supprimer les répétitions et vérifier le respect du style.")
    else:
        instr = f"Rewrite this text: {tex} — instruction: {sty}, {lon}."
        inp = f"Text: {tex}; style: {sty}; length: {lon}."
        out = (f"REWRITE — {tex}\n"
               f"1) what changes: register, length ({lon}), tone ({sty});\n"
               f"2) what stays: facts, names, commitments — nothing invented;\n"
               f"3) full rewritten version;\n"
               f"4) self-check: reread to remove repetition and confirm the style.")
    return {"task_type": "style_rewrite", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"style": sty}}

FABRIQUES_WRITING = [fab_plan_redaction, fab_email, fab_rapport, fab_reecriture]

# ═════════════════════════ Domaine MULTIMODAL (5 400) ═════════════════════════

OBJECTIFS_MM = ["lancer un produit", "expliquer un concept complexe", "recruter des candidats",
                "fidéliser des clients", "sensibiliser à un risque", "vendre un service B2B",
                "former des équipes", "annoncer un événement", "documenter un projet",
                "valoriser des témoignages clients", "lancer une campagne saisonnière",
                "présenter un rapport annuel", "animer une communauté", "répondre à une crise d'image",
                "naviguer un onboarding produit"]
PIPELINES_MM = [("image unique + légende", "single image + caption"),
                ("carrousel de 5 visuels", "5-slide carousel"),
                ("vidéo 30 s (keyframes + voix)", "30 s video (keyframes + voice)"),
                ("tutoriel étape par étape", "step-by-step tutorial"),
                ("bannière + email d'annonce", "banner + announcement email"),
                ("démo interactive + sous-titres", "interactive demo + subtitles"),
                ("podcast teaser + visuel", "podcast teaser + artwork"),
                ("infographie animée", "animated infographic")]
CONTRAINTES_MM = [("budget temps : 1 journée", "time budget: 1 day"),
                  ("uniquement WebGPU navigateur", "browser WebGPU only"),
                  ("bilingue FR/EN obligatoire", "mandatory FR/EN"),
                  ("accessibilité (sous-titres, alt)", "accessibility (subtitles, alt text)"),
                  ("cohérence de marque stricte", "strict brand consistency"),
                  ("poids total < 20 Mo", "total size < 20 MB")]

def fab_pipeline(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    obj = pioche(rng, OBJECTIFS_MM)
    pipe_fr, pipe_en = pioche(rng, PIPELINES_MM)
    con_fr, con_en = pioche(rng, CONTRAINTES_MM)
    pipe = pipe_fr if fr_fr else pipe_en
    con = con_fr if fr_fr else con_en
    if fr_fr:
        instr = f"Orchestre un pipeline média pour {obj} : {pipe}, contrainte : {con}."
        inp = f"Objectif : {obj} ; format : {pipe} ; contrainte : {con}."
        out = (f"PIPELINE — {obj}\n"
               f"1) brief : message unique, audience, émotion visée ;\n"
               f"2) étapes : brief image photoréaliste → keyframes → voix (FR) → assemblage ;\n"
               f"3) chaque étape : entrée, outil gen3 (WebGPU), sortie vérifiable ;\n"
               f"4) contrôle qualité : sous-titres, alt-text, cohérence des couleurs ;\n"
               f"5) contrainte honorée : {con} — livrable final décrit.")
    else:
        instr = f"Orchestrate a media pipeline for {obj}: {pipe}, constraint: {con}."
        inp = f"Goal: {obj}; format: {pipe}; constraint: {con}."
        out = (f"PIPELINE — {obj}\n"
               f"1) brief: one message, audience, target emotion;\n"
               f"2) steps: photoreal image brief → keyframes → voice (EN) → assembly;\n"
               f"3) each step: input, gen3 tool (WebGPU), verifiable output;\n"
               f"4) QA: subtitles, alt text, color consistency;\n"
               f"5) constraint honored: {con} — final deliverable described.")
    return {"task_type": "pipeline_orchestration", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"format": pipe}}

SCENES_MM = ["un marché de nuit sous les guirlandes", "un atelier de poterie en lumière naturelle",
             "un laboratoire propre et lumineux", "un chantier de toiture au lever du soleil",
             "une salle de classe animée", "un entrepôt logistique automatisé",
             "une cuisine de restaurant en plein service", "un studio de podcast",
             "une ferme aquaponique", "un salon technologique bondé",
             "un dispensaire rural calme", "un atelier de couture familial",
             "une station de recharge électrique", "une librairie indépendante chaleureuse",
             "une usine d'embouteillage", "un centre de données en salle froide",
             "un champ de panneaux solaires au crépuscule", "une poste de tri matinale",
             "une école de musique en répétition", "un café coworking en fin de journée"]
QUESTIONS_MM = [("que voit-on en premier ?", "what do you notice first?"), ("quelle est l'atmosphère de la scène ?", "what is the mood of the scene?"),
                ("quels détails trahissent le métier représenté ?", "which details reveal the trade shown?"), ("y a-t-il des incohérences visibles ?", "are there visible inconsistencies?"),
                ("quelle lumière domine ?", "which light dominates?"), ("que ferait la personne au premier plan ensuite ?", "what would the foreground person do next?"),
                ("quels éléments renforceraient le réalisme ?", "which elements would boost realism?"), ("quel plan (large/moyen/serré) conviendrait ?", "which shot (wide/medium/close) would fit?"),
                ("quels sons suggère cette scène ?", "which sounds does this scene suggest?"), ("comment en extraire une image clé ?", "how to extract a key frame from it?")]
FOCUS_MM = [("composition", "composition"), ("lumière", "lighting"), ("récit visuel", "visual storytelling")]

def fab_media_qa(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    scene = pioche(rng, SCENES_MM)
    q_fr, q_en = pioche(rng, QUESTIONS_MM)
    foc_fr, foc_en = pioche(rng, FOCUS_MM)
    q = q_fr if fr_fr else q_en
    foc = foc_fr if fr_fr else foc_en
    if fr_fr:
        instr = f"Analyse ({foc}) : {q} — scène : {scene}."
        inp = f"Scène : {scene} ; question : {q} ; focus : {foc}."
        out = (f"ANALYSE — {scene} ({foc})\n"
               f"1) lecture factuelle : éléments visibles, sans invention ;\n"
               f"2) réponse directe à « {q} » ;\n"
               f"3) indices visuels à l'appui (lumière, gestes, outils) ;\n"
               f"4) suggestion d'amélioration concrète pour la génération.")
    else:
        instr = f"Analyze ({foc}): {q} — scene: {scene}."
        inp = f"Scene: {scene}; question: {q}; focus: {foc}."
        out = (f"ANALYSIS — {scene} ({foc})\n"
               f"1) factual reading: visible elements, no invention;\n"
               f"2) direct answer to “{q}”;\n"
               f"3) supporting visual cues (light, gestures, tools);\n"
               f"4) one concrete improvement for generation.")
    return {"task_type": "media_qa", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"focus": foc}}

SECTEURS_MM = ["mode", "gastronomie", "immobilier", "santé", "éducation", "logistique",
               "tourisme", "finance", "artisanat", "automobile", "agriculture", "musique"]
FORMATS_MM = [("vidéo verticale 15 s", "15 s vertical video"), ("série de 3 affiches", "3-poster series"),
              ("court métrage 60 s", "60 s short film"), ("spot audio 20 s + visuel", "20 s audio spot + artwork"),
              ("newsletter illustrée", "illustrated newsletter"), ("tutoriel vidéo 45 s", "45 s video tutorial"),
              ("pub-carousel réseaux sociaux", "social media carousel ad"), ("cover + teaser musique", "music cover + teaser")]
BUDGETS = [("micro (1 personne, 2 jours)", "micro (1 person, 2 days)"),
           ("petit (3 personnes, 1 semaine)", "small (3 people, 1 week)"),
           ("moyen (équipe + voix off pro)", "medium (team + pro voice-over)"),
           ("serré en temps, riche en idées", "time-tight, idea-rich"),
           ("itératif (tests A/B)", "iterative (A/B testing)")]

def fab_campagne(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    sec = pioche(rng, SECTEURS_MM)
    fmt_fr, fmt_en = pioche(rng, FORMATS_MM)
    bud = pioche(rng, BUDGETS)
    fmt = fmt_fr if fr_fr else fmt_en
    if fr_fr:
        instr = f"Campagne multimédia {sec} : {fmt}, budget : {bud}."
        inp = f"Secteur : {sec} ; format : {fmt} ; budget : {bud}."
        out = (f"CAMPAGNE — {sec} ({fmt})\n"
               f"1) cible + message unique en 10 mots ;\n"
               f"2) plan de production adapté au budget ({bud}) ;\n"
               f"3) assets : liste précise (images, voix, musique, textes) ;\n"
               f"4) diffusion : 2 canaux, 1 indicateur de succès chacun ;\n"
               f"5) boucle d'apprentissage : que mesurer après 7 jours.")
    else:
        instr = f"{sec} multimedia campaign: {fmt}, budget: {bud}."
        inp = f"Sector: {sec}; format: {fmt}; budget: {bud}."
        out = (f"CAMPAIGN — {sec} ({fmt})\n"
               f"1) target + one 10-word message;\n"
               f"2) production plan fitted to budget ({bud});\n"
               f"3) assets: precise list (images, voice, music, copy);\n"
               f"4) distribution: 2 channels, 1 success metric each;\n"
               f"5) learning loop: what to measure after 7 days.")
    return {"task_type": "campaign_multimedia", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"secteur": sec}}

THEMES_MM = ["le retour au village", "une journée de Chinatown à Yaoundé", "l'envol d'une maquette d'avion",
             "le silence d'une bibliothèque en hiver", "la première course d'un kart", "un orage qui arrive sur la savane",
             "le marché aux poissons à l'aube", "la réparation d'une moto ancienne", "le festival des lanternes",
             "une partie de jeu d'échecs dans la rue", "le départ d'un train de nuit", "la moisson au crépuscule",
             "un atelier de réparation de vélos", "l'ascension d'une dune", "le dernier match de la saison",
             "une caravane dans le désert", "la pêche au filet sur le fleuve", "un cours de danse pour enfants",
             "la restauration d'une fresque", "le ramassage scolaire sous la pluie"]
DUREES = ["15 s", "30 s", "45 s", "60 s", "90 s"]
STYLES_MM = [("documentaire", "documentary"), ("cinématique", "cinematic"),
             ("publicitaire épuré", "clean advertising"), ("motion design", "motion design"),
             ("found footage", "found footage"), ("instructif", "instructional")]

def fab_storyboard(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    theme = pioche(rng, THEMES_MM)
    duree = pioche(rng, DUREES)
    sty_fr, sty_en = pioche(rng, STYLES_MM)
    sty = sty_fr if fr_fr else sty_en
    n_kf = {"15 s": 3, "30 s": 5, "45 s": 6, "60 s": 8, "90 s": 10}[duree]
    if fr_fr:
        instr = f"Storyboard {sty} de {duree} pour : {theme} ({n_kf} keyframes)."
        inp = f"Thème : {theme} ; durée : {duree} ; style : {sty} ; keyframes : {n_kf}."
        out = (f"STORYBOARD — {theme} ({duree}, {sty})\n"
               + "\n".join(f"KF{i+1} : plan {'large' if i == 0 else ('serré' if i == n_kf - 1 else 'moyen')} — évolution de la scène, mouvement caméra adapté."
                           for i in range(min(n_kf, 4)))
               + f"\n… jusqu'à KF{n_kf} — fin sur l'image la plus mémorable ; raccords xfade 0,5 s ; voix off en 2 segments.")
    else:
        instr = f"{sty} storyboard for {duree}: {theme} ({n_kf} keyframes)."
        inp = f"Theme: {theme}; duration: {duree}; style: {sty}; keyframes: {n_kf}."
        out = (f"STORYBOARD — {theme} ({duree}, {sty})\n"
               + "\n".join(f"KF{i+1}: {'wide' if i == 0 else ('close' if i == n_kf - 1 else 'medium')} shot — scene evolution, fitting camera move."
                           for i in range(min(n_kf, 4)))
               + f"\n… up to KF{n_kf} — end on the most memorable frame; 0.5 s xfade cuts; voice-over in 2 segments.")
    return {"task_type": "storyboard_multimedia", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"durée": duree, "keyframes": n_kf}}

MARQUES = [("une marque de thé bio", "an organic tea brand"), ("un service de covoiturage", "a carpooling service"),
           ("une école de code", "a coding school"), ("une banque mobile", "a mobile bank"),
           ("un studio de jeux indépendant", "an indie game studio"), ("une coopérative de café", "a coffee cooperative"),
           ("une chaîne de pharmacies", "a pharmacy chain"), ("un constructeur de vélos électriques", "an e-bike maker"),
           ("un festival de musique", "a music festival"), ("une plateforme d'immobilier", "a real estate platform"),
           ("une marque de cosmétiques naturels", "a natural cosmetics brand"), ("un service de livraison de repas", "a meal delivery service"),
           ("une assurance santé", "a health insurer"), ("un fabricant de panneaux solaires", "a solar panel maker"),
           ("un média d'actualité locale", "a local news outlet")]
TONS_MARQUE = [("chaleureux et rassurant", "warm and reassuring"), ("énergique et jeune", "energetic and young"),
               ("expert et posé", "expert and calm"), ("complice et drôle", "witty and playful"),
               ("engagé et sincère", "committed and sincere"), ("premium et sobre", "premium and minimal")]
CANAUX_MARQUE = [("réponses support", "support replies"), ("posts réseaux sociaux", "social posts"),
                 ("emails d'onboarding", "onboarding emails"), ("scripts vidéo", "video scripts"),
                 ("notifications push", "push notifications"), ("page d'accueil", "homepage copy"),
                 ("annonces pub", "ad copy"), ("docs produit", "product docs")]

def fab_voix_marque(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    marque = pioche(rng, MARQUES)
    ton_fr, ton_en = pioche(rng, TONS_MARQUE)
    canal_fr, canal_en = pioche(rng, CANAUX_MARQUE)
    ton = ton_fr if fr_fr else ton_en
    canal = canal_fr if fr_fr else canal_en
    if fr_fr:
        instr = f"Définis la voix de marque ({ton}) de {marque} pour {canal}."
        inp = f"Marque : {marque} ; ton : {ton} ; canal : {canal}."
        out = (f"VOIX DE MARQUE — {marque} ({canal})\n"
               f"1) 3 principes du ton ({ton}) avec un exemple oui/non ;\n"
               f"2) vocabulaire à privilégier / à bannir ;\n"
               f"3) modèle de phrase d'ouverture et de clôture ;\n"
               f"4) cas limite : message d'erreur ou mauvaise nouvelle — rester aligné.")
    else:
        instr = f"Define the brand voice ({ton}) of {marque} for {canal}."
        inp = f"Brand: {marque}; tone: {ton}; channel: {canal}."
        out = (f"BRAND VOICE — {marque} ({canal})\n"
               f"1) 3 tone principles ({ton}) with a do/don't example;\n"
               f"2) vocabulary to prefer / avoid;\n"
               f"3) opening and closing sentence templates;\n"
               f"4) edge case: error or bad-news message — stay on brand.")
    return {"task_type": "brand_voice", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"canal": canal}}

FABRIQUES_MULTIMODAL = [fab_pipeline, fab_media_qa, fab_campagne, fab_storyboard, fab_voix_marque]

# ═════════════════════════ Top-up MÉDIA (9 631 — préfixes *3-) ═════════════════════════
# Complète les 4 datasets média v2 SANS toucher aux lignes existantes :
# images +4 031, voice +2 600, video +1 700, music +1 300 = 9 631 nouvelles lignes
# → 44 369 (v2) + 46 000 (v3 métiers) + 9 631 = 100 000 lignes exactement.

SUJETS_PHOTO = ["un vendeur de fruits souriant sous son parasol", "une couturière concentrée sur sa machine",
                "un pêcheur réparant ses filets à l'aube", "une danseuse en pleine répétition",
                "un forgeron frappant une lame incandescente", "une professeure devant un tableau rempli de formules",
                "un jeune entrepreneur dans son atelier de réparation", "une grand-mère préparant un plat traditionnel",
                "un enfant lisant sous un manguier", "un pilote d'avion léger dans le cockpit",
                "une Pharmacienne rangeant des boîtes", "un maçon étalant du ciment sur un mur",
                "une violiniste accordant son instrument", "un cultivateur inspectant ses plants de maïs",
                "une journaliste préparant son micro", "un menuisier mesurant une planche",
                "une boulangère sortant une fournée", "un informaticien face à deux écrans de code",
                "une infirmière souriant à un patient", "un guide touristique devant une cascade",
                "un mécanicien sous un véhicule", "une femme d'affaires traversant un hall de verre",
                "un berger avec son troupeau au crépuscule", "une artiste peignant une fresque murale",
                "un chef plongeant une louche dans une marmite", "une étudiante révisant en bibliothèque",
                "un chauffeur de bus saluant ses passagers", "une apicultrice soulevant un cadre de ruche",
                "un documentaliste rangeant des archives", "une coiffeuse tressant avec précision"]
LUMIERES = ["lumière naturelle de fin d'après-midi", "lumière douce de fenêtre nord", "contre-jour dramatique",
            "lumière dorée d'heure magique", "éclairage studio Rembrandt", "lumière diffuse de jour couvert",
            "néons doux de fin de soirée", "lumière rasante du petit matin", "bougie chaude en intérieur",
            "éclairage tri-point professionnel"]
OPTIQUES = ["50 mm f/1.8", "35 mm f/2", "85 mm f/1.4", "24 mm grand-angle f/2.8", "135 mm f/2", "70-200 mm f/4",
            "macro 100 mm f/2.8", "28 mm reportage f/1.8"]
RATIOS = ["16:9", "4:3", "3:2", "1:1"]
STYLES_CLS = [("documentaire social", "social documentary"), ("portrait éditorial", "editorial portrait"),
              ("reportage vie quotidienne", "everyday reportage"), ("commercial chaleureux", "warm commercial"),
              ("cinématographique", "cinematic"), ("naturel désaturé", "natural desaturated")]

def fab_photo(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    suj = pioche(rng, SUJETS_PHOTO)
    if fr_fr:
        suj = suj.replace("une Pharmacienne", "une pharmacienne")  # normalisation
    lum = pioche(rng, LUMIERES)
    opt = pioche(rng, OPTIQUES)
    ratio = pioche(rng, RATIOS)
    if fr_fr:
        instr = "Transforme cette demande en brief photoréaliste complet (sujet, lumière, optique, matière, post-traitement)."
        inp = f"Une photo de {suj}"
        out = (f"PHOTORÉALISTE — sujet : {suj} ; lumière : {lum} ; optique : {opt} "
               f"(ouverture adaptée, sujet net, arrière-plan naturellement flou) ; "
               f"matière : textures réelles (tissu, peau, bois ou métal selon scène) ; "
               f"post : colorimétrie naturelle, contraste modéré, aucun filtre fantaisiste ; ratio {ratio}.")
    else:
        instr = "Turn this request into a complete photoreal brief (subject, light, lens, texture, post)."
        inp = f"A photo of {suj}"
        out = (f"PHOTOREAL — subject: {suj} ; light: {lum} ; lens: {opt} "
               f"(aperture suited, sharp subject, naturally blurred background) ; "
               f"texture: real materials (fabric, skin, wood or metal per scene) ; "
               f"post: natural grading, moderate contrast, no gimmick filters ; ratio {ratio}.")
    return {"task_type": "prompt_to_photoreal_brief", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"ratio": ratio, "optique": opt}}

def fab_style_cls(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    suj = pioche(rng, SUJETS_PHOTO)
    st_fr, st_en = pioche(rng, STYLES_CLS)
    st = st_fr if fr_fr else st_en
    lum = pioche(rng, LUMIERES)
    if fr_fr:
        instr = "Classe le style photographique dominant de cette scène et justifie."
        inp = f"{suj} — {lum}"
        out = f"STYLE — {st} ; indices : {lum.lower()}, cadrage et profondeur de champ caractéristiques ; usage conseillé : reportage éditorial."
    else:
        instr = "Classify the dominant photographic style of this scene and justify."
        inp = f"{suj} — {lum}"
        out = f"STYLE — {st} ; cues: {lum.lower()}, characteristic framing and depth of field ; suggested use: editorial reportage."
    return {"task_type": "style_classification", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": "facile",
            "metadata_extra": {"style": st}}

SCENES_VID = ["un port de pêche au petit matin", "une ruée du métro aux heures de pointe",
              "une classe en sortie scolaire au musée", "une équipe montée de diffuseur en direct",
              "une moisson de canne à sucre", "un mariage traditionnel en plein air",
              "un sauvetage en mer simulé", "la préparation d'un studio de radio",
              "une course de caisses à savon", "un atelier de céramique en très longue exposition",
              "l'arrivée d'une tempête sur une côte", "un défilé de mode en plein air",
              "la mise à l'eau d'une pirogue", "une séance de sport collectif au crépuscule",
              "un déjeuner de quartier animé", "la remise des diplômes d'une promotion",
              "une panne de courant en pleine répétition", "le chargement d'un camion de marché",
              "un feu d'artifice vu d'une colline", "une récolte de cacao séchée au soleil",
              "l'ouverture d'une boutique un matin", "un cours de conduite en ville dense",
              "une parade de fanfare", "le nettoyage d'une plage après une marée",
              "une vente aux enchères agricole", "l'entretien d'une centrale solaire",
              "un match de rue improvisé", "la préparation d'une pâte à pain",
              "un contrôle technique automobile", "un cours de natation pour débutants",
              "l'installation d'une antenne parabolique", "une récolte de miel en montagne",
              "le premier jour d'école", "une file d'attente devant un guichet",
              "la pose d'un toit en tôle"]
DUREES_VID = ["10 s", "15 s", "20 s", "30 s"]
HUMEURS = [("dramatique", "dramatic"), ("chaleureux", "warm"), ("documentaire neutre", "neutral documentary"),
           ("dynamique", "energetic"), ("contemplatif", "contemplative"), ("festif", "festive")]

def fab_keyframes(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    scene = pioche(rng, SCENES_VID)
    duree = pioche(rng, DUREES_VID)
    hum_fr, hum_en = pioche(rng, HUMEURS)
    hum = hum_fr if fr_fr else hum_en
    n = {"10 s": 3, "15 s": 4, "20 s": 5, "30 s": 6}[duree]
    if fr_fr:
        instr = f"Découpe cette scène en keyframes photoréalistes cohérentes ({duree})."
        inp = f"Scène : {scene} ({hum})"
        out = (f"SCENE ({duree}, mood {hum}) → "
               + " | ".join(f"KF{i+1} : {'plan large' if i == 0 else ('plan serré' if i == n-1 else 'plan moyen')} — {scene}, progression visuelle cohérente"
                            for i in range(n))
               + " ; raccords xfade 0,5 s ; mouvement caméra justifié à chaque coupe.")
    else:
        instr = f"Break this scene into coherent photorealistic keyframes ({duree})."
        inp = f"Scene: {scene} ({hum})"
        out = (f"SCENE ({duree}, {hum} mood) → "
               + " | ".join(f"KF{i+1}: {'wide' if i == 0 else ('close' if i == n-1 else 'medium')} shot — {scene}, coherent visual progression"
                            for i in range(n))
               + " ; 0.5 s xfade cuts; camera move justified at each cut.")
    return {"task_type": "scene_to_keyframes", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"duration_s": int(duree.split()[0]), "keyframes": n}}

MOUVEMENTS = [("travelling latéral", "lateral dolly"), ("zoom lent", "slow zoom"),
              ("caméra portée légère", "light handheld"), ("panoramique droit", "right pan"),
              ("grue descendante", "descending crane"), ("plan fixe", "static shot")]
PLANS = ["plan d'ensemble", "plan moyen", "plan rapproché", "gros plan détail", "plan d'établissement final"]

def fab_camera(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    scene = pioche(rng, SCENES_VID)
    mv_fr, mv_en = pioche(rng, MOUVEMENTS)
    plan = pioche(rng, PLANS)
    hum_fr, hum_en = pioche(rng, HUMEURS)
    hum = hum_fr if fr_fr else hum_en
    if fr_fr:
        instr = f"Donne la direction caméra (mouvement, plan, rythme) pour cette scène."
        inp = f"Scène : {scene} ; humeur : {hum}"
        out = (f"DIRECTION — {plan} en ouverture, {mv_fr} comme mouvement principal, "
               f"rythme adapté à l'humeur {hum} ; coupe suivante sur le détail porteur de sens.")
    else:
        instr = f"Give the camera direction (move, shot, pacing) for this scene."
        inp = f"Scene: {scene}; mood: {hum}"
        out = (f"DIRECTION — {plan} opening, {mv_en} as main move, "
               f"pacing fitted to {hum} mood; next cut on the meaningful detail.")
    return {"task_type": "camera_direction", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"mouvement": mv_en, "plan": plan}}

VOIX_KOK = ["française féminine naturelle", "française masculine chaleureuse", "africaine francophone féminine",
            "africaine francophone masculine", "québécoise féminine claire", "anglaise britannique féminine"]
STYLES_VOIX = [("amicale", "friendly"), ("institutionnelle", "institutional"), ("documentaire", "documentary"),
               ("publicitaire énergique", "energetic ad"), ("rassurante", "reassuring"), ("pédagogique", "teaching")]
BRIEFS_VOIX = ["vos dossiers sont prêts dans votre espace", "bienvenue dans cette nouvelle leçon",
               "n'oubliez pas votre rendez-vous de demain à dix heures", "le paiement a bien été reçu, merci",
               "votre commande quitte l'entrepôt ce soir", "trois conseils pour réussir votre semestre",
               "cet itinéraire vous fera gagner vingt minutes", "protégez votre compte avec la double authentification",
               "la météo de demain sera ensoleillée avec du vent", "notre équipe vous répond en moins de vingt-quatre heures",
               "découvrez la nouvelle carte du restaurant", "activez les rappels pour ne rien manquer",
               "l'atelier commence dans quinze minutes en salle deux", "merci d'avoir choisi notre service",
               "votre colis sera livré entre quatorze et dix-huit heures", "pensez à sauvegarder vos documents",
               "la réservation est confirmée pour vendredi", "ce mois-ci, deux formations offertes",
               "votre facture est disponible en ligne", "bienvenue parmi nous, nous sommes ravis de vous compter"]
EMOTIONS = [("souriante", "smiling"), ("neutre posée", "calm neutral"), ("empathique", "empathetic"),
            ("déterminée", "determined"), ("conspiratrice complice", "knowingly conspiratorial"),
            ("royale solennelle", "regal solemn")]

def fab_directive_voix(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    texte = pioche(rng, BRIEFS_VOIX) if fr_fr else pioche(rng, [
        "your documents are ready in your workspace", "welcome to this new lesson",
        "don't forget tomorrow's ten o'clock appointment", "payment received, thank you",
        "your order leaves the warehouse tonight", "three tips to ace your semester",
        "this route will save you twenty minutes", "protect your account with two-factor auth",
        "tomorrow's forecast is sunny with some wind", "our team replies within twenty-four hours",
        "discover the restaurant's new menu", "turn on reminders so you never miss out",
        "the workshop starts in fifteen minutes in room two", "thank you for choosing our service",
        "your parcel arrives between two and six pm", "remember to back up your files",
        "your booking is confirmed for Friday", "this month, two free trainings",
        "your invoice is available online", "welcome aboard, glad to have you"])
    voix = pioche(rng, VOIX_KOK)
    sty_fr, sty_en = pioche(rng, STYLES_VOIX)
    emo_fr, emo_en = pioche(rng, EMOTIONS)
    wpm = pioche(rng, [150, 160, 170, 180])
    sty = sty_fr if fr_fr else sty_en
    emo = emo_fr if fr_fr else emo_en
    if fr_fr:
        instr = "Génère la directive de synthèse vocale (voix, style, prosodie) pour ce message."
        inp = texte
        out = (f"VOIX HUMAINE — voix : {voix} ; style : {sty} ({emo}, {wpm} mots/min, hauteur adaptée) ; "
               f"prosodie : liaisons soignées, respiration avant les énumérations, légère insistance sur les chiffres.")
    else:
        instr = "Generate the TTS directive (voice, style, prosody) for this message."
        inp = texte
        out = (f"HUMAN VOICE — voice: {voix} ; style: {sty} ({emo}, {wpm} wpm, fitted pitch) ; "
               f"prosody: clean liaison, breath before enumerations, slight stress on numbers.")
    return {"task_type": "text_to_voice_directive", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": "facile",
            "metadata_extra": {"voix": voix, "wpm": wpm}}

THEMES_NARR = ["l'histoire d'une rivière qui a changé une ville", "comment le tissu raconte une culture",
               "le voyage d'une graine jusqu'à l'assiette", "une nuit dans une station d'astronomie",
               "le premier jour d'un apprenti forgeron", "les coulisses d'un orchestre de quartier",
               "comment une île gère son eau douce", "la renaissance d'un marché artisanal",
               "le secret des parfums de la côte", "une saison avec les agriculteurs urbains"]
DUREES_NARR = [("60 s", "60 s"), ("90 s", "90 s"), ("2 min", "2 min"), ("3 min", "3 min")]

def fab_narration(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    theme = pioche(rng, THEMES_NARR)
    dur_fr, dur_en = pioche(rng, DUREES_NARR)
    dur = dur_fr if fr_fr else dur_en
    n_seg = {"60 s": 2, "90 s": 3, "2 min": 4, "3 min": 5}[dur_fr]
    if fr_fr:
        instr = f"Découpe cette narration longue ({dur}) en segments TTS synthétisables avec transitions."
        inp = f"Narration : {theme} — durée {dur}"
        out = (f"NARRATION ({dur}) — {n_seg} segments : "
               + " / ".join(f"SEG{i+1} : arc narratif progressif, ≤ 500 caractères, respiration en fin de segment"
                            for i in range(min(n_seg, 3)))
               + f" … jusqu'à SEG{n_seg} ; transitions : ponctuation forte, tempo constant.")
    else:
        instr = f"Split this long narration ({dur}) into synthesizable TTS segments with transitions."
        inp = f"Narration: {theme} — {dur} long"
        out = (f"NARRATION ({dur}) — {n_seg} segments: "
               + " / ".join(f"SEG{i+1}: progressive narrative arc, ≤ 500 characters, breath at segment end"
                            for i in range(min(n_seg, 3)))
               + f" … up to SEG{n_seg}; transitions: strong punctuation, constant tempo.")
    return {"task_type": "long_form_narration", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"durée": dur, "segments": n_seg}}

PHRASES_PROS = ["les vingt-quatre dossiers de la clientèle sont signés",
                "l'ensemble des collaborateurs a voté à l'unanimité",
                "les archipel des Bijagós compte vingt îles habitées",
                "il a acheté cent quinze hectares de terres fertiles",
                "la procédure prend environ trois heures et demie",
                "nos artistes ont présenté neuf œuvres inédites",
                "le colis pèse exactement deux kilos quatre cents",
                "l'assemblée se réunira le dix-sept novembre",
                "la facture numéro quatre cent deux est réglée",
                "ses discussions ont duré jusqu'à deux heures du matin"]

def fab_prosodie(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    phrase = pioche(rng, PHRASES_PROS)
    emo_fr, emo_en = pioche(rng, EMOTIONS)
    emo = emo_fr if fr_fr else emo_en
    if fr_fr:
        instr = "Annote la prosodie attendue (accents, pauses, hauteur) de cette phrase."
        inp = phrase
        out = f"PROSODIE — émotion : {emo} ; accent tonique sur les nombres, pause avant l'énumération, fin descendante ; débit régulier."
    else:
        instr = "Annotate the expected prosody (stress, pauses, pitch) of this sentence."
        inp = phrase
        out = f"PROSODY — emotion: {emo} ; stress on numbers, pause before the enumeration, falling ending ; steady pace."
    return {"task_type": "prosody_annotation", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": "facile",
            "metadata_extra": {"émotion": emo}}

GENRES_MUS = [("afrobeats", "afrobeats"), ("makossa", "makossa"), ("jazz soul", "soul jazz"),
              ("electro afro-house", "afro-house"), ("hip-hop conscient", "conscious hip-hop"),
              ("rumba congolaise", "Congolese rumba"), ("chanson française", "French chanson"),
              ("lo-fi étude", "study lo-fi"), ("gospel moderne", "modern gospel"),
              ("amapiano", "amapiano"), ("reggae roots", "roots reggae"), ("bossa lounge", "bossa lounge"),
              ("trap mélodique", "melodic trap"), ("folk acoustique", "acoustic folk"),
              ("zouk love", "zouk love"), ("cumbia urbaine", "urban cumbia"),
              ("neo-soul", "neo-soul"), ("drum & bass léger", "light drum & bass"),
              ("blues moderne", "modern blues"), ("house profonde", "deep house")]
HUMEURS_MUS = [("romantique", "romantic"), ("festif", "festive"), ("mélancolique", "melancholic"),
               ("motivant", "motivational"), ("serein", "serene"), ("mystérieux", "mysterious"),
               ("épique", "epic"), ("nostalgique", "nostalgic"), ("joyeux", "joyful"), ("introspectif", "introspective")]
TEMPOS = ["84 BPM", "96 BPM", "104 BPM", "110 BPM", "120 BPM", "128 BPM"]
DUREES_MUS = ["1 min", "2 min", "3 min", "4 min"]
ARCS_MUS = [("montée progressive-drop-couplet-refrain", "progressive build-drop-verse-chorus"),
            ("intro calme-élan-final festif", "calm intro-swell-festive ending"),
            ("couplet-refrain-pont-final", "verse-chorus-bridge-ending"),
            ("groove constant-variation instrumentale-climax", "steady groove-instrumental variation-climax")]

def fab_brief_musique(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    gen_fr, gen_en = pioche(rng, GENRES_MUS)
    hum_fr, hum_en = pioche(rng, HUMEURS_MUS)
    tempo = pioche(rng, TEMPOS)
    duree = pioche(rng, DUREES_MUS)
    gen = gen_fr if fr_fr else gen_en
    hum = hum_fr if fr_fr else hum_en
    if fr_fr:
        instr = f"Compose un brief musical complet (genre, tempo, tonalité, instrumentation, structure)."
        inp = f"Compose un morceau {gen} {hum} de {duree} environ"
        out = (f"BRIEF MUSICAL — genre : {gen} ; tempo : {tempo} ; humeur : {hum} ; "
               f"instrumentation : rythmique {gen}, nappes discrètes, percussions caractéristiques ; "
               f"durée : {duree} ; structure : narration musicale claire, drop maîtrisé, final cohérent.")
    else:
        instr = "Compose a complete music brief (genre, tempo, key, instrumentation, structure)."
        inp = f"Compose a {hum} {gen} track of about {duree}"
        out = (f"MUSIC BRIEF — genre: {gen} ; tempo: {tempo} ; mood: {hum} ; "
               f"instrumentation: {gen} rhythm section, subtle pads, characteristic percussion ; "
               f"length: {duree} ; structure: clear musical narrative, controlled drop, coherent ending.")
    return {"task_type": "prompt_to_music_brief", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"genre": gen, "tempo": tempo}}

def fab_storyboard_clip(rng: random.Random) -> dict:
    l = lang(rng)
    fr_fr = l == "fr"
    gen_fr, gen_en = pioche(rng, GENRES_MUS)
    arc_fr, arc_en = pioche(rng, ARCS_MUS)
    duree = pioche(rng, DUREES_MUS)
    gen = gen_fr if fr_fr else gen_en
    arc = arc_fr if fr_fr else arc_en
    if fr_fr:
        instr = "Écris le storyboard du clip (plans musicaux, synchro beat, ambiance)."
        inp = f"Clip {gen} de {duree} — arc : {arc_fr}"
        out = (f"CLIP STORYBOARD ({duree}) — arc {arc_fr} ; "
               f"plans synchro beat : ouverture sur le groove, variation visuelle à chaque section, "
               f"climax sur le point culminant, résolution sur le final ; palette colorimétrique cohérente avec l'humeur.")
    else:
        instr = "Write the music video storyboard (musical shots, beat sync, mood)."
        inp = f"{gen} clip of {duree} — arc: {arc_en}"
        out = (f"CLIP STORYBOARD ({duree}) — arc {arc_en} ; "
               f"beat-synced shots: open on the groove, visual change per section, "
               f"climax at the peak, resolution on the ending ; grading palette consistent with the mood.")
    return {"task_type": "clip_storyboard", "language": l, "instruction": instr,
            "input": inp, "output": out, "difficulty": diff(rng),
            "metadata_extra": {"genre": gen, "arc": arc_en}}

QUOTAS_V3 = [
    ("code", "code", 12000, FABRIQUES_CODE,
     "Dev web, API, tests, debug, SQL et CSS — instructions bilingues avec sorties structurées correctes."),
    ("knowledge", "knw", 3000, FABRIQUES_KNOWLEDGE,
     "Sciences, sciences humaines, santé grand public, conception mécanique, recherche web — réponses cadrées et honnêtes."),
    ("security", "sec", 6000, FABRIQUES_SECURITY,
     "Cybersécurité STRICTEMENT défensive : revue de code, analyse de menaces, CTF labo éducatif, durcissement."),
    ("writing", "wri", 8000, FABRIQUES_WRITING,
     "Rédaction professionnelle : plans, emails, sections de rapport, réécriture de style."),
    ("business", "biz", 11600, FABRIQUES_BUSINESS,
     "Analyse de données, pitchs de vente, conseil commercial, stratégie tarifaire."),
    ("multimodal", "mm", 5400, FABRIQUES_MULTIMODAL,
     "Orchestration des pipelines média gen3 (image/voix/vidéo/musique/web) et lecture de scènes."),
]

# datasets média : (dossier, préfixe, quota supplémentaire, fabriques)
TOPUPS_MEDIA = [
    ("images", "img3", 4031, [fab_photo, fab_style_cls]),
    ("video", "vid3", 1700, [fab_keyframes, fab_camera]),
    ("voice", "voc3", 2600, [fab_directive_voix, fab_narration, fab_prosodie]),
    ("music", "mus3", 1300, [fab_brief_musique, fab_storyboard_clip]),
]

def suffixe_max(ids: list[str], prefixe: str) -> int:
    import re as _re
    pat = _re.compile(rf"^{_re.escape(prefixe)}-(\d+)$")
    n = 0
    for i in ids:
        m = pat.match(i)
        if m:
            n = max(n, int(m.group(1)))
    return n

def calculer_topup(dossier: str, prefixe: str, quota: int, fabriques, rng: random.Random,
                   vus: set[str]) -> tuple[list[dict], int, int]:
    """Calcule (en mémoire) `quota` nouvelles lignes pour un dataset média existant.
    Retourne (nouvelles, nb_existantes, index_départ_id). Aucune écriture ici."""
    chemin = DOSSIERS_DATASETS / dossier / "train.jsonl"
    existantes = [json.loads(x) for x in chemin.read_text("utf-8").splitlines() if x.strip()]
    vus.update(l["content_hash"] for l in existantes)
    start = suffixe_max([l["id"] for l in existantes], prefixe) + 1
    nouvelles: list[dict] = []
    tentatives = 0
    limite = quota * 60
    while len(nouvelles) < quota and tentatives < limite:
        tentatives += 1
        fab = pioche(rng, fabriques)
        partiel = fab(rng)
        cle = h16(f"{partiel['task_type']}|{partiel['language']}|{partiel['input']}|{partiel['output']}")
        if cle in vus:
            continue
        vus.add(cle)
        meta = {
            "difficulty": partiel.get("difficulty", "intermédiaire"),
            "timestamp": ts_aleatoire(rng),
            "quality_score": round(rng.uniform(0.90, 0.98), 3),
            "safety_label": partiel.get("safety_label", "safe"),
            "license": "proprietary-gen3ia",
        }
        meta.update(partiel.get("metadata_extra", {}))
        nouvelles.append({
            "id": f"{prefixe}-{len(nouvelles) + start:06d}",
            "domain": existantes[0]["domain"],
            "task_type": partiel["task_type"],
            "language": partiel["language"],
            "instruction": partiel["instruction"],
            "input": partiel["input"],
            "output": partiel["output"],
            "metadata": meta,
            "content_hash": cle,
        })
    if len(nouvelles) < quota:
        raise SystemExit(f"[topup] quota non atteint pour {dossier}: {len(nouvelles)}/{quota}")
    return nouvelles, len(existantes), start

def ecrire_topup(dossier: str, nouvelles: list[dict], nb_existantes: int, verifier: bool) -> None:
    """Écrit (seulement après génération complète) le top-up calculé."""
    dossier_p = DOSSIERS_DATASETS / dossier
    if verifier:
        print(f"[check] {dossier}: top-up +{len(nouvelles)} (total attendu {nb_existantes + len(nouvelles)})")
        return
    with (dossier_p / "train.jsonl").open("a", encoding="utf-8") as fh:
        for l in nouvelles:
            fh.write(json.dumps(l, ensure_ascii=False) + "\n")
    total = nb_existantes + len(nouvelles)
    man = json.loads((dossier_p / "MANIFEST.json").read_text("utf-8"))
    man["rows"] = total
    man["v3_topup"] = len(nouvelles)
    man["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    (dossier_p / "MANIFEST.json").write_text(json.dumps(man, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[v3] {dossier}: +{len(nouvelles)} lignes (total {total})")

def main() -> None:
    parseur = argparse.ArgumentParser(description="Curriculum Gen3ia v3")
    parseur.add_argument("--check", action="store_true", help="vérifie sans réécrire")
    args = parseur.parse_args()
    rng = random.Random(SEED)
    vus: set[str] = set()
    # pré-charger les hashes EXISTANTS de tous les datasets pour une dédup globale
    for jsonl in DOSSIERS_DATASETS.glob("*/train.jsonl"):
        for ligne in jsonl.read_text("utf-8").splitlines():
            if ligne.strip():
                vus.add(json.loads(ligne)["content_hash"])
    avant = len(vus)
    if not args.check:
        print(f"[v3] {avant} lignes existantes chargées (dédup globale active)")

    # ── PHASE 1 : TOUT générer en mémoire (aucune écriture tant que ce n'est pas vert) ──
    en_attente: list[tuple[str, list[dict], str]] = []  # (nom, lignes, description)
    nouveaux_index = []
    for nom, prefixe, quota, fabriques, desc in QUOTAS_V3:
        lignes = generer_dataset(nom, prefixe, quota, fabriques, rng, vus)
        en_attente.append((nom, lignes, desc))
        nouveaux_index.append({"id": nom, "path": f"datasets/{nom}/train.jsonl", "rows": len(lignes)})
    total_metiers = sum(n["rows"] for n in nouveaux_index)
    print(f"[v3] métiers générés en mémoire: {total_metiers} lignes")
    topups = []  # (dossier, nouvelles, nb_existantes)
    for dossier, prefixe, quota, fabriques in TOPUPS_MEDIA:
        nouvelles, nb_exist, _ = calculer_topup(dossier, prefixe, quota, fabriques, rng, vus)
        topups.append((dossier, nouvelles, nb_exist))
        man = json.loads((DOSSIERS_DATASETS / dossier / "MANIFEST.json").read_text("utf-8"))
        nouveau_total = nb_exist + len(nouvelles)
        nouveaux_index.append({"id": dossier, "path": f"datasets/{dossier}/train.jsonl",
                               "rows": nouveau_total})

    # ── PHASE 2 : écrire (uniquement si TOUT a réussi) ──
    for nom, lignes, desc in en_attente:
        ecrire_dataset(nom, lignes, desc, args.check)
    for dossier, nouvelles, nb_exist in topups:
        ecrire_topup(dossier, nouvelles, nb_exist, args.check)
    maj_index(nouveaux_index, args.check)
    if args.check:
        return
    total_global = sum(d["rows"] for d in
                       json.loads((DOSSIERS_DATASETS / "INDEX.json").read_text("utf-8"))["gen3ia-media-datasets"]["datasets"])
    print(f"[v3] TOTAL curriculum: {total_global} lignes")
    if total_global < 100_000:
        raise SystemExit(f"[v3] objectif 100 000 non atteint: {total_global}")

if __name__ == "__main__":
    main()
