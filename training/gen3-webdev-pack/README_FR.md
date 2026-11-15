# Pack gen3-webdev-pack — corpus d'entraînement « développement web »

Corpus massif d'entraînement pour le domaine **développement web** de Gen3ia
(`DOM_DEVELOPPEMENT_WEB`) : création de **SaaS**, de **sites web** et de
**projets de développement** complets — architecture, schéma de données, API
validée, composants d'interface à quatre états, authentification, déploiement,
tests et débogage.

## Ce que produit le générateur

| Sortie | Chemin (canonique, lu par lib/neural/training) | Volume |
|---|---|---|
| Dataset complet | `../gen3-domain-datasets/data/complet/developpement_web.jsonl.gz` | **2 500 000 lignes** (~1,16 Go gz), hors git |
| Échantillon commis | `../gen3-domain-datasets/data/echantillons/developpement_web.jsonl` | 500 lignes, commis au git |

Même schéma JSONL que le pack canonique `gen3-domain-datasets` (bilingue
FR/EN avec `bilingual_pair_id`, `dedup_hash`, grille de qualité), mais avec
un espace combinatoire gigantesque dédié au web :

- **60 niches métier** (CRM, e-commerce, réservation, LMS, helpdesk,
  facturation, RH, immobilier, santé, logistique, marketplace…) — chacune
  avec son **entité métier et ses champs** (schéma paramétré) ;
- **40 fonctionnalités** (auth, rôles, paiements, webhooks, multi-tenant,
  recherche, export, calendrier, kanban, PWA, SEO…) ;
- **14 stacks** avec blocs de code RÉELS par famille (route API validée,
  schéma Prisma/SQL/SQLAlchemy/Django, composant à quatre états, test,
  déploiement) ;
- **10 types de tâches** pondérés : `creation_saas` (20 %), `webapp_metier`,
  `site_web_vitrine`, `api_backend`, `donnees_modeles`, `ui_composants`,
  `auth_securite`, `deploiement_ops`, `tests_qualite`, `debug_correction` ;
- **16 formulations FR + 16 EN** × contextes (échelle, délai, équipe, budget,
  public, modèle économique).

Chaque réponse est un **plan de développement structuré et exploitable**
(1,5–4 Ko) : analyse du besoin, stack justifiée, arborescence de projet,
schéma de données réel, route API avec validation double, composant avec les
quatre états d'interface, étapes numérotées, critères de succès mesurables.

## Usage

```bash
# Corpus complet (2,5 M lignes, ~9 min) + échantillon commis (500 lignes)
python3 generateur_webdev.py

# Run réduit / variantes
python3 generateur_webdev.py --lignes 100000 --echantillons 200
python3 generateur_webdev.py --sortie data/test.jsonl.gz --graine 42
```

Reproductibilité : graine fixe 20261114 — un même run donne le même corpus
bit-à-bit. Écriture en streaming (mémoire bornée), déduplication PAR LIGNE
(une paire bilingue = deux contenus distincts, deux hashes).

## Entraînement réel (côté plateforme)

```bash
# Cycle complet à l'échelle de production (régime équilibré)
npm run train:webdev
```

1. **SNN supervisé** (`trainDomaines`) : plasticité vers le pool
   `DOM_DEVELOPPEMENT_WEB` — les instructions sont converties en **tokens
   signatures** (≤ 6 ancres, `texteEntrainement`) ; les échantillons commis
   des 17 autres domaines servent de négatifs, l'accuracy mesurée est donc
   une **discrimination réelle** sur un jeu tenu à l'écart.
2. **Cortex langagier** : 60 000 paires `{ motif → réponse structurée }`
   apprises par lots (thème `dev-web:<task_type>`), idempotent, rétention
   mesurée sur 150 paires apprises.
3. **Persistance** : cerveau sauvegardé + rapport honnête dans
   `var/neural/webdev/rapport.json`.

Interface produit : `POST /api/admin/entrainement/webdev` (garde admin) —
lance le cycle et retourne le rapport ; `GET` retourne le dernier rapport.

## Fichiers

- `generateur_webdev.py` — moteur (streaming, dédup par ligne, bilinguisme, metadata)
- `combinatoire.py` — banques (niches, fonctionnalités, stacks, formulations)
- `gabarits.py` — blocs de code réels par famille de stack
