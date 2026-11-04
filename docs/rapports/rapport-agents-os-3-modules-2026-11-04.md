# Rapport AGENTS-OS — 3 modules souverains — Job 478451 — 2026-11-04 (~17:15Z)

> Demande : générer le code complet, modulaire et prêt pour la production
> (TypeScript / Node.js) de 3 fonctionnalités fondamentales de genIA —
> daemon de self-healing, hub d'API zero-cloud, drop-and-fix d'artefacts —
> puis les AJOUTER AU PROJET. Contraintes : TypeScript/Node.js exclusivement,
> déterministe, local, souverain, aucune API LLM distante, code commenté,
> gestion d'erreurs systématique.
> Sécurité : aucun token cité dans ce rapport ; les 3 modules n'en utilisent
> aucun (auth par la clé développeur `g3a_` existante, vérifiée HMAC).

## 0. Ce qui a été livré — vue d'ensemble

| Module | Emplacement | Entrée | Sortie |
|---|---|---|---|
| M1 Auto-guérison | `lib/agents-os/auto-guerison/` + `infra/agents-os/ecosystem.daemon.config.js` | fichiers de logs (PM2, Docker, système) | remédiations plafonnées + journal JSONL sonde HTTPS |
| M2 Hub zero-cloud | `lib/agents-os/dispatch/` + `app/api/v1/dispatch/route.ts` | POST JSON {taskType \| script} | résultat brut de la tâche/sandbox |
| M3 Drop-and-fix | `lib/agents-os/artefacts/` + `app/api/v1/artefacts/audit/route.ts` | POST JSON {type, contenu} | rapport d'erreurs localisées + fichier corrigé revalidé |

13 fichiers de production + 3 fichiers de tests (51 tests). Aucune
dépendance LLM, aucun SaaS tiers : tout est natif (`node:*`, `js-yaml`,
compilateur TypeScript déjà présent).

## 1. Module 1 — Daemon d'auto-guérison

**Architecture** (5 fichiers, chaîne observateur → analyseur → remédiateur) :

1. `observateur-logs.ts` — `fs.watchFile` (polling robuste, fiable sur les
   volumes Docker/NFS où `fs.watch` rate), lecture INCRÉMENTALE : seul le
   delta est relu depuis l'offset (consommation en octets jusqu'au dernier
   `\n` — exact en UTF-8 multi-octets, la ligne encore en écriture reste en
   attente). Rotation/troncature détectées par inode + taille → re-scan.
   Premier scan borné à la queue (500 lignes) : le passé ancien n'intéresse
   pas la guérison.
2. `signatures.ts` — catalogue déclaratif de 8 pannes courantes :
   EADDRINUSE (port occupé), FATAL ERROR heap limit / JS heap OOM, boucle de
   redémarrage PM2 (exited with code ≠ 0 / max restarts), Cannot find module
   / MODULE_NOT_FOUND, ENOSPC (disque plein), ECONNREFUSED, uncaught
   exception / unhandledRejection, conteneur Docker exited/unhealthy/OOMKilled.
   Chaque signature porte sa remédiation DÉCLARATIVE (jamais construite
   depuis les logs — anti-injection).
3. `analyseur-erreurs.ts` — deux garde-fous anti-tempête avant déclaration :
   DÉDUPLICATION par empreinte (signature × fichier) dans une fenêtre
   glissante (2 min), et SEUIL (2 comptes distincts avant déclaration — une
   ligne isolée ne déclenche rien). Cache borné (anti-fuite mémoire).
