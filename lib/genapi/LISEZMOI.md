# genAPI — Système d'exploitation autonome gen3

genAPI est le **système d'exploitation autonome de gen3** : un Master Daemon
hébergé sur le **VPS souverain AlmaLinux** (PAS sur Vercel) qui gère la
cryptographie des clients SaaS via un **terminal intégré** (`node:child_process`
→ `execFile`, jamais de shell), expose un **serveur gRPC mTLS** et facture les
exécutions en crédits Chariow (wallet).

```
Nouveau client SaaS (facturation Chariow)
        │
        ▼
provisionnement ── OpenSSL (terminal intégré) ──► clé privée client + certificat signé CA racine gen3
        │
        ├─► empreinte SHA-256 du certificat ──► Firestore genapiClients/{uid}   (JAMAIS la clé privée)
        ├─► paquet [client.key + client.crt + gen3.proto + LISEZMOI] ──► genapiPackages (base64, TTL 15 min, usage unique)
        └─► AUTODESTRUCTION : client.key + client.csr supprimés du serveur, rm VÉRIFIÉ (existsSync === false)
```

## 1. Architecture des fichiers

| Fichier | Rôle |
|---|---|
| `lib/genapi/types.ts` | Contrat partagé avec les routes admin (sous-agent 2-b) — à respecter à la lettre. |
| `lib/genapi/proto/gen3.proto` | Le contrat gRPC livré aux développeurs SaaS (package `gen3.v1`). |
| `lib/genapi/openssl.ts` | LE TERMINAL INTÉGRÉ : OpenSSL via `execFile` (anti-injection, timeout 20 s, `windowsHide`). |
| `lib/genapi/paquet.ts` | Paquet gzip déterministe (tar maison) + jeton d'usage unique (hash SHA-256). |
| `lib/genapi/provisionnement.ts` | Pipeline maître : génération → allowlist → paquet → jeton → **zéro fuite**. |
| `lib/genapi/clients.ts` | Registre clients + allowlist d'empreintes (cache 60 s) + statut admin. |
| `lib/genapi/compteur.ts` | Compteurs du jour (`genapiStats/{dateIso}`) : executions, echecs, crédits. |
| `lib/genapi/serveur.ts` | Serveur gRPC mTLS (`@grpc/grpc-js`) : Sante / ExecuterInference / StatutExecution. |
| `lib/genapi/daemon.ts` | Master daemon : boucle de provisionnement + montage du serveur gRPC. |
| `scripts/genapi-daemon.mts` | Point d'entrée PM2 (miroir de `scripts/video-worker.mts`). |
| `ecosystem.config.cjs` | Configuration PM2 (fork unique, garde mémoire 1G). |

## 2. Infrastructure AlmaLinux — CA racine gen3

La CA racine vit sur le VPS, HORS du dépôt, permissions serrées :

```bash
sudo mkdir -p /etc/gen3ia/genapi && cd /etc/gen3ia/genapi

# 1. CA racine gen3 (ECC prime256v1, 10 ans)
sudo openssl ecparam -name prime256v1 -genkey -noout -out ca.key
sudo openssl req -new -x509 -key ca.key -sha256 -days 3650 \
  -subj "/CN=gen3-root-ca/O=Gen3ia/OU=genAPI" -out ca.crt

# 2. Certificat serveur du daemon (signé par la CA racine — SAN requis pour gRPC)
sudo openssl ecparam -name prime256v1 -genkey -noout -out serveur.key
sudo openssl req -new -key serveur.key -subj "/CN=vps.gen3ia/O=Gen3ia/OU=genAPI" -out serveur.csr
sudo openssl x509 -req -in serveur.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 365 -sha256 -extfile <(printf "subjectAltName=DNS:vps.gen3ia,IP:VPS_IP") -out serveur.crt

# 3. Permissions (la clé de la CA ne sort JAMAIS de ce répertoire)
sudo chmod 600 ca.key serveur.key && sudo chmod 644 ca.crt serveur.crt
```

Variables d'environnement du daemon (fichier `.env.genapi`, chargé par le script) :

| Variable | Défaut | Rôle |
|---|---|---|
| `GENAPI_CA_KEY_PATH` | `/etc/gen3ia/genapi/ca.key` | Clé privée de la CA racine. |
| `GENAPI_CA_CERT_PATH` | `/etc/gen3ia/genapi/ca.crt` | Certificat de la CA racine. |
| `GENAPI_SERVER_KEY_PATH` | `/etc/gen3ia/genapi/serveur.key` | Clé TLS du serveur gRPC. |
| `GENAPI_SERVER_CERT_PATH` | `/etc/gen3ia/genapi/serveur.crt` | Certificat TLS du serveur gRPC. |
| `GENAPI_GRPC_PORT` | `9443` | Port d'écoute mTLS. |
| `GENAPI_EXECUTION_CREDITS_MINOR` | `15` | Tarif standard d'exécution (unités mineures). |
| `GENAPI_PROTO_PATH` | `lib/genapi/proto/gen3.proto` | Contrat embarqué dans les paquets. |
| `GENAPI_INFERENCE_MODULE` | `@/lib/neural/engine` | Moteur neuronal local appelé par ExecuterInference. |
| `GENAPI_SANDBOX_MODE` | `process` | Confinement des exécutions : `gvisor` \| `firecracker` \| `process`. |

