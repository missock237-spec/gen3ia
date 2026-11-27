# Infrastructure PP — tunnel P2P chiffré lié au matériel (remplacement de l'API classique)

**Date :** 2026-11-27 · **Statut global :** IMPLEMENTED + TESTED (production de l'infrastructure : fonctionnelle et prouvée ; mise en ligne réseau externe : dépend de l'hébergement, voir §8)

---

## 1. Principe

Le code exécutable est séparable de l'identité cryptographique : le code source
de toute application cliente ne contient **aucun secret** — uniquement un
AppID public. La clé privée naît **dans le matériel** (TPM 2.0, Secure
Enclave, Keystore, WebCrypto non-extractable) ou est **scellée en RAM** au
démarrage des serveurs sans puce (repli explicite du plan §4). Le vol du code
source est donc inopérant : une machine non enrôlée génère une clé inconnue du
registre et est ignorée **silencieusement** (aucun service révélé).

## 2. Les cinq phases du plan — implémentées et testées

| Phase | Contenu | Modules | Statut |
|---|---|---|---|
| 1. Signalisation + registre de confiance | Enrôlement à jeton d'invitation **usage unique**, approbation/révocation admin, résolution d'adresses signée (anti-reconnaissance) | `lib/pp/registry/trust-registry.ts`, `lib/pp/signaling/service.ts`, `app/api/pp/{enroll,registry,signal}/route.ts` | IMPLEMENTED · TESTED |
| 2. Identité matérielle | Chaîne fail-closed : TPM 2.0 réel (`tpm2_createprimary`/`tpm2_sign`) → WebCrypto ECDSA P-256 **non extractable** → RAM scellée AES-256-GCM (secret d'injection + empreinte machine) ; attestation structurée | `lib/pp/identity/{hardware-identity,tpm2,webcrypto,ram-sealed,resolver}.ts` | TESTED (TPM : UNTESTED — aucun /dev/tpmrm0 dans le sandbox, code réel, fail-closed) |
| 3. Handshake Noise | **Noise_XX** (défaut) et **Noise_IK** (pré-partage) sur primitives OpenSSL : X25519, ChaCha20-Poly1305, AES-256-GCM, SHA-256, BLAKE2s ; **rotation de clés 15-30 min** (PFS continu) + seuil 64 Mio | `lib/pp/noise/{suite,state,handshake}.ts`, `lib/pp/tunnel/tunnel.ts` | TESTED — **13/13 vecteurs officiels** bit à bit |
| 4. Routeur de commandes | Contrats binaires **Protobuf** (`pp.proto`), framing longueur-préfixée, RPC corrélaté par id, horodatage anti-replay (fenêtre 30 s), multiplexage des requêtes en vol | `lib/pp/protocol/{pp.proto,codec.ts}`, `lib/pp/server/gen3-handlers.ts` | TESTED |
| 5. SDK intégrable | `PPNode` — API **identique au plan** : `new PPNode({appId, targetPeer, hardwareBinding})` → `connect()` → `send(command, params)` | `lib/pp/sdk/pp-node.ts`, `packages/pp-sdk/` | TESTED |

## 3. Preuve cryptographique indépendante

`tests/unit/pp-noise-vectors.test.ts` rejoue **12 vecteurs officiels** issus des
DEUX implémentations de référence du protocole Noise (fichiers `cacophony.txt`
— Go — et `snow.txt` — Rust — du dépôt `mcginty/snow`, clonés le 2026-11-27) :

- `Noise_XX_25519_{ChaChaPoly,AESGCM}_{SHA256,BLAKE2s}` (8 vecteurs)
- `Noise_IK_25519_{ChaChaPoly,BLAKE2s}_{SHA256,BLAKE2s}` (4 vecteurs)

Chaque vecteur vérifie **bit à bit** les ciphertexts de chaque message de
handshake, la phase de transport post-`Split()` et le haché de handshake.

**Découverte documentée** : la suite AESGCM des implémentations de référence
encode le nonce en **big-endian** (quirk historique maintenu pour
l'interopérabilité, cf. `snow/src/resolvers/default.rs`), contrairement à
ChaChaPoly (little-endian, rev34 §12.2). Notre implémentation suit la
convention de chaque chiffrement — c'est ce qui rend les 12 vecteurs verts.

## 4. Cycle de connexion (plan §3 — implémenté tel quel)

1. **Enrôlement** — le client génère sa clé dans le matériel et poste ses
   clés PUBLIQUES à `/api/pp/enroll` avec un jeton d'invitation consommé à
   l'usage ; statut `en_attente` ; l'admin approuve (`POST /api/pp/registry`
   action=`approve`, derrière `requireAdmin`).
2. **Connexion** — Handshake Noise_XX ; le serveur vérifie la clé statique de
   transport contre le registre (pair inconnu → **silence**) ; le client
   vérifie la clé du serveur contre la résolution de signalisation
   (**anti-MITM**) ; défi matériel 32 octets à usage unique signé par la clé
   non-exportable (défi ‖ haché de handshake) ; ACK serveur → `ready`.
3. **Vol du code source** — nouvelle machine = nouvelle clé = refus
   silencieux. **Révocation** — `action=revoke` coupe les tunnels vivants à
   chaud (re-consultation du registre à chaque requête ; mesuré **2 ms**).

## 5. Branchement réel au cerveau Gen3 (`lib/pp/server/gen3-handlers.ts`)

- `BRAIN_CHAT` → `lib/ai/router.generate` — LE moteur neuronal Gen3, en
  processus (aucun réseau interne).
- `EXECUTE_TOOL` / `DEPLOY_WORKFLOW` → `getToolSecurityDefinition` puis
  **HITL avant tout** : `risk destructive|external` ⇒
  `confirmationRequired=true` (exécution suspendue) ; puis `authorizeTool`
  (politique réelle) puis `executeTool` (pipeline sécurisé partagé, audit).
- `PP_STATUS` → état réel du processus (aucune donnée sensible).
- Commande inconnue → erreur explicite **sans énumération des services**.

Le nœud système PP est démarré **dans le processus du serveur Gen3** via
`instrumentation.ts` (PP_SYSTEM_NODE_ENABLED=1, port PP_SYSTEM_NODE_PORT=7601
par défaut) — la connexion au serveur de Gen3 est littérale (même processus,
mêmes modules, même registre partagé `signaling-store.ts`).

## 6. Transports

- **WebSocket** (`ws`, déjà présent) — réel et testé en loopback E2E ;
  `wss://` se termine sur le proxy TLS en production.
- **QUIC** — adaptateur réel avec détection honnête : `node:quic` est absent
  du build Node 24 actuel (`ERR_UNKNOWN_BUILTIN_MODULE` vérifié) → erreur
  explicite, **jamais de tunnel simulé** ; la chaîne recommandée reste WS puis
  TURN.
- **WebRTC (navigateurs)** — pour les nœuds accélérateurs Gen3 (Plan
  directeur v2 §PHASE 11-17) : DataChannels + configuration ICE below.

## 7. Traversée NAT — Coturn (STUN/TURN)

`scripts/pp/coturn/turnserver.conf.example` fournit la configuration
production : STUN pour la découverte d'IP publique, TURN **TLS** comme relais
chiffré de secours (10-20 % des réseaux stricts). Les identifiants TURN sont
des credentials à durée limitée (`use-auth-secret`) — jamais statiques.

## 8. Limites honnêtes (statuts déclarés)

| Élément | Statut |
|---|---|
| TPM 2.0 (`lib/pp/identity/tpm2.ts`) | Code réel, **UNTESTED** dans ce sandbox (aucun /dev/tpmrm0) — `available()` répond false sans TPM : fail-closed |
| Secure Enclave / Android Keystore | Atteignables via le chemin WebCrypto non-extractable (PWA/natif) ; interfaces prévues, intégrations natives non écrites |
| QUIC | Détection réelle ; module runtime absent → WS est le transport de production aujourd'hui |
| Mise en ligne réseau externe | Le serveur PP écoute sur le port configuré au boot du serveur Gen3 — l'ouverture du port/wss externe suit le même blocage hébergement que le reste du projet (BLOCKED hors sandbox, cf. rapports production) |
| ECDSA P-256 à la signalisation serveur | La résolution REST exige Ed25519 ; les nœuds navigateur (ECDSA) passent par le canal WebRTC direct |

## 9. Mesures d'exécution (2026-11-27, sandbox)

- **Vecteurs Noise officiels : 13/13 verts** (12 vecteurs × 2 sources + garde de provenance).
- **E2E infrastructure : 13/13 verts** — cycle production (7) + attaques (5) + framing (1).
- **Démo production : 9/9 étapes OK** — connexion 26 ms, PP_STATUS réel,
  BRAIN_CHAT réel 779 ms, HITL confirmation requise, vol du code source
  refusé, révocation instantanée 2 ms — rapport : `download/pp-demo-production-2026-11-27.json`.
- **Tests de couches : 12/12 verts** (identité, registre, codec, transports).