4. `remediateur.ts` — QUATRE garde-fous : hiérarchie de niveaux armés
   (`diagnostic` par défaut — observe et journalise SANS muter le système ;
   `commande` < `pm2` < `docker`), cooldown par signature (10 min, y compris
   sur échec d'exécution — anti-boucle de tentatives), argv fixes (le seul
   substitut est `{{service}}`, rempli depuis le groupe de capture nommé du
   motif OU la config, validé contre la grammaire stricte `[A-Za-z0-9_.-]{1,64}`
   — une ligne de log n'arrive JAMAIS dans une commande), timeout
   SIGTERM → grâce 3 s → SIGKILL. Journal JSONL append (best-effort).
5. `daemon.ts` — orchestrateur long (PM2 fork, UNE instance) lancé
   EXPLICITEMENT (`pm2 start infra/agents-os/ecosystem.daemon.config.js`),
   jamais au boot Next. Config par variables `AGENTS_OS_*` (logs, niveau,
   seuil, fenêtre, cooldown, état, service).

**Télémétrie sans SSH** : le journal est exposé par la sonde HTTPS
`GET /api/v1/agents-os/daemon` (auth développeur, lim 500 entrées) — même
philosophie que `/poller-heartbeat.json` : le consommateur naturel est un
humain en exploitation ou un moniteur externe.

## 2. Module 2 — Hub d'API zero-cloud (webhook → sandbox)

**Authentification Bearer** : les routes `/api/v1/*` utilisent la porte
existante `franchirPorteV1` — clé développeur `g3a_` (HMAC + projet lié +
rôle revérifié à CHAQUE appel) + rate limit 2 couches (20/min par clé sur
POST dispatch). Le pré-contrôle `api-gate.ts` du middleware reconnaît
désormais le canal `Authorization: Bearer g3a_…` en PLUS de `x-api-key` —
le pré-contrôle reconnaît le PRÉFIXE uniquement, la VÉRIFICATION complète
reste dans la route (défense en profondeur conservée : une clé fausse
franchit le pont puis se heurte à authenticateDeveloper → 401).

**Deux voies d'exécution** :

- **Tâches natives** (registre in-process, déterministe) : `sha256`
  (empreinte locale, testée contre la référence NIST), `text-extract`
  (regex nommées bornées 500 caractères, 1 000 matches, DoS impossible par
  la taille du payload), `json-transform` (chemins pointés sans eval,
  `a.b[2].c`), `http-scrape` (fetch natif, timeout ≤ 30 s, 1 Mo, UA
  souverain). AUCUNE commande shell arbitraire côté registre.
- **Sandbox script** (`executeur-sandbox.ts`) : le script JavaScript de
  l'appelant tourne dans un processus `node` ENFANT séparé — heap plafonné
  (`--max-old-space-size=256`), répertoire temporaire jetable, timeout dur
  (30 s défaut, 120 s plafond, SIGTERM → SIGKILL), stdout/stderr plafonnés
  (64 Ko). Le script appelle `emettre(valeur)` (injeté via `globalThis`
  depuis un préambule — un module requis a son propre scope) ; la dernière
  émission gagne, le `console.log` reste un log. Mode Docker OPTIONNEL
  (`DOCKER_SANDBOX=1` + sonde `docker info`) : `--rm --network none
  --memory --cpus 0.5`, volume :ro. **Nettoyage garanti** : le répertoire
  temporaire est détruit dans un `finally` — aucun fichier ne survit, même
  en timeout ou crash (testé). Payload plafonné 256 Ko (413 au-delà).

`GET /api/v1/dispatch` = découverte des capacités (contrat sandbox,
limites) pour les clients externes.

## 3. Module 3 — Drop-and-fix des artefacts (audit & correction 1 clic)

**Validateurs natifs, erreurs LOCALISÉES (ligne/colonne)** :

- `json` : JSON.parse + extraction position V8 → ligne/colonne exactes ;
- `yaml` / `docker-compose` : js-yaml (JSON_SCHEMA, le plus strict) avec
  mark → ligne 1-indexée ; compose ajoute la sémantique (services
  top-level, image ou build par service) ;
- `javascript` : `vm.Script` COMPILÉ SANS EXÉCUTION (`new vm.Script(code)`
  — jamais `.run()`) → SyntaxError localisée depuis la pile V8 ;
- `typescript` : compilateur TS en mémoire via l'API publique stable
  `transpileModule(reportDiagnostics)` — ni émission ni exécution ;
  import DYNAMIQUE paresseux (`serverExternalPackages: ["typescript"]` :
  jamais bundlé, chargé depuis node_modules au runtime) ; si le compilateur
  est absent du déploiement → échec HONNÊTE explicite (aucune validation
  simulée) ;
- `nginx` : analyseur lexical maison (le projet n'a pas de parser nginx
  crédible) — équilibre des blocs `{}`, `;` attendus, guillemets équilibrés
  par ligne, `}` orphelin signalée. Seule la STRUCTURE est validée (les
  directives inconnues sont acceptées — nginx évolue).

**Réparateur déterministe** (passes pures journalisées ligne/avant/après) :
normalisation BOM/CRLF/espaces traînants ; JSON → commentaires `//` `/* */`,
virgules traînantes (scan global caractère par caractère, chaînes
respectées — couvre `[2,3,]`, `"deux",\n}` et la virgule top-level finale),
guillemets simples → doubles, clés nues `cle:` → `"cle":` ; YAML →
tabulations → 2 espaces, `cle:valeur` → `cle: valeur` (URL `://` et heures
`12:34` PRÉSERVÉES), guillemet non fermé complété ; docker-compose → items
`- x` réindentés (profondeur clé + 2) ; nginx → `;` manquant ajouté.
JavaScript/TypeScript : AUCUNE réparation tentée (structure sémantique).

**Orchestration honnête** (`service-audit.ts`) : valider → réparer →
REVALIDER (boucle bornée 5 passes, stop dès stabilisation) → le rapport
porte erreurs initiales localisées, réparations appliquées, fichier corrigé
REVALIDÉ, et erreurs restantes éventuelles TELLES QUELLES — une réparation
incomplète est DITE incomplète, jamais simulée. Limite 1 Mo.

## 4. Tests — 51 nouveaux, suite complète 5 844 verts

- `auto-guérison.test.ts` (16) : seuil/dédup/fenêtre, gravité triée,
  incrémental + rotation + ligne sans `\n` final + fichier absent,
  niveau non armé refusé, exécution plafonnée réelle, cooldown (y compris
  sur échec), journal JSONL, service hostile REFUSÉ (anti-injection),
  config env parsing + fail-safe, boucle réelle du daemon (timer 150 ms).
- `dispatch.test.ts` (13) : registre (4 tâches natives + inconnu + erreurs
  typées, sha256 vs NIST), sandbox : émission parsée, logs ≠ résultat,
  dernière émission gagnante, crash propre, contrat `emettre` manquant,
  timeout réel (SIGTERM), script trop long, script vide, **zéro fichier
  temporaire résiduel**.
- `artefacts.test.ts` (22) : 6 validateurs (JSON ligne exacte, YAML mark,
  compose sémantique, VM compile-only, TS diagnostics, nginx 5 cas),
  réparateur (JSON complet, YAML tabs/URL/heure/guillemet, compose,
  nginx, JS non touché), service audit (déjà valide → identique, JSON brisé
  → réparé ET revalidé, non-réparable → erreurs restantes honnêtes, garde
  de type, limite 1 Mo).

**Suite entière : 524 fichiers · 5 844 passés, 12 skippés, 0 échec.**
Gates : lint ✅, tsc ✅ (0 erreur), build ✅ (1900 Mo, discipline OOM).

## 5. Intégration au projet (pas un greffon)

- Conventions respectées : routes v1 via `franchirPorteV1` + `ErrorAccesV1`
  + `x-request-id`, `runtime = "nodejs"`, commentaires français, kebab-case.
- Le garde anti-code-mort (`api-endpoints-dead-code-guard`) exigeait la
  documentation des 3 nouveaux endpoints : entrées motivées ajoutées à la
  catégorie `api-publique-sdk` (clients hors dépôt — scripts souverains,
  exploitation, moniteurs).
- Le test Sentry (`sentry-bridge-client`) mis à jour : l'option
  `sendDefaultPii` retirée du SDK v11 n'est plus attendue.
- Dépendances : `js-yaml` + `@types/js-yaml` explicites ; `@firebase/
  rules-unit-testing` aligné v6 (peer firebase ^13 — débloque `npm ci`
  strict après le merge des PRs Dependabot d'hier) ; `typescript` en
  `serverExternalPackages`.

## 6. Déploiement et CD

- Push `0a6d059` (fils : 7542f5e rapport fichiers → ffcd103 deps PRs
  Dependabot #119/#118/#101/#103 → 0a6d059 agents-os).
- File CD au moment du push : le VPS téléchargeait déjà 7542f5e
  (heartbeat « dl-debut », release cd-latest complète : 208 Mo + sha256) —
  les 2 SHA suivants basculeront par la chaîne standard deploy-vps +
  poller pull (2 min) + backoff v3.
- Validation de clôture : re-test connecté des 3 modules sur la production
  dès que `version.json` sert `0a6d059` (sans clé réelle : 401 attendu sur
  les routes v1, ce qui Prouve le câblage de la porte ; les tests e2e
  complets nécessitent une clé développeur réelle côté opérateur).

## 7. Restes ouverts

- Les remédiations MUTANTES restent par défaut désactivées
  (`AGENTS_OS_NIVEAU=diagnostic`) : l'armement `pm2`/`docker` est une
  décision d'exploitation explicite (un commentaire dans l'ecosystem PM2
  l'explique).
- Les signatures « pm2 » ciblent les services nommés de la config
  (`AGENTS_OS_SERVICE`) ou le groupe de capture `service` des motifs —
  l'ajout d'une signature est un fichier déclaratif (signatures.ts).
- UI de gestion des 3 modules : volontairement ABSENTE (contrat CLI/API
  souverain) — documenté dans la baseline anti-code-mort.
- La sandbox processus-isolé n'interdit pas le réseau sortant (contrat :
  http-scrape en est un usage légitime) ; l'isolement réseau strict exige
  le mode Docker (`--network none`).
