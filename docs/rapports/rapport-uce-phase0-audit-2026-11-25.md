# Rapport Phase 0 — Audit initial UCE (Universal Capability Engine)

**Date** : 2026-11-25 · **Branche** : `evolution/uce-v1` (base `main` = `2a18c44`, PR #171 fusionnée) · **Mission** : unification des outils + moteur de capacités universel.

## 1. État réel du dépôt (vérifié, pas supposé)

- `main` local aligné sur `origin/main` (`2a18c44` « DATASETS PROFESSIONNELS PRO2 fusionnée (#171) ») ; arbre propre ; aucune PR ouverte côté local.
- Stack réel **vérifié** : Next.js 15.5.28 + React 19.3.1 + TypeScript, **Firebase/Firestore** (`firebase-admin` 14.5.0, helpers résilients `lib/db/firestore-resilient.ts`), cache **process-local** (`lib/cache/redis.ts` — Redis supprimé Task 108, API conservée), vitest 5 (environment node, stub `server-only`), CI GitHub Actions (typecheck + lint + vitest avec seuils de couverture + build + budget bundle + E2E Firebase).
- **Écart stack vs mission §9** : la mission prévoit PostgreSQL comme stockage principal. Le dépôt ne contient **aucun** PostgreSQL/Prisma (pas de `prisma/`, pas de dépendance). Décision conforme à la règle « respecter l'architecture actuelle lorsqu'elle est saine » : persistance UCE sur **Firestore** (multi-tenant, collections dédiées) avec repli fichiers locaux versionnés (motif éprouvé du cerveau autonome), entités de la mission conservées à l'identique en tant que collections/documents. Écart documenté, réversible.
- Runtime réel du sandbox d'audit : Node v24.22.3, Python 3.12.16, Linux x64.

## 2. Inventaire exhaustif des outils existants (fonctionnels, vérifiés dans le code)

### 2.1 Registre central d'exécution — `lib/tools/`
- `createDefaultToolRegistry()` (`default-registry.ts`, 264 lignes) : enregistre ~90 `ToolDefinition` (schéma zod + `execute` réel). Enregistrements conditionnels honnêtes : Composio/Zendesk/ServiceNow si `COMPOSIO_API_KEY`, Notion si `NOTION_API_TOKEN`, Cloudflare si `CLOUDFLARE_API_TOKEN`, GitHub/build.autofix si `GITHUB_TOKEN`, messaging/email selon fournisseurs configurés. **Aucun outil fantôme** : les ghost-tools ont été retirés à l'it.58 (file.modify, voice.list, phone.call, ui.components, jules.*).
- Catalogue déclaratif `GEN3IA_TOOLS` (`registry.ts`, 153 lignes) : ~90 entrées {name, description, risk, permission, sideEffect} — la vue du planificateur.
- Historique d'audit réel : `lib/tools/audit.ts` (`recordToolAudit`).

### 2.2 Les DEUX chemins d'exécution (cible de l'unification Phase 1)
1. **`executeTool(request)`** (`lib/tools/executor.ts`) + classe **`ToolExecutor`** : chemin principal (moteur conversationnel, `/api/tools/execute`). Sécurité en 3 couches : arrêt d'urgence (`assertExecutionNotStopped`) → politique (`authorizeTool`, allowlists + gates réseau/FS/destructif/external) → consentements par catégorie (`decideConsent`) ; audit inopérant fail-soft ; sandbox dédié pour `code.execute`.
2. **`executeToolSecurely()`** (`lib/agents/runtime/secure-tool-executor.ts`) : pipeline sécurisé partagé du runtime agents (appelé par `runner.ts`).
3. **`executeThroughGateway()`** (`lib/execution/execution-gateway.ts`) : appelé uniquement par `app/api/tools/execute/route.ts`.
→ Les trois partagent `createDefaultToolRegistry()` mais **pas** un contrat d'enregistrement d'exécution unique : chaque chemin journalise et autorise à sa façon. **Risque de divergence confirmé** — l'UCE doit poser un contrat commun sans casser les trois surfaces (règle de non-régression).

### 2.3 Composants réutilisables identifiés (mapping UCE → existant)
| Composant UCE | Réutilisation principale (vérifiée) |
|---|---|
| Catalogue unifié | `lib/capabilities/catalog.ts` existe déjà (lecture pure, agrège outils/skills/extensions/APIs/MCP/réseaux) — conservé et étendu |
| Découverte npm/PyPI | `lib/tools/agent-suite/registry-find.ts` (URLs réelles registres, helpers `isMcpServerPackage`, `freshnessVerdict`) |
| Découverte MCP | `lib/integrations/mcp/{service,store,client}.ts` (sonde réelle, SSRF `assertPublicHttpUrl`, cache 10 min) |
| Découverte modèles | API publique Hugging Face `/api/models` (connectivité 200 vérifiée) |
| Découverte GitHub | API `/search/repositories` — **403 anonyme constaté**, nécessite `GITHUB_TOKEN` (absent) → dégradation honnête |
| Benchmark/sandbox | `ExecuteurSandbox` (`lib/agents-os/dispatch/executeur-sandbox.ts` : timeout/heap/réseau none, résultat balisé) + `executeSandbox` (`lib/sandbox/client.ts`) |
| Compétences | `lib/autonomous/skills/moteur-competences.ts` (`RegistreCompetences`, validation pratique en sandbox réelle) |
| Apprentissage continu | `lib/autonomous/continual-learning/` (`adapterSansOubli`, mesuré PRE/POST, rollback si Δ < −0.02, SEUIL_DEGRADATION) |
| Mémoire de connaissances | `lib/autonomous/knowledge/memoire-connaissances.ts` (JSONL append, dernier record gagne) |
| Cerveau central | `lib/autonomous/core/orchestrator.ts` (`getCoeurAutonome`, contrat `ModuleAgent`, tâches traçables, bus d'événements, reprise) |
| Sécurité | `authorizeTool` (`lib/security/tool-permissions.ts`), `checkPermission`, `url-safety.ts` (SSRF), `emergency-stop`, `tool-consents`, `secret-masking.ts` (`maskSecrets`), hook gitleaks |
| Persistance | `lib/db/firestore-resilient.ts` (`resilientCreate/Set/Get/List/Query/Delete`, `firestoreUsable()`), motif repository : `lib/integrations/custom-apis/repository.ts`, schéma zod : `lib/integrations/mcp/store.ts` |
| Admin | Motif `app/admin/autonomous/page.tsx` (client component, `authFetch`, poll 60 s) + `app/api/admin/*/etat|commandes` (admin cryptographique, fail-soft) |
| Monitoring | `lib/autonomous/monitoring/{error-monitor,health-check,recovery-manager}.ts` |

### 2.4 Doublons et incohérences détectés
- **Doublon de catalogue** : `GEN3IA_TOOLS` (registre déclaratif) vs `createDefaultToolRegistry()` (registre d'exécution). La cohérence catalogue↔registre est testée (`audit.guard.test.ts`), mais le catalogue liste des outils parfois non enregistrés selon l'environnement (ex. `composio.execute` sans clé) — comportement assumé et documenté (échec propre), à harmoniser dans la vue UCE avec un champ `enregistre: boolean`.
- **Deux exécuteurs sandbox** : `ExecuteurSandbox` (agents-os, script Node `emettre()`) et `executeSandbox` (lib/sandbox, runtimes node/python/shell) — finalités différentes (compétences vs code.execute utilisateur) ; l'UCE les embrasse via `sandbox-manager` sans fusionner (pas de suppression fonctionnelle).
- **Trois surfaces d'autorisation** (voir 2.2) — unifiées dans le contrat UCE (gateway) en délégant, pas en remplaçant.

## 3. Environnement de découverte (connectivité réelle mesurée)

| Source | Statut mesuré (2026-11-25) |
|---|---|
| registry.npmjs.org | HTTP 200 |
| pypi.org/pypi/<pkg>/json | HTTP 200 |
| api.github.com/search | **HTTP 403 anonyme** (token requis) |
| huggingface.co/api/models | HTTP 200 |
| Registres MCP | via npm (`isMcpServerPackage`) + catalogue embarqué ; registre public MCP optionnel |

Secrets disponibles : aucun token d'intégration présent dans l'environnement d'audit (GITHUB_TOKEN, HF_TOKEN, COMPOSIO_API_KEY… tous absents) → toutes les découvertes doivent dégrader honnêtement (statut `indisponible` + cause), jamais de données inventées.

## 4. Tests de référence (baseline pré-UCE)

- `npm run typecheck` et `npx vitest run` complets exécutés en début de branche ; résultats consignés dans le rapport final Phase 9 (`docs/rapports/rapport-uce-v1-*.md`). Toute régression par rapport à cette baseline bloque la fusion.

## 5. Décisions d'architecture (Phase 0)

1. **Contrat unique** : `lib/capabilities/core/capability-contract.ts` (types + zod) — tout le reste du code UCE le consomme.
2. **Gateway unifié par délégation** : `execution/universal-gateway.ts` délègue aux exécuteurs existants (zéro remplacement, zéro suppression) et produit un enregistrement d'exécution normalisé (id, demande, outil, permissions, état, durée, résultat, journaux, vérification).
3. **Persistance** : Firestore + repli local (`var/capabilities/`), enregistrements versionnés (`schemaVersion`) avec migrations réversibles.
4. **Sécurité d'abord** : aucun contenu externe ne devient instruction ; découvertes = données ; intégration production **jamais** automatique (autorisation admin obligatoire, défaut OFF).
5. **Cerveau unique** : le cycle UCE est un `ModuleAgent` armé par `lib/autonomous/index.ts` (gated `AUTO_CAPABILITIES`, défaut armé) — pas un second cerveau ; les décisions sensibles (sélection finale, intégration) restent gated par la configuration/admin.

## 6. Périmètre Phase 0 — livrable

Ce rapport = état initial documenté. Aucun fichier produit ni modifié hors `docs/rapports/` à ce stade. Baseline de tests établie avant tout développement.
