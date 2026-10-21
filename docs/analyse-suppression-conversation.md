# Analyse — « Supprimer définitivement le système de conversation »

> Demande utilisateur n°4 · branche `feat/suppression-conversation` · PR d'ANALYSE (aucune suppression de code).
>
> **Verdict : le « système de conversation » n'existe PAS en tant que module distinct du chat IA.**
> Toute occurrence de « conversation » dans le dépôt appartient soit au **chat IA** (fonctionnalité de premier plan, hors périmètre de suppression), soit au **moteur neural/SNN**, soit à l'**entraînement automatique**. Conformément au principe d'honnêteté technique (« ne supprime rien que tu ne peux pas prouver être le module visé »), **rien n'a été supprimé**. Ce document fournit le classement complet occurrence→classification et les recommandations.

---

## 1. Méthode d'investigation

1. Balayage exhaustif : `rg -i "conversation"` sur `app/`, `lib/`, `components/`, `middleware.ts`, `scripts/` (~270 fichiers concernés, ~2 800 occurrences).
2. Construction du graphe d'imports de chaque cluster (« conversation » dans le nom, puis références croisées).
3. Identification des **points d'entrée HTTP réels** de chaque surface de chat (fetch côté client) pour établir qui consomme quel backend.
4. Vérification historique (`git log --grep=conversation`) : aucun module « conversation » séparé n'a jamais existé ni été supprimé par le passé — le chat et l'espace conversationnel partagent le même backend depuis leur création (Task 163).

## 2. Preuve centrale : UN SEUL backend conversationnel, partagé par toutes les surfaces de chat

Le backend du chat IA **EST** le module « conversations » (`/api/workspace/conversations/**` + `lib/domain/conversations/**`). Toutes les interfaces de chat du projet — y compris le **Chat IA premier plan** — lui sont câblées :

| Surface de chat | Fichier | Appels réseau (preuve) |
|---|---|---|
| **Chat IA (dashboard)** — nav « chat-ia » | `components/chat/nova-chat.tsx` | commentaire ligne 27 : *« Backend identique au workspace : POST /api/workspace/conversations[…] »* ; fetch lignes 816, 884, 1142, 1162 |
| **Chat Aurora (/chat)** | `components/chat/aurora-chat.tsx` | fetch `/api/workspace/conversations` lignes 189, 209, 375, 482, 601, 623 |
| **Chat v4 (/chat-v4)** | `app/chat-v4/page.tsx` | en-tête lignes 9-13 : POST/DELETE/PATCH `/api/workspace/conversations[...]` |
| **Ondes W-DNN (labo)** | `components/ondes/laboratoire-ondes.tsx` | fetch ligne 452 |
| **Essaim d'agents (console)** | `components/essaim/console-essaim.tsx` | fetch ligne 363 |
| **Espace « Conversations » (/workspace)** | `components/workspace/conversation-workspace.tsx` | fetch lignes 150, 191, 240, 419, 518, 599 |
| Client de flux partagé | `lib/domain/conversations/stream-client.ts` | ligne 55 : `POST /api/workspace/conversations/${id}/messages/stream` |

Le moteur de tour conversationnel (`lib/domain/conversations/engine.ts`, 3 814 lignes) appelle `lib/ai/router` (génération), `lib/neural/**` (moteur Gen3), les outils, la mémoire et la facturation : c'est le **cœur du chat IA**, pas un module annexe. Supprimer « le système de conversation » détruirait le chat IA lui-même — explicitement protégé par la demande (liste blanche : « chat ia »).

## 3. Tableau de classification occurrence → catégorie

### (a) Moteur/SNN interne — NE PAS TOUCHER

