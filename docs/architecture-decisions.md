# Décisions d'architecture — Gen3ia

> Journal des décisions techniques structurantes. Chaque entrée expose le
> contexte, les options envisagées, la décision et les déclencheurs de
> réévaluation. Statuts : `Proposée` / `Acceptée` / `Supplantée`.

---

## ADR-001 — Séparation back/front : conserver les routes API Next.js

**Statut :** Acceptée (réévaluation planifiée) · **Date :** 2026-09-19

### Contexte

Le backend actuel vit dans les route handlers `app/api/**` (Next.js 16,
runtime Node). La plateforme appelle aujourd'hui ~45 routes : agents,
billing, live, voice (Twilio/Plivo), extensions, storage R2, équipes,
code-agents (21st.dev), webhooks Chariow. Plusieurs traitements longs
(exécutions d'agents, gateway Live WebSocket sur `lib/live/gateway-server.ts`)
dépassent le périmètre naturel d'une route HTTP.

### Options envisagées

1. **Statu quo — routes API Next.js** : déploiement unique, auth par cookie
   partagé simple, cold starts maîtrisés, latence minimale pour le front.
2. **API dédiée (Fastify)** : process séparé, testabilité unitaire supérieure,
   scaling horizontal indépendant ; coût = deuxième déploiement, auth à
   re-câbler (JWT cross-service), duplication des types ou monorepo pnpm.
3. **API dédiée (NestJS)** : les bénéfices du 2 + DI/modularité forte ;
   coût additionnel = courbe d'apprentissage et boilerplate, poids
   disproportionné à la taille actuelle de l'équipe.

### Décision

**Conserver les routes API Next.js** tant que les trois déclencheurs
ci-dessous ne sont pas réunis. En cas de déclenchement, **Fastify** est
préféré à NestJS : le runtime Node + zod + pino existants s'y retrouvent
à l'identique, sans framework imposé.

### Déclencheurs de réévaluation

- Exécutions d'agents > 60 s systématiques (besoin de files durables :
  BullMQ/Redis plutôt que des fonctions serverless).
- Besoin de connexions WebSocket persistantes multi-régions (le gateway
  Live actuel est un process Node séparé — premier candidat à l'extraction).
- Équipe backend dédiée ≠ équipe frontend (conway).

### Mesures d'atténuation actuelles

- Logique métier déjà massivement extraite dans `lib/**` (modules purs,
  testés hors HTTP) — une extraction future de l'API serait un transport
  swap, pas une réécriture.
- Contrats d'entrée validés par zod sur toutes les routes sensibles.

---

## ADR-002 — State management global : ne pas introduire Zustand/Redux

**Statut :** Acceptée (conditionnelle) · **Date :** 2026-09-19

### Contexte

L'état client est aujourd'hui : état d'authentification Firebase
(`lib/firebase/auth-client.tsx`), état serveur (fetch + `useState` locaux),
navigation (URL). Aucun partage d'état mutable complexe entre pages.

### Décision

**Ne pas introduire** de store global tant que les déclencheurs suivants ne
sont pas réunis. Raison : un store global ajouterait une couche de
synchronisation à maintenir sans consommateur réel ; le risque d'état
divergent avec le serveur (wallet, exécutions) augmenterait.

### Déclencheurs

- Présence de state partagé entre ≥ 3 pages non liées par navigation
  (ex. : panier d'outils multi-pages, sessions Live observées en direct).
- Nécessité d'optimistic updates généralisés sur le wallet.
- Tables temps réel (exécutions en cours) consommées par plusieurs
  composants simultanément → préférer alors un store par domaine
  (Zustand slices) plutôt qu'un Redux Toolkit global.

---

## ADR-003 — Fichiers volumineux : découpage incrémental par responsabilité

**Statut :** Acceptée · **Date :** 2026-09-19

### Décision

Les composants dépassant ~400 lignes sont décomposés quand une frontière
naturelle existe, sans changement de comportement :

- `components/nav/app-nav.tsx` (304 → 182 lignes) : palette ⌘K extraite
  vers `components/nav/command-palette.tsx`, inventaire de navigation
  vers `components/nav/nav-items.ts` (source unique partagée).
- `components/agent/universal-agent-chat.tsx` (537 lignes) : candidat au
  découpage (bulles de message, barre d'approbation, état de conversation)
  lors de la refonte professionnelle du chat.

Règle : un fichier porte **une** responsabilité visible ; les hooks
d'état complexes migrent vers `components/**/use-*.ts` dès qu'ils sont
réutilisés ou testables isolément.

---

## ADR-004 — Chats agents IA : professionnalisation du rendu et du flux

**Statut :** Proposée · **Date :** 2026-09-19

### Contexte

Les conversations (`chatConversations`/`chatMessages`, Admin SDK) et le
chat universel agent rendent aujourd'hui du texte brut/approbations sans
distinction visuelle des étapes, coûts ou artefacts.

### Décision proposée

1. Rendu structuré : bulles par rôle, étapes du plan RuntimePlan
   (llm/tool/code/document) avec statut, coût par étape, artefacts liés.
2. Flux d'approbation : actions sensibles affichées en bloc dédié avec
   `approvalId`, boutons autoriser/refuser, traçabilité visible.
3. Accessibilité : `role="log"` sur le fil, annonce des nouveaux messages,
   navigation clavier complète.

La mise en œuvre est réalisée avec la refonte du chat universel
(`components/agent/universal-agent-chat.tsx`).
