# Processus d'ingénierie — Gen3ia

> Le standard d'ingénierie « Google-grade », adapté au contexte réel de
> Gen3ia : un développeur (missock237-spec) + des agents IA, un dépôt unique,
> un VPS de production 2 Go livré en continu. Ce document décrit le processus
> **tel qu'il est pratiqué** (avec les chemins réels qui le matérialisent),
> pas tel qu'on rêverait qu'il soit. Compléments : tableau de bord fiabilité
> [`docs/sre/sli-slo.md`](sre/sli-slo.md), postmortems
> [`docs/sre/postmortem-modele.md`](sre/postmortem-modele.md), roadmap
> [`docs/feuille-de-route-google-grade.md`](feuille-de-route-google-grade.md).

## 1. Principe directeur

Chez Google, la discipline vient de la masse (des milliers d'ingénieurs, des
outils dédiés). Ici, la masse n'existe pas : la discipline vient donc de
**l'automatisation et de la cadence**. Le processus repose sur trois
invariants :

1. **`main` est toujours vert et toujours déployable** — chaque merge est
   déployé automatiquement en production ;
2. **aucun changement sans relecteur distinct de l'auteur** ;
3. **aucune décision de fiabilité sans mesure** (SLI/SLO, budgets d'erreur,
   tests de charge — pas d'intuition).

Tout le reste découle de ces trois règles.

## 2. Trunk-Based Development

**Modèle de branches.** Le trunk, c'est `main`. Les branches de travail
(`feat/*`, `fix/*`, `refactor/*`, `chore/*`, `docs/*`) sont **courtes :
vivant moins de 48 h**, idéalement quelques heures. Un changement qui semble
nécessiter plus de 48 h est découpé en séries de petits changements
intégrables indépendamment. Règle de cadence : **un ou plusieurs petits
changements intégrés à `main` au moins une fois par jour** — une branche qui
s'endort plus de deux jours est un risque (dérive du trunk, conflits, perte
de contexte) et se jette ou se découpe.

**Intégration.** Pas de longues feature branches ni de branches de release :
`main` fusionné = `main` déployé (déploiement continu, cf. §3). Les merges
séquentiels de plusieurs branches se font en une rafale unique suivie d'UN
déploiement (pattern des sessions multi-agents : 6 branches mergées puis
un seul push `main`, cf. worklog de session).

**Feature flags.** Un travail non fini n'attend pas la branche : il entre
derrière un flag d'environnement. Le pattern éprouvé du dépôt :

- `PAYMENT_PROVIDER` (défaut `chariow`, **seule valeur supportée**) — toute
  autre valeur court-circuite explicitement les encaissements en 501 :
  `lib/billing/payment-provider.ts`, documenté dans `.env.example`. C'est le
  modèle du **flag fail-safe** : la config erronée doit FERMER la
  fonctionnalité, jamais l'ouvrir.
- `GEN3IA_BILLING_ENABLED` — interrupteur global de facturation (no-ops
  fail-soft quand désactivé) : `lib/billing/billing-mode.ts`.
- `AGENT_TRIGGER_WEBHOOK_SECRET` — durcissement progressif d'un webhook :
  secret absent = comportement historique + warning ; secret présent =
  signature HMAC obligatoire. Permet de déployer le code AVANT de configurer
  l'environnement, puis d'activer sans nouveau déploiement.

  Règles du pattern : (a) un flag a UN point de contrôle unique (un module
  `server-only`, pas des `process.env` éparpillés) ; (b) sa valeur par défaut
  est le comportement sûr ; (c) il est documenté dans `.env.example` au
  moment du commit ; (d) il se retire une fois le basculement stabilisé —
  un flag qui traîne devient une dette (le second code path pourrit).

**Compatibilité des surfaces supprimées.** Le retravail d'une surface
publique s'accompagne de redirections `next.config.ts` (`redirects()`,
temporaires `permanent: false`) et d'un retrait de la liste blanche
`lib/security/user-access.ts` — l'utilisateur qui a un vieux lien n'est
jamais perdu (pattern des suppressions `/chat-v4`, `/workspace`, `/studio`).

## 3. CI/CD standardisé

### 3.1 Le pipeline actuel (réel)

**Intégration continue — `.github/workflows/ci.yml`** (déclenché sur PR vers
`main` ET sur push `main`) :

