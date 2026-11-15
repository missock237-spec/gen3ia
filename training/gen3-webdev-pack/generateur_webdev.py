#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GÉNÉRATEUR WEB-DEV GEN3IA — corpus massif d'entraînement au développement web
(création de SaaS, de sites web et de projets de développement complets).

Extension dédiée du pack gen3-domain-datasets : même schéma JSONL, même
grille de qualité (metadata, bilinguisme FR/EN, déduplication), mais un
espace combinatoire VOLONTAIREMENT GIGANTESQUE — 60 niches métier × 40
fonctionnalités × 14 stacks × 10 types de tâches × 16 formulations ×
contextes (échelle, délai, équipe, budget, public, modèle économique) —
pour produire DES MILLIONS de lignes uniques au service d'un seul objectif :
que Gen3ia sache concevoir et développer des produits web de bout en bout.

Usage :
  python3 generateur_webdev.py                          # 2 500 000 lignes
  python3 generateur_webdev.py --lignes 100000          # run réduit
  python3 generateur_webdev.py --echantillons 500       # lignes commises au git

Sorties (aux chemins canoniques lus par lib/neural/training/webdev.ts) :
  ../gen3-domain-datasets/data/complet/developpement_web.jsonl.gz     (hors git)
  ../gen3-domain-datasets/data/echantillons/developpement_web.jsonl   (commis)