## 3. PM2 — master daemon

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save            # relance après redémarrage du VPS
pm2 logs gen3-daemon
```

Le mode est `fork` (1 instance) : le daemon est stateful (serveur gRPC sur un
port unique, terminal intégré) — le cluster est interdit. `NODE_OPTIONS=--conditions=react-server`
neutralise le garde `server-only` hors Next (convention `video-worker.mts`).

Sondes sans daemon : `NODE_OPTIONS=--conditions=react-server npx tsx scripts/genapi-daemon.mts --once`.

## 4. Flux client SaaS (détaillé)

1. **Facturation Chariow** → une demande de provisionnement atterrit dans
   `genapiDemandes` (`{ uid, email, statut: "nouveau" }`).
2. **Le daemon** (ou la route admin, même pipeline) appelle
   `provisionnerClient({ uid, email })` :
   - OpenSSL génère `client.key` (ECC prime256v1, chmod 600) dans un tmpdir
     éphémère `genapi-prov-*` ;
   - la CA racine signe `client.crt` (365 jours, SHA-256) ;
   - l'empreinte SHA-256 du certificat (hex, sans deux-points) est écrite dans
     `genapiClients/{uid}` — **l'empreinte est la SEULE donnée cryptographique
     stockée** ; ré-émettre un client remplace son empreinte (révocation
     implicite de l'ancienne) ;
   - le paquet (`gen3.proto` + `client.key` + `client.crt` + `LISEZMOI.md`)
     est stocké **base64** dans `genapiPackages/{hashJeton}`, référence par un
     **jeton d'usage unique** (32 octets CSPRNG base64url) — le jeton CLAIR
     n'est JAMAIS stocké, seul son SHA-256 sert d'identifiant, TTL **15 min** ;
   - **AUTODESTRUCTION** : `client.key` et `client.csr` sont supprimés puis la
     suppression est **vérifiée** (`existsSync === false`) — si la vérification
     échoue : journal `autodestruction_ko`, `ok:false`, jeton NON émis ;
   - le tmpdir est détruit en `finally` : **aucune clé privée ne reste jamais
     sur disque**. Si le serveur est compromis, les clés privées des clients
     n'y existent physiquement plus (**zéro fuite**).
3. **Téléchargement** : `GET /api/admin/genapi/paquets/{jeton}` (route du
   sous-agent 2-b) → `consommerJetonPaquet` — usage unique ATOMIQUE
   (transaction) : le 2ᵉ appel est refusé et le champ `paquetBase64` est
   écrasé par `""` après livraison (minimisation, doc conservé pour l'audit).

## 5. Serveur gRPC mTLS — modèle de sécurité

**Barrière réseau** : `ServerCredentials.createSsl(..., true)` — le 3ᵉ
argument (`checkClientCertificate`) rend le certificat client OBLIGATOIRE au
niveau TLS : sans certificat signé par la CA gen3, la connexion est rejetée
avant tout appel. `createInsecure` est interdit dans ce socle.

**Lien compte — compromis honnête et documenté** : `@grpc/grpc-js` n'expose
pas le certificat pair par appel. Le handler `ExecuterInference` vérifie donc
la metadata **`x-gen3-empreinte`** (empreinte SHA-256 du certificat, hex sans
deux-points) contre l'allowlist Firestore (`empreinteAutorisee`, statut
`actif`, cache 60 s). Le mTLS garantit un client signé par la CA gen3 ;
l'allowlist lie l'empreinte au compte et refuse tout certificat inconnu ou
révoqué. Erreurs gRPC : `UNAUTHENTICATED` (empreinte absente/refusée),
`INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED` (provision insuffisant), `INTERNAL`.

**Facturation Chariow à l'exécution** (wallet, unités mineures) :
1. `reserveFunds` AVANT l'exécution (`budget_credits_minor` ou tarif standard
   `GENAPI_EXECUTION_CREDITS_MINOR`, référence idempotente `genapi-{clé}`) ;
2. succès → `settleReservation` (coût réel réglé) + `compterExecutionGenAPI`
   + journal `execution_rpc` ;
3. échec moteur → `releaseReservation` (0 crédit débité) + compteur `echecs`
   + journal `execution_echec` — **jamais de fausse réussite** : si le moteur
   d'inférence local n'est pas disponible sur l'hôte, la réponse porte
   `succes:false` avec le message d'indisponibilité explicite.

`StatutExecution` lit `genapiExecutions/{id}` (état, progression, sortie
partielle) écrit au fil de l'eau par `ExecuterInference`.

## 6. Durcissement VPS (étape suivante)

Les exécutions d'inférence v1 tournent en `process` (mode honnête, défaut).
Le durcissement visé est documenté par `GENAPI_SANDBOX_MODE` :
`gvisor` (runsc — interception syscall), `firecracker` (microVM jetable),
`process` (défaut). Le socle n'exécute AUCUN code client : le mode sandbox
couvre les futures charges arbitraires (agents) — à activer après audit VPS.

## 7. Journal d'audit (`genapiJournal`)

Événements émis par le socle : `provisionnement_ok`, `provisionnement_ko`,
`cle_privee_detruite`, `autodestruction_ko`, `paquet_telecharge`,
`paquet_refuse`, `client_revoque`, `execution_rpc`, `execution_echec`,
`execution_refusee`, `sante_rpc`, `serveur_demarre`, `serveur_arrete`,
`daemon_cycle_ko`. Écriture **best-effort** (jamais bloquante), détail
construit **sans aucune matière secrète** (jamais de contenu de clé, jamais
de jeton clair — au plus un préfixe de hash).

## 8. Tests

```bash
npx vitest run lib/genapi --reporter=dot
```

- `openssl.test.ts`, `paquet.test.ts`, `compteur.test.ts` : fonctions pures
  (validations anti-injection, paquet aller-retour, jetons, clé de date UTC) ;
- `provisionnement.test.ts` : pipeline complet avec OpenSSL simulé mais
  fichiers RÉELS — la destruction de la clé privée est prouvée par le disque ;
- `serveur.test.ts` : chargement du VRAI contrat `gen3.proto` ;
- `clients.test.ts` : allowlist + cache (2 appels → 1 requête) + statut.