| Job | Contenu | Rôle |
|---|---|---|
| `ci` — « Typecheck · Lint · Tests · Audit · Build · Budget » | `sdk:build` (SDK public typechecké), `npm audit --omit=dev --audit-level=high`, `typecheck`, `lint`, `test:coverage` (seuils de couverture), `build` production, `check:bundle` (budget First Load JS par route) | La présoumission automatisée : rien ne fusionne si l'un de ces verrous tombe |
| `e2e` — « E2E Auth (émulateur Firebase auth) » | suite e2e contre l'émulateur Auth + R2 simulé, **jamais la production** | Contrats bout-en-bout (wallet, équipes/agents/facturation) |
| `a11y` — « Accessibilité (axe-core · WCAG 2.1 AA) » | build + serveur local hermétique + scan `scripts/a11y_prod.mjs` (échec sur violations critical/serious) | L'accessibilité est un critère bloquant, pas un wish |
| `secrets-scan` — « Secrets (gitleaks) » | `gitleaks/gitleaks-action@v3` sur l'historique complet | Aucun secret ne passe, même retroactivement |

**Sécurité en continu (hors CI de merge) :**

- `codeql.yml` — analyse statique de sécurité (CodeQL) ;
- `security.yml` — scan dynamique OWASP ZAP baseline (DAST passif + sondes
  actives modérées, rapport en artefact).

**Déploiement continu — `.github/workflows/deploy-vps.yml`** (push `main`
→ production, + `workflow_dispatch` manuel) :

1. Le build Next.js est fait **sur le runner GitHub** (le VPS 2 Go ne peut
   pas compiler : `next build` réclame > 3,5 Go de RSS) ;
2. `SCP` du `.next` packagé + du finisher vers le VPS (retry réseau) ;
3. `deploy/cd-finisher.sh` applique le **swap atomique** : staging isolé
   (l'app en ligne continue de servir pendant l'envoi), swap `.next` +
   `node_modules` via `cp -al`, la version précédente est conservée
   (`.next.old` / `node_modules.old` — couple cohérent de rollback) ;
4. **Health check** post-restart (6 essais) : en cas d'échec,
   **ROLLBACK automatique** vers la version précédente ;
5. Un SHA en échec est **blacklisté** (`failed_commits.txt`) : jamais de
   boucle de crash ;
6. **Vérification de bout en bout** : la production doit servir EXACTEMENT
   le build livré — l'empreinte `/api/deploy-info` et le manifeste
   `/version.json` sont comparés au `BUILD_ID` compilé ; un écart = run
   rouge (« plus jamais un déploiement vert mais muet »).

### 3.2 Les règles

- **`main` toujours vert.** Un merge rend `main` rouge ⇒ priorité absolue
  au fix ou au revert. On ne « laisse filer » jamais : sur ce dépôt, `main`
  rouge = production potentiellement dégradée (déploiement continu).
- **Jamais de push sur `main` en cas d'échec CI** — ni sur la PR, ni pour
  « tester ». La CI verte est la condition d'entrée du déploiement, pas une
  option stylistique.
- **Pas de déploiement majeur sans test de charge préalable** : smoke
  `scripts/charge/k6-chat-smoke.js` (10 VU · 60 s, seuils p95 < 3 s /
  échecs < 1 %) via le workflow **manuel** `.github/workflows/load-test.yml`
  ; stress progressif `scripts/load/k6-stress.js` selon le cadre de
  `docs/load-testing.md`.
- **Secrets uniquement dans les secrets GitHub / `.env.production` du VPS**
  (jamais dans le dépôt) ; toute nouvelle variable est documentée dans
  `.env.example`.
- **L'updater PM2 reste suspendu pendant la bascule** (course avec le
  finisher) — ce détail de `deploy-vps.yml` fait partie du contrat CD, ne
  pas le « simplifier ».

## 4. Revue de code rigoureuse

- **Un relecteur par changement, distinct de l'auteur** — humain ou agent IA
  indépendant. Le `.github/CODEOWNERS` (`* @missock237-spec`) matérialise la
  revue obligatoire : la relecture n'est pas négociable, même (surtout) en
  solo.
- **Présoumission automatisée = CI obligatoirement verte AVANT la revue.**
  Le relecteur ne relit pas pour trouver les erreurs de type : c'est le
  travail de la CI. La revue porte sur ce que la CI ne voit pas : périmètre,
  design, invariants, sécurité métier, honnêteté des tests.
- **La relecture par un agent IA compte**, à condition d'être réellement
  indépendante (autre agent que l'auteur, lecture du diff + des invariants,
  rapport écrit). Mais **l'orchestrateur (le propriétaire) relit les diffs**
  des agents avant merge : l'agent produit la première passe, l'humain porte
  la responsabilité du merge.
- **Support de revue = la PR** (modèle `.github/pull_request_template.md`) :
  contexte, changements, tests effectués, risques & plan de rollback,
  checklist (CI verte, aucun secret commité, docs à jour, périmètre
  respecté, redirections mises à jour si pages supprimées). Une section vide
  = PR renvoyée.