Reproductibilité : graine fixe (20261114) — un même run donne les mêmes
lignes. Écriture en streaming : la mémoire reste bornée (ensemble de hashes
+ compteurs), même sur plusieurs millions de lignes. Déduplication PAR
LIGNE (une paire bilingue = deux contenus distincts, deux hashes).
"""

from __future__ import annotations

import argparse
import gzip
import json
import random
import sys
import time
from pathlib import Path

# Réutilisation des helpers de qualité du pack canonique (horodatages,
# difficultés, provenances, score qualité, hachage de déduplication).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gen3-domain-datasets"))

from domaines.base import (  # noqa: E402
    DIFFICULTES,
    PROVENANCES,
    HorlogeTemporelle,
    hacher_contenu,
    score_qualite,
    tirer_pondere,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combinatoire import (  # noqa: E402
    BUDGETS,
    DELais,
    EQUIPES,
    FONCTIONNALITES,
    FORMULATIONS_EN,
    FORMULATIONS_FR,
    MODELES_ECO,
    NICHES,
    PUBLICS,
    STACKS,
    TACHES,
    ECHELLES,
    libelle_stack,
)
from gabarits import (  # noqa: E402
    FAMILLE_PAR_STACK,
    bloc_api,
    bloc_arborescence,
    bloc_auth,
    bloc_deploy,
    bloc_schema,
    bloc_test,
    bloc_ui,
)

LICENSE = "CC-BY-4.0-synthetic-gen3ia"
GRINE_PAR_DEFAUT = 2_500_000
DOMAINE_ID = "developpement_web"

CHEMIN_COMPLET = Path(__file__).resolve().parent.parent / "gen3-domain-datasets" / "data" / "complet" / f"{DOMAINE_ID}.jsonl.gz"
CHEMIN_ECHANTILLONS = Path(__file__).resolve().parent.parent / "gen3-domain-datasets" / "data" / "echantillons" / f"{DOMAINE_ID}.jsonl"


def choisir(rng, options):
    return rng.choice(options)


def construire_contexte(rng, langue):
    """Tire le contexte de la demande (dimensions réelles d'un projet web)."""
    echelle_fr, echelle_en = choisir(rng, ECHELLES)
    delai_fr, delai_en = choisir(rng, DELais)
    equipe_fr, equipe_en = choisir(rng, EQUIPES)
    budget_fr, budget_en = choisir(rng, BUDGETS)
    public_fr, public_en = choisir(rng, PUBLICS)
    eco_fr, eco_en = choisir(rng, MODELES_ECO)
    return {
        "echelle": echelle_fr if langue == "fr" else echelle_en,
        "delai": delai_fr if langue == "fr" else delai_en,
        "equipe": equipe_fr if langue == "fr" else equipe_en,
        "budget": budget_fr if langue == "fr" else budget_en,
        "public": public_fr if langue == "fr" else public_en,
        "modele_eco": eco_fr if langue == "fr" else eco_en,
    }


def construire_instruction(rng, langue, niche, feature, ctx):
    """Demande utilisateur réaliste (formulation variée, bilingue)."""
    gab = choisir(rng, FORMULATIONS_FR if langue == "fr" else FORMULATIONS_EN)
    return gab.format(
        niche=niche["fr"] if langue == "fr" else niche["en"],
        feature=feature[0] if langue == "fr" else feature[1],
        stack=libelle_stack(ctx["stack_id"], langue),
        echelle=ctx["echelle"],
        delai=ctx["delai"],
        equipe=ctx["equipe"],
        budget=ctx["budget"],
    )


def titre_section(num, titre_fr, titre_en, langue):
    return f"{num}. {titre_fr if langue == 'fr' else titre_en}"


def reponse_creation_saas(rng, langue, niche, feature, ctx, entite, champs):
    """Plan complet de création de SaaS : analyse → données → API → UI → étapes."""
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    ent = entite if langue == "fr" else niche.get("entite_en", entite)
    ouverture = {
        "fr": [
            f"Voici un plan de développement complet pour votre SaaS de {niche['fr']}, pensé pour {ctx['public']} à l'échelle {ctx['echelle']}.",
            f"Pour un SaaS de {niche['fr']} avec {feature}, voici la proposition que je ferais valider en atelier avant d'écrire une ligne de code.",
            f"Objectif : un SaaS de {niche['fr']} prêt pour {ctx['modele_eco']}, livrable par {ctx['equipe']} en {ctx['delai']}.",
            f"Je structure ce SaaS de {niche['fr']} autour de la fiche {ent} — le cœur métier — et de {feature} comme parcours signifiant.",
        ],
        "en": [
            f"Here is a full development plan for your {niche['en']} SaaS, designed for {ctx['public']} at {ctx['echelle']} scale.",
            f"For a {niche['en']} SaaS with {feature}, here is the proposal I would validate in a workshop before writing any code.",
            f"Goal: a {niche['en']} SaaS ready for {ctx['modele_eco']}, deliverable by {ctx['equipe']} within {ctx['delai']}.",
            f"I structure this {niche['en']} SaaS around the {ent} record — the business core — and {feature} as the meaningful journey.",
        ],
    }[langue]
    stack_lib = libelle_stack(ctx["stack_id"], langue)
    sections = [
        ouverture[rng.randrange(len(ouverture))],
        titre_section(1, "Stack recommandée et pourquoi", "Recommended stack and why", langue),
        f"{'Stack' if langue == 'fr' else 'Stack'} : **{stack_lib}**. "
        + ("Ce choix privilégie un développement rapide par une petite équipe, un typage fort des données et un déploiement reproductible ; les alternatives (framework équivalent) restent possibles si l'équipe les maîtrise déjà."
           if langue == "fr"
           else "This choice favors fast delivery by a small team, strong data typing and reproducible deployment; equivalent frameworks remain valid if the team already masters them."),
        titre_section(2, "Arborescence de projet", "Project layout", langue),
        bloc_arborescence(fam, ent, langue),
        titre_section(3, "Schéma de données", "Data model", langue),
        bloc_schema(fam, ent, champs),
        titre_section(4, "API et validation double", "API and dual validation", langue),
        bloc_api(fam, ent, langue),
        titre_section(5, "Interface : états et accessibilité", "UI: states and accessibility", langue),
        bloc_ui(fam, ent, langue)
        + ("Le composant gère les quatre états (chargement, vide, erreur, données) et reste utilisable au clavier seul."
           if langue == "fr"
           else "The component handles the four states (loading, empty, error, data) and stays keyboard-only usable."),
        titre_section(6, "Étapes de mise en œuvre", "Implementation steps", langue),
        _etapes(rng, langue, ent),
        titre_section(7, "Critères de succès mesurables", "Measurable success criteria", langue),
        _criteres(rng, langue),
    ]
    return "\n\n".join(sections)


def reponse_site_web(rng, langue, niche, feature, ctx):
    """Site vitrine / présence web : pages, SEO, performance."""
    stack_lib = libelle_stack(ctx["stack_id"], langue)
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    pages_fr = ["Accueil (promesse + preuve sociale)", "Offres / tarifs", "Témoignages", "Contact (formulaire validé)", "Mentions légales"]
    pages_en = ["Home (promise + social proof)", "Offers / pricing", "Testimonials", "Contact (validated form)", "Legal notice"]
    sections = [
        (f"Pour une présence web de {niche['fr']}, je construis {len(pages_fr)} pages rapides et indexables — stack **{stack_lib}**, cible : chargement < 1 s sur 3G."
         if langue == "fr"
         else f"For a {niche['en']} web presence, I build {len(pages_en)} fast, indexable pages — stack **{stack_lib}**, target: < 1 s load on 3G."),
        titre_section(1, "Pages et parcours", "Pages and journey", langue),
        "\n".join(f"- {p}" for p in (pages_fr if langue == "fr" else pages_en)),
        titre_section(2, "SEO technique", "Technical SEO", langue),
        ("- métadonnées par page (title, description, OpenGraph) ;\n- sitemap.xml + robots.txt générés au build ;\n- données structurées JSON-LD de type LocalBusiness ;\n- images en formats modernes avec dimensions explicites."
         if langue == "fr"
         else "- per-page metadata (title, description, OpenGraph);\n- sitemap.xml + robots.txt generated at build;\n- LocalBusiness JSON-LD structured data;\n- modern image formats with explicit dimensions."),
        titre_section(3, "Exemple de bloc de contenu", "Sample content block", langue),
        bloc_ui(fam, "Contact", langue),
        titre_section(4, "Déploiement", "Deployment", langue),
        bloc_deploy(fam, langue),
        titre_section(5, "Étapes", "Steps", langue),
        _etapes(rng, langue, "Contact"),
    ]
    return "\n\n".join(sections)


def reponse_webapp_metier(rng, langue, niche, feature, ctx, entite, champs):
    stack_lib = libelle_stack(ctx["stack_id"], langue)
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    ent = entite if langue == "fr" else niche.get("entite_en", entite)
    modules = {
        "fr": [f"Module fiches {ent} (CRUD complet)", "Module recherche et filtres", "Module export et rapports", "Module permissions par rôle"],
        "en": [f"{ent} records module (full CRUD)", "Search and filters module", "Export and reports module", "Role-based permissions module"],
    }[langue]
    sections = [
        (f"Application métier de {niche['fr']} : je découpe en {len(modules)} modules livrables séparément — stack **{stack_lib}**."
         if langue == "fr"
         else f"{niche['en']} business app: I split it into {len(modules)} independently shippable modules — stack **{stack_lib}**."),
        titre_section(1, "Modules et ordre de livraison", "Modules and delivery order", langue),
        "\n".join(f"- {m}" for m in modules),
        titre_section(2, "Données", "Data", langue),
        bloc_schema(fam, ent, champs),
        titre_section(3, "Interface et états", "UI and states", langue),
        bloc_ui(fam, ent, langue),
        titre_section(4, "Étapes", "Steps", langue),
        _etapes(rng, langue, ent),
    ]
    return "\n\n".join(sections)


def reponse_api_backend(rng, langue, niche, feature, ctx, entite, champs):
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    ent = entite if langue == "fr" else niche.get("entite_en", entite)
    erreurs = {
        "fr": [
            "400 — corps invalide (détail du champ fautif dans la réponse)",
            "401 — session absente ou expirée",
            "404 — ressource inexistante (sans fuite d'information)",
            "429 — quota dépassé (en-tête retry-after)",
            "500 — panne interne (identifiant de trace dans les journaux uniquement)",
        ],
        "en": [
            "400 — invalid body (failing field detail in the response)",
            "401 — missing or expired session",
            "404 — unknown resource (no information leak)",
            "429 — rate limited (retry-after header)",
            "500 — internal failure (trace id in logs only)",
        ],
    }[langue]
    sections = [
        (f"Conception API pour le module {ent} d'une plateforme de {niche['fr']} — contrat REST versionné, validation double (schéma + métier)."
         if langue == "fr"
         else f"API design for the {ent} module of a {niche['en']} platform — versioned REST contract, dual validation (schema + business)."),
        titre_section(1, "Contrat des endpoints", "Endpoint contract", langue),
        "\n".join([
            f"- `GET /api/{ent.lower()}` — liste paginée (page, par-page plafonné) ;",
            f"- `GET /api/{ent.lower()}/{{id}}` — fiche complète ;",
            f"- `POST /api/{ent.lower()}` — création (201, Location) ;",
            f"- `PATCH /api/{ent.lower()}/{{id}}` — mise à jour partielle ;",
            f"- `DELETE /api/{ent.lower()}/{{id}}` — suppression (204).",
        ]),
        titre_section(2, "Implémentation", "Implementation", langue),
        bloc_api(fam, ent, langue),
        titre_section(3, "Erreurs normalisées", "Normalized errors", langue),
        "\n".join(f"- {e}" for e in erreurs),
        titre_section(4, "Test d'intégration", "Integration test", langue),
        bloc_test(fam, ent, langue),
    ]
    return "\n\n".join(sections)


def reponse_donnees_modeles(rng, langue, niche, feature, ctx, entite, champs):
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    ent = entite if langue == "fr" else niche.get("entite_en", entite)
    sections = [
        (f"Modèle de données du SaaS de {niche['fr']} : l'entité {ent} est reliée à User (propriétaire) et aux index d'accès fréquents."
         if langue == "fr"
         else f"Data model of the {niche['en']} SaaS: the {ent} entity links to User (owner) and the frequent access indexes."),
        titre_section(1, "Entités et relations", "Entities and relations", langue),
        "\n".join([
            f"- `User` — compte authentifié (e-mail unique, rôle) ;",
            f"- `{ent}` — cœur métier, propriétaire = User ;",
            "- relations 1-N : une fiche appartient à un compte, les requêtes filtrent toujours par propriétaire.",
        ]),
        titre_section(2, "Schéma", "Schema", langue),
        bloc_schema(fam, ent, champs),
        titre_section(3, "Index et intégrité", "Indexes and integrity", langue),
        ("- index sur la clé propriétaire + date de création (liste paginée) ;\n- contrainte d'unicité sur le champ identifiant métier ;\n- contraintes NOT NULL sur les champs obligatoires ;\n- migrations versionnées, réversibles, exécutées en CI avant le déploiement."
         if langue == "fr"
         else "- index on owner key + creation date (paginated list);\n- unique constraint on the business identifier field;\n- NOT NULL constraints on required fields;\n- versioned, reversible migrations, run in CI before deployment."),
        titre_section(4, "Étapes", "Steps", langue),
        _etapes(rng, langue, ent),
    ]
    return "\n\n".join(sections)


def reponse_auth(rng, langue, niche, feature, ctx, entite, champs):
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    regles = {
        "fr": [
            "Mots de passe : scrypt (N=16384, r=8, p=1) ou argon2id — jamais de hachage rapide.",
            "Sessions : cookie HttpOnly, SameSite=Lax, signé HMAC — pas de token d'API dans le navigateur.",
            "Rate limiting sur login et réinitialisation (anti énumération et brute force).",
            "Réinitialisation : jeton à usage unique, TTL 30 minutes, réponse identique que le compte existe ou non.",
            "Rôles : utilisateur / gestionnaire / administrateur — contrôle côté SERVEUR sur chaque route.",
        ],
        "en": [
            "Passwords: scrypt (N=16384, r=8, p=1) or argon2id — never fast hashes.",
            "Sessions: HttpOnly, SameSite=Lax cookie signed with HMAC — no API token in the browser.",
            "Rate limiting on login and reset (anti-enumeration and brute force).",
            "Reset: single-use token, 30-minute TTL, identical response whether the account exists or not.",
            "Roles: user / manager / admin — enforced SERVER-SIDE on every route.",
        ],
    }[langue]
    sections = [
        (f"Sécurité d'accès du SaaS de {niche['fr']} : la fonctionnalité « {feature[0] if langue == 'fr' else feature[1]} » s'appuie sur ce socle d'authentification."
         if langue == "fr"
         else f"Access security of the {niche['en']} SaaS: the \"{feature[1]}\" feature builds on this authentication base."),
        titre_section(1, "Règles non négociables", "Non-negotiable rules", langue),
        "\n".join(f"- {r}" for r in regles),
        titre_section(2, "Implémentation de référence", "Reference implementation", langue),
        bloc_auth(fam, langue),
        titre_section(3, "Protection de chaque route", "Route-level protection", langue),
        bloc_api(fam, entite, langue),
    ]
    return "\n\n".join(sections)


def reponse_ui_composants(rng, langue, niche, feature, ctx, entite, champs):
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    ent = entite if langue == "fr" else niche.get("entite_en", entite)
    sections = [
        (f"Interface du module {ent} ({niche['fr']}) : le composant couvre les quatre états et respecte l'accessibilité clavier."
         if langue == "fr"
         else f"{ent} module UI ({niche['en']}): the component covers the four states and keyboard accessibility."),
        titre_section(1, "États d'interface exigés", "Required UI states", langue),
        ("\n".join([
            "- **chargement** : indicateur annoncé au lecteur d'écran (role=status) ;",
            "- **vide** : message utile + action de création ;",
            "- **erreur** : message explicite, réessayable (role=alert) ;",
            "- **données** : liste paginée, tri stable, focus visible.",
        ]) if langue == "fr"
        else "\n".join([
            "- **loading**: indicator announced to screen readers (role=status);",
            "- **empty**: helpful message + create action;",
            "- **error**: explicit, retryable message (role=alert);",
            "- **data**: paginated list, stable sort, visible focus.",
        ])),
        titre_section(2, "Implémentation", "Implementation", langue),
        bloc_ui(fam, ent, langue),
        titre_section(3, "Test du composant", "Component test", langue),
        bloc_test(fam, ent, langue),
    ]
    return "\n\n".join(sections)


def reponse_deploiement(rng, langue, niche, feature, ctx):
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    env_vars = {
        "fr": ["DATABASE_URL (base de données gérée)", "SESSION_SECRET (≥ 32 caractères, rotation documentée)",
               "R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET (fichiers)",
               "RESEND_API_KEY + EMAIL_FROM_ADDRESS (e-mails transactionnels)"],
        "en": ["DATABASE_URL (managed database)", "SESSION_SECRET (≥ 32 chars, documented rotation)",
               "R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET (files)",
               "RESEND_API_KEY + EMAIL_FROM_ADDRESS (transactional email)"],
    }[langue]
    sections = [
        (f"Mise en production du service de {niche['fr']} : conteneurs reproductibles, secrets hors code, healthcheck avant bascule."
         if langue == "fr"
         else f"Production deployment of the {niche['en']} service: reproducible containers, secrets out of code, healthcheck before switchover."),
        titre_section(1, "Variables d'environnement", "Environment variables", langue),
        "\n".join(f"- `{v}`" for v in env_vars),
        titre_section(2, "Manifeste de déploiement", "Deployment manifest", langue),
        bloc_deploy(fam, langue),
        titre_section(3, "Observabilité et sauvegarde", "Observability and backup", langue),
        ("- journaux structurés (JSON) avec identifiant de requête ;\n- métriques : latence p95, taux d'erreur, taille de la file ;\n- sauvegarde quotidienne testée par restauration mensuelle ;\n- rollback documenté : image précédente re-déployable en une commande."
         if langue == "fr"
         else "- structured (JSON) logs with request id;\n- metrics: p95 latency, error rate, queue depth;\n- daily backup validated by a monthly restore;\n- documented rollback: previous image re-deployable in one command."),
    ]
    return "\n\n".join(sections)


def reponse_tests(rng, langue, niche, feature, ctx, entite, champs):
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    ent = entite if langue == "fr" else niche.get("entite_en", entite)
    sections = [
        (f"Stratégie de qualité du module {ent} : la pyramide (unitaires nombreux, intégration ciblées, E2E critiques) et la règle « chaque bug devient un test »."
         if langue == "fr"
         else f"Quality strategy for the {ent} module: the pyramid (many unit tests, focused integration, critical E2E) and the \"every bug becomes a test\" rule."),
        titre_section(1, "Cas limites donnée / quand / alors", "Given / when / then edge cases", langue),
        ("\n".join([
            "- **Données** une fiche complète → **Quand** POST valide → **Alors** 201 + relecture OK ;",
            "- **Données** champ obligatoire vide → **Quand** POST → **Alors** 400 avec le champ fautif ;",
            "- **Données** session absente → **Quand** GET → **Alors** 401 (jamais 500) ;",
            "- **Données** 500 enregistrements → **Quand** page 26 → **Alors** liste vide, pas d'erreur.",
        ]) if langue == "fr"
        else "\n".join([
            "- **Given** a full record → **When** valid POST → **Then** 201 + read-back OK;",
            "- **Given** an empty required field → **When** POST → **Then** 400 with the failing field;",
            "- **Given** no session → **When** GET → **Then** 401 (never 500);",
            "- **Given** 500 records → **When** page 26 → **Then** empty list, no error.",
        ])),
        titre_section(2, "Test d'intégration de référence", "Reference integration test", langue),
        bloc_test(fam, ent, langue),
        titre_section(3, "Intégration continue", "Continuous integration", langue),
        ("- CI sur chaque push : lint + tests + build ;\n- la CI bloque la fusion si un test tombe — pas d'exception « temporaire » ;\n- seuil de couverture sur les modules métier (pas sur les gabarits d'affichage)."
         if langue == "fr"
         else "- CI on every push: lint + tests + build;\n- CI blocks merge when a test fails — no \"temporary\" exceptions;\n- coverage threshold on business modules (not on display templates)."),
    ]
    return "\n\n".join(sections)


def reponse_debug(rng, langue, niche, feature, ctx, entite, champs):
    fam = FAMILLE_PAR_STACK[ctx["stack_id"]]
    ent = entite if langue == "fr" else niche.get("entite_en", entite)
    sections = [
        (f"Correction type sur le module {ent} d'une app de {niche['fr']} : « la liste affiche parfois une erreur 500 après un filtre »."
         if langue == "fr"
         else f"Typical fix on the {ent} module of a {niche['en']} app: \"the list sometimes shows a 500 error after filtering\"."),
        titre_section(1, "Diagnostic", "Diagnosis", langue),
        ("- reproduire localement avec la même donnée d'entrée ;\n- lire le journal serveur au moment de la requête fautive (trace complète) ;\n- hypothèse la plus fréquente : paramètre de filtre non validé (page hors bornes ou valeur null transmise à la requête)."
         if langue == "fr"
         else "- reproduce locally with the same input;\n- read the server log for the failing request (full trace);\n- most frequent cause: unvalidated filter parameter (out-of-bounds page or null passed to the query)."),
        titre_section(2, "Correction", "Fix", langue),
        bloc_api(fam, ent, langue)
        + ("\nLa validation du schéma (zod/pydantic) rejette les paramètres hors bornes AVANT la requête base de données — l'erreur 500 devient un 400 explicite."
           if langue == "fr"
           else "\nSchema validation (zod/pydantic) rejects out-of-bounds parameters BEFORE the database query — the 500 becomes an explicit 400."),
        titre_section(3, "Prévention", "Prevention", langue),
        bloc_test(fam, ent, langue)
        + ("\nLe cas « page hors bornes » entre au registre des tests : chaque bug corrigé doit laisser un test derrière lui."
           if langue == "fr"
           else "\nThe \"out-of-bounds page\" case joins the test registry: every fixed bug must leave a test behind."),
    ]
    return "\n\n".join(sections)


BUILDERS = {
    "creation_saas": reponse_creation_saas,
    "site_web_vitrine": lambda rng, l, n, f, c, e, ch: reponse_site_web(rng, l, n, f, c),
    "webapp_metier": reponse_webapp_metier,
    "api_backend": reponse_api_backend,
    "donnees_modeles": reponse_donnees_modeles,
    "auth_securite": reponse_auth,
    "ui_composants": reponse_ui_composants,
    "deploiement_ops": lambda rng, l, n, f, c, e, ch: reponse_deploiement(rng, l, n, f, c),
    "tests_qualite": reponse_tests,
    "debug_correction": reponse_debug,
}


def _etapes(rng, langue, entite):
    fr = [
        "Initialiser le dépôt, la CI et l'environnement local reproductible.",
        f"Poser le schéma de données ({entite}) et les migrations versionnées.",
        "Implémenter l'authentification et la protection des routes.",
        f"Développer le module {entite} : API validée puis interface à quatre états.",
        "Couvrir les cas limites par des tests d'intégration (donnée / quand / alors).",
        "Déployer derrière un healthcheck, avec sauvegarde et rollback documentés.",
    ]
    en = [
        "Initialize the repo, CI and a reproducible local environment.",
        f"Set up the data model ({entite}) with versioned migrations.",
        "Implement authentication and route protection.",
        f"Build the {entite} module: validated API then a four-state UI.",
        "Cover edge cases with integration tests (given / when / then).",
        "Deploy behind a healthcheck, with backup and documented rollback.",
    ]
    liste = fr if langue == "fr" else en
    return "\n".join(f"{i + 1}. {e}" for i, e in enumerate(liste))


def _criteres(rng, langue):
    fr = [
        "parcours de création d'une fiche en moins de 30 secondes au clavier seul ;",
        "aucune erreur 5xx sur 1 000 requêtes réelles ;",
        "temps de chargement de la liste < 1,5 s sur connexion 3G rapide ;",
        "chaque route non authentifiée répond 401 (jamais 500) ;",
        "les données d'un compte sont invisibles depuis un autre compte.",
    ]
    en = [
        "record creation journey under 30 seconds keyboard-only;",
        "zero 5xx errors across 1,000 real requests;",
        "list page loads in < 1.5 s on fast 3G;",
        "every unauthenticated route answers 401 (never 500);",
        "one account's data is invisible from another account.",
    ]
    liste = fr if langue == "fr" else en
    return "\n".join(f"- {c}" for c in liste)


def generer_exemple(rng, horloge, idx, force_langue=None):
    """Construit UNE ligne d'entraînement (déjà dédupliquée par l'appelant)."""
    niche = choisir(rng, NICHES)
    stack_id = choisir(rng, STACKS)[0]
    feature = choisir(rng, FONCTIONNALITES)
    feature_secondaire = choisir(rng, [f for f in FONCTIONNALITES if f != feature])
    ctx = construire_contexte(rng, None)
    ctx["stack_id"] = stack_id

    tache = tirer_pondere(rng, TACHES)
    bilingue = rng.random() < 0.5
    if force_langue:
        langues = [force_langue]
    elif bilingue:
        langues = ["fr", "en"]
    else:
        langues = [rng.choice(["fr", "en"])]

    instant, iso = horloge.horodatage()
    difficulte = tirer_pondere(rng, DIFFICULTES)
    provenance = tirer_pondere(rng, PROVENANCES)
    qualite = score_qualite(rng, difficulte, provenance)
    pair_id = f"bp-webdev-{idx:07d}"

    lignes = []
    hashes = []
    for langue in langues:
        feature_lib = feature[0] if langue == "fr" else feature[1]
        ctxl = construire_contexte(rng, langue)
        ctxl["stack_id"] = stack_id
        instruction = construire_instruction(rng, langue, niche, feature, ctxl)
        entite = niche["entite"] if langue == "fr" else niche.get("entite_en", niche["entite"])
        builder = BUILDERS[tache]
        output = builder(rng, langue, niche, feature, ctxl, entite, niche["champs"])
        input_txt = (
            f"{{\"niche\": \"{niche['id']}\", \"feature\": \"{feature_lib}\", "
            f"\"stack\": \"{stack_id}\", \"echelle\": \"{ctxl['echelle']}\", "
            f"\"delai\": \"{ctxl['delai']}\", \"equipe\": \"{ctxl['equipe']}\", "
            f"\"budget\": \"{ctxl['budget']}\", \"public\": \"{ctxl['public']}\", "
            f"\"modele_eco\": \"{ctxl['modele_eco']}\", \"feature2\": \"{(feature_secondaire[0] if langue == 'fr' else feature_secondaire[1])}\"}}"
        )
        # Déduplication PAR LIGNE (une paire bilingue = deux contenus distincts).
        dedup_ligne = hacher_contenu(instruction, output)
        hashes.append(dedup_ligne)
        lignes.append({
            "id": f"{DOMAINE_ID}-{pair_id}-{langue}",
            "domain": DOMAINE_ID,
            "domain_fr": "développement web",
            "domain_en": "web development",
            "language": langue,
            "task_type": tache,
            "instruction": instruction,
            "input": input_txt,
            "output": output,
            "metadata": {
                "created_at": iso,
                "temporal_bucket": HorlogeTemporelle.semaine_iso(instant),
                "difficulty": difficulte,
                "quality_score": round(qualite, 2),
                "source_style": "atelier_projet_web",
                "bilingual_pair_id": pair_id,
                "dedup_hash": dedup_ligne,
                "safety_label": "contenu_technique_sain",
                "license": LICENSE,
            },
        })
    return lignes, hashes


def ouvrir_ecriture(chemin: Path):
    """Ouverture texte (compression gzip automatique pour les .jsonl.gz)."""
    if chemin.suffix == ".gz":
        return gzip.open(chemin, "wt", encoding="utf-8")
    return chemin.open("w", encoding="utf-8")


def generer(nb_lignes: int, chemin: Path, echantillons: int | None, graine: int) -> dict:
    """Génération en STREAMING : mémoire bornée même sur plusieurs millions."""
    debut = time.time()
    rng = random.Random(graine)
    horloge = HorlogeTemporelle(rng)

    chemin.parent.mkdir(parents=True, exist_ok=True)
    vus = set()
    ecrites = 0
    essais = 0
    par_langue = {"fr": 0, "en": 0}
    par_tache = {t: 0 for t, _ in TACHES}
    essais_max = nb_lignes * 4

    with ouvrir_ecriture(chemin) as sortie:
        while ecrites < nb_lignes and essais < essais_max:
            essais += 1
            lignes, hashes = generer_exemple(rng, horloge, essais)
            # Rejet si UNE SEULE ligne du couple est déjà connue.
            if any(h in vus for h in hashes):
                continue
            vus.update(hashes)
            for ligne in lignes:
                if ecrites >= nb_lignes:
                    break
                sortie.write(json.dumps(ligne, ensure_ascii=False, separators=(",", ":")) + "\n")
                ecrites += 1
                par_langue[ligne["language"]] += 1
                par_tache[ligne["task_type"]] += 1
            if ecrites % 100_000 == 0 and ecrites:
                print(f"  {ecrites:,} lignes écrites… ({time.time() - debut:.0f} s)", flush=True)

    rapport = {
        "fichier": str(chemin),
        "lignes": ecrites,
        "uniques": len(vus),
        "essais": essais,
        "duree_s": round(time.time() - debut, 1),
        "par_langue": par_langue,
        "par_tache": par_tache,
        "graine": graine,
    }
    print(json.dumps(rapport, ensure_ascii=False, indent=2), flush=True)

    if echantillons:
        # Échantillon commis : premier passage déterministe du même rng.
        rng_e = random.Random(graine + 7)
        horloge_e = HorlogeTemporelle(rng_e)
        vus_e = set()
        ecrites_e = 0
        CHEMIN_ECHANTILLONS.parent.mkdir(parents=True, exist_ok=True)
        with CHEMIN_ECHANTILLONS.open("w", encoding="utf-8") as sortie:
            essais_e = 0
            while ecrites_e < echantillons and essais_e < echantillons * 10:
                essais_e += 1
                lignes, hashes_e = generer_exemple(rng_e, horloge_e, essais_e)
                if any(h in vus_e for h in hashes_e):
                    continue
                vus_e.update(hashes_e)
                for ligne in lignes:
                    if ecrites_e >= echantillons:
                        break
                    sortie.write(json.dumps(ligne, ensure_ascii=False, separators=(",", ":")) + "\n")
                    ecrites_e += 1
        print(f"Échantillons commis : {ecrites_e} lignes → {CHEMIN_ECHANTILLONS}", flush=True)
        rapport["echantillons_commis"] = ecrites_e
    return rapport


def main() -> None:
    parser = argparse.ArgumentParser(description="Générateur web-dev Gen3ia (millions de lignes)")
    parser.add_argument("--lignes", type=int, default=GRINE_PAR_DEFAUT, help="lignes cibles du dataset complet")
    parser.add_argument("--echantillons", type=int, default=0, help="lignes commises au git (0 = ne pas écrire)")
    parser.add_argument("--sortie", type=str, default=str(CHEMIN_COMPLET), help="chemin du dataset complet")
    parser.add_argument("--graine", type=int, default=20261114, help="graine de reproductibilité")
    args = parser.parse_args()

    print(f"Génération web-dev : {args.lignes:,} lignes cibles → {args.sortie}", flush=True)
    generer(args.lignes, Path(args.sortie), args.echantillons or None, args.graine)
    print("Terminé.", flush=True)


if __name__ == "__main__":
    main()