| Fichiers | Nature |
|---|---|
| `lib/neural/generation/corpus.ts` (+`language.ts`, tests) | Paires conversationnelles du corpus du moteur (interdiction explicite) |
| `lib/neural/engine.ts`, `runtime.ts`, `evolution.ts`, `memory/hippocampus.ts`, `decoding/response-decoder.ts`, `core/types.ts`, `training/dataset.ts`, `training/job.ts`, `pilotage/pilote.ts` (+`gen3ia.ts`, test) | Moteur SNN : lecture des conversations comme contexte mémoire/pilotage |
| `lib/ondes/decodeur.ts` | Décodage W-DNN (mention conversationnelle) |
| `lib/entrainement-auto/*` (`catalogue.ts`, `maitrise.ts`+test, `phases.ts`, `plafonds.ts`, `ingesteur.ts`, `entraineur-auto.ts`, `types.ts`) | Domaine d'entraînement « conversation » (1 500 paires ingérées) — interdiction explicite |
| `lib/training/*` (`rules`, `validation/dataset-files`, `catalog`) | Règles de datasets mentionnant le domaine conversation |
| `components/neural/neural-console.tsx`, `app/neural/page.tsx` | Cerveau IA : onglet « Conversation » qui parle au moteur (`/api/neural/cycle`) |

### (b) Chat IA et ses infras — NE PAS TOUCHER