- **Petits diffs.** Une revue n'est honnête que sur un diff lisible :
  les monolithes (> 1 500 lignes) se découpent AVANT d'être modifiés
  (pattern `lib/domain/conversations/engine.ts` → 9 modules). Un diff de
  milliers de suppressions (surfaces mortes) se relit différemment : par
  références résiduelles (grep zéro dangling) et redirections.

## 5. Fiabilité : SLI/SLO et budgets d'erreur

Le tableau de bord, les SLI/SLO et le calcul du budget d'erreur vivent dans
[`docs/sre/sli-slo.md`](sre/sli-slo.md) (exposition des métriques :
`/api/metrics`).

**Règle d'or : budget d'erreur épuisé = gel des features.** Tant que le
budget du trimestre n'est pas reconstruit, l'effort va à la fiabilité
(correction des causes, réduction de la latence p95, durcissement) et PAS à
de nouvelles fonctionnalités. En mode solo, c'est la protection la plus
importante contre l'attrait permanent du « juste une petite feature de
plus » : les utilisateurs pardonnent l'absence d'une feature, pas une
plateforme instable.

## 6. Postmortems sans blâme

Chaque incident de production = **un postmortem sous 72 h**, écrit à partir
du modèle [`docs/sre/postmortem-modele.md`](sre/postmortem-modele.md) et
stocké avec les incidents. Principes : sans blâme (on analyse le système, on
ne juge pas les personnes — y compris les agents IA, dont les échecs révèlent
toujours un défaut de garde-fou collectif), chronologie factuelle, causes
racines, actions correctives datées et assignées, lien avec les SLI/SLO. Les
runbooks opérationnels complètent le dispositif :
[`docs/runbooks/incident-response.md`](runbooks/incident-response.md) et
[`docs/runbooks/deployment.md`](runbooks/deployment.md).

## 7. Définition du « fait » (definition of done)

Un changement est **« fait »** quand TOUT ce qui suit est vrai — pas avant :

1. **Code** : écrit dans le périmètre convenu, conventionnellement commité en
   français, fichiers d'en-tête documentés ;
2. **Vérifications locales** passées (relecture statique, tests ciblés) ;
3. **CI verte** sur la PR : typecheck, lint, tests (seuils de couverture),
   audit production, build, budget bundle, E2E émulateur, accessibilité
   axe-core, gitleaks ;
4. **Revue faite** par un relecteur distinct de l'auteur (checklist PR
   complète) ;
5. **Docs à jour** : README / `docs/` / `.env.example` / en-têtes, et
   redirections alignées si des pages ont bougé ;
6. **Rollback pensé** : plan de retour arrière écrit dans la PR (revert,
   redirection, flag) ;
7. **Déployé et vérifié en prod** : run `deploy-vps.yml` SUCCESS, la
   production sert le bon build (`/api/deploy-info` + `/version.json`),
   smoke santé (`/api/health`, `/api/status`) au vert ;
8. **Journal tenu** : worklog de session à jour (bilan + commits), rapport
   d'agent le cas échéant.

La différence entre « ça marche sur ma machine » et « fait », c'est les
points 3, 7 et 8 : la preuve automatisée, la preuve en production, la
mémoire collective.

## 8. Rituels (cadence solo + agents)

| Fréquence | Rituel | Contenu |
|---|---|---|
| À chaque session | Plan d'orchestration | Périmètres stricts par agent, branches dédiées, interdits (pas de push/merge, pas de `npm install`), rapport obligatoire |
| Au moins 1×/jour | Intégration | Merge des branches vivantes → build → push `main` → 1 déploiement → vérification prod |
| Avant déploiement majeur | Test de charge | Smoke k6 (workflow manuel) ; stress si changement d'architecture |
| Hebdo | Fiabilité | Relecture SLI/SLO + budget d'erreur (`docs/sre/sli-slo.md`) : budget épuisé ⇒ gel features |
| Sous 72 h après incident | Postmortem | Modèle sans blâme, actions correctives suivies jusqu'à clôture |
| Trimestriel | Revue de roadmap | `docs/feuille-de-route-google-grade.md` : statuts réévalués, conditions de déclenchement des phases vérifiées |

## 9. Ce que ce processus N'EST PAS

- Une bureaucratie : chaque règle ci-dessus a causé un incident réel ou
  empêché un (la CI verte évite les déploiements cassés, le CODEOWNERS
  évite les merges sans relecture, le smoke évite les mises en ligne
  douloureuses) ;
- Figé : toute règle qui coûte plus qu'elle ne protège se retire en
  postmortem, explicitement, pas en silence ;
- Un substitut à la confiance : le processus encadre les agents IA parce
  qu'ils sont rapides et confiants, pas parce qu'ils sont non fiables —
  la vitesse sans garde-fou est la seule vraie menace de ce projet.