| Cluster | Fichiers | Nature |
|---|---|---|
| **Backend conversationnel du chat** | `app/api/workspace/conversations/**` (CRUD, messages, stream NDJSON, search + tests), `lib/domain/conversations/**` (21 fichiers : engine, context-window, stream-client/events, intents image/vidéo/agent/services, artefact-apps, app-detect, web-context, follow-ups, types + tests), `lib/chat/repository.ts` (+ tests), `lib/chat/vector-index.ts` (+ test) | Persistance (R2 `users/{uid}/conversations/...`), index vectoriel Qdrant, moteur de tour, streaming |
| **UI chat** | `app/dashboard/page.tsx` + `components/chat/nova-chat.tsx`, `app/chat/page.tsx` + `components/chat/aurora-chat.tsx` (+ css/widgets), `app/chat-v4/page.tsx`, `components/ondes/laboratoire-ondes.tsx`, `components/essaim/console-essaim.tsx` | Surfaces de chat premier plan |
| **Chat agents (studio)** | `app/api/agent/chat/**` (+`continue/`, `approve/`, tests), `lib/agents/chat-engine.ts` (+test), `lib/agents/conversation-run.ts` (+test, pont mission↔conversation), `app/api/chat/conversations/**` (+test), `app/api/chat/message/route.ts` (chat générique ; mort dans l'UI mais chat API protégée), `components/agent/agent-chat-panel.tsx`, `agent-chat-workshop.tsx` | Chat avec agents spécialisés (fonctionnalité chat, hors périmètre) |
| **Infra transverse du chat** | `lib/ai/*` (grounding, feedback, clarification-followup, context-window, truth-context, response-quality, self-review, auto-improvement, prompt-*, vision-input), `lib/memory/episodic.ts` (+test, privacy, types), `lib/knowledge/chat-context.ts`, `lib/media/analyze.ts`, `lib/files/attachment-*`, `lib/tools/*`, `lib/integrations/mention.ts` | Contexte, mémoire, pièces jointes, outils du tour conversationnel |
| **Routes liées aux conversations** | `app/api/memory/search`, `app/api/settings/export-data` (+test, export RGPD des conversations), `app/api/auth/account` (purge des conversations à la suppression de compte), `app/api/health/infra` (+test, santé Qdrant `gen3ia_conversations`), `app/api/files/import`, `app/api/integrations/mention`, `app/api/queue/mission-tick` + `lib/queue/mission-continuation.ts` (+test), `app/api/video/projects/[projectId]/**` + `lib/video/*`, `app/api/workspace/approvals/[approvalId]/route.ts`, `app/api/workspace/missions`, `app/api/workspace/artifacts`, `app/api/observability/org`, `app/api/developer/ide/files`, `app/api/public/commercial/[slug]` | Références `conversationId` : missions, livrables vidéo, exports RGPD, santé, observabilité |
| **Domaine lié** | `lib/domain/runs|approvals|artifacts|projects/**` (repos + tests) | Runs/approbations/artefacts de l'espace conversationnel (aussi consommés par le chat agents et les missions) |
| **UI transverse** | `components/workspace/markdown.tsx`, `audio-delivery.tsx`, `artifact-panel.tsx`, `artifact-preview.tsx`, `skeletons.tsx`, `labels.ts` (consommés par chat Aurora, chat agents, pages Fichiers/Projets et ~15 `loading.tsx`), `components/notifications/notification-center.tsx`, `components/ads/*`, `components/integrations/app-logo.tsx`, `components/nav/*` | Composants partagés au-delà du seul espace conversationnel |
| **Pages/content** | `app/workspace/**` (layout, bibliotheque, files, projects, training…), `app/preview/[id]/page.tsx` (aperçu des apps générées en conversation), `app/page.tsx`, `app/en/page.tsx`, `app/privacy/page.tsx`, `app/studio/clients/page.tsx` | Navigation, mentions légales (RGPD), copy marketing |
| **Scripts** | `scripts/backfill_conversation_index.ts`, `qa_semantic_search.ts`, `e2e_*`, `verify_*` | Outillage d'indexation/e2e du chat |

### (c) Système « conversation » autonome distinct — candidat à suppression

**AUCUN.** Les seuls éléments nommés « Conversations » (`app/workspace/conversations/**`, `components/workspace/conversation-workspace.tsx`, `conversation-list.tsx`, nav « conversations » → `/workspace`) sont **un frontal de plus du même backend que le chat IA** (voir §2). Ce ne sont ni un ancien module persistant indépendant, ni un système de conversations utilisateur-à-utilisateur (la messagerie `agentMessages` de `lib/agents/networks/messages.ts` est agent-à-agent au sein d'un réseau, feature « agents », pas « conversations »).

Supprimer ces frontaux sans toucher au backend ne supprimerait pas « le système de conversation » — il resterait intégralement en place pour le dashboard, /chat, /chat-v4, Ondes et Essaim — et retirerait une entrée de navigation primaire (exécutions d'agents avec plans, validations et livrables).

## 4. Données concernées (information — aucune migration destructive exécutée)

Si une future décision produit visait les données conversationnelles, les chemins réels sont :

| Stockage | Chemin / collection | Rôle |
|---|---|---|
| R2 « mémoire par utilisateur » (`lib/storage/user-data-store`) | `users/{uid}/conversations/{cid}.json` | Métadonnées de conversation |
| idem | `users/{uid}/conversations/{cid}/messages/{ulid}.json` | Messages (ULID = ordre chronologique) |
| idem | `users/{uid}/runs/{runId}.json` | Timelines d'exécution (runs) liées aux conversations |
| Qdrant (`lib/chat/vector-index.ts`) | collection `gen3ia_conversations` | Index vectoriel sémantique des messages |
| Firestore | `conversationArtifacts` | Artefacts produits dans les conversations |
| Firestore | `conversationApprovals` | Validations humaines (HITL) |
| Firestore | `notifications` (champ `conversationId`) | Notifications liées aux fils |
| Firestore | `agentMessages` | Messagerie agent-à-agent (feature réseaux d'agents — hors « conversations ») |

## 5. Recommandations

1. **Ne pas supprimer** `lib/domain/conversations`, `app/api/workspace/conversations`, `lib/chat/*` : c'est le backend du chat IA premier plan (preuve §2).
2. Si l'objectif réel est de **retirer le frontal redondant « Conversations » (/workspace)** au profit du Chat IA (dashboard) : faisable en surface uniquement — `app/workspace/page.tsx` (redirect), `app/workspace/conversations/**` (4 fichiers), `components/workspace/conversation-workspace.tsx` + `conversation-list.tsx` (+ `message-thread`, `context-drawer`, `run-timeline`, `approval-card`, `composer/*` après vérification d'usage), entrée « conversations » de `components/shells/nav-registry.ts` + `components/nav/nav-items.ts`, ré-hébergement de `PENDING_MESSAGE_PREFIX` (importé par `app/workspace/bibliotheque/page.tsx`), mise à jour des 4 tests qui lisent ces fichiers (`ux-accessibility`, `agent-interaction-ux`, `library-handoff`, `missions-panel`). **Décision produit requise** (entrée de nav primaire) — hors périmètre de cette PR.
3. `app/api/chat/message/route.ts` : route de chat générique morte dans l'UI (aucun appel applicatif ; `public/sw.js` le documente) mais utilisée par des scripts e2e/verify et protégée en tant que « chat API » — retrait éventuel à traiter dans une tâche dédiée au chat IA.
4. Aucune action requise sur `lib/neural/**`, `lib/entrainement-auto/**`, `app/api/training/**`, `middleware.ts` (hors périmètre).

## 6. Conclusion

La demande « supprimer le système de conversation » se heurte à un fait d'architecture : **le module « conversation » et le chat IA sont le même système** (un backend, cinq frontaux). Conformément à la consigne n°3 de la mission (honnêteté prime sur l'action), cette PR livre l'analyse et **aucune suppression de code**. Toute suppression ciblerait nécessairement le chat IA lui-même et doit passer par une décision produit explicite.

## 7. Reprise T4 — ré-verification indépendante (2026-10-21)

L'agent de reprise a re-vérifié indépendamment chaque preuve clé avant la PR :

| Preuve | Résultat de ré-verification |
|---|---|
| `components/chat/nova-chat.tsx` (Chat IA dashboard) | fetch `/api/workspace/conversations` lignes 816, 884, 1142, 1162 ; commentaire ligne 27 confirmé |
| `components/chat/aurora-chat.tsx` | fetch lignes 189, 209, 375, 482, 601, 623 |
| `app/chat-v4/page.tsx` | en-tête lignes 11-13 : POST/DELETE/PATCH + stream NDJSON `/api/workspace/conversations` |
| Ondes / Essaim | `laboratoire-ondes.tsx:452`, `console-essaim.tsx:363` → même backend |
| `lib/domain/conversations/engine.ts` | 3 813 lignes ; imports `lib/ai/router`, `lib/ai/*`, `lib/tools/*`, `lib/agents/*`, `lib/security/*` — cœur du chat |
| `lib/agents/conversation-run.ts` | pont mission runtime ↔ conversation (feature agents) |
| `app/api/chat/conversations` | consommé par `agent-chat-panel.tsx` / `agent-chat-workshop.tsx` (chat agents) |
| `app/api/chat/message` | retiré de la file SW (`public/sw.js:26`), encore référencé par tests (`app/ai-response-quality.test.ts`, `pwa-consistency.test.ts`) + e2e ; chat API protégée |
| Corpus moteur | `lib/neural/generation/corpus.ts` : « CORPUS CONVERSATIONNEL INTÉGRÉ du cortex langagier Gen3 » (interdiction) |
| Domaine d'entraînement | `lib/entrainement-auto/catalogue.ts` : requêtes « french conversation dialogue », « assistant conversation pairs » (interdiction) |
| Stockage | R2 `users/{uid}/conversations/...` (`lib/chat/repository.ts:29-30`), Qdrant `gen3ia_conversations` (`lib/chat/vector-index.ts:33`), Firestore `conversationArtifacts` / `conversationApprovals` (`lib/domain/artifacts|approvals/repository.ts`) |
| Navigation | `components/shells/nav-registry.ts:89-96` : entrée primaire « Conversations » → `/workspace` ; `components/nav/nav-items.ts:41` |
| Middleware | `middleware.ts:70` : mention commentaire uniquement (modale d'aperçu) |

Comptages bruts `rg -i "conversation"` (mesure de reprise) : **app/** 66 fichiers / 639 occurrences, **lib/** 166 fichiers / 1 185 occurrences, **components/** 41 fichiers / 596 occurrences — ~2 400 occurrences au total, 100 % classées (a) ou (b) ; classe (c) vide.
