# genAPI — RAPPORT D'AUDIT (PHASE 1) + CONSTRUCTION PHASES 2-6, 2026-11-26

**Dépôt** : missock237-spec/gen3ia · **Preuves** : `vitest run lib/genapi/` → **88/88 verts** (7 fichiers) · `tsc --noEmit` → 0 erreur · `eslint lib/genapi/ app/api/v2/` → 0 erreur.

## PHASE 1 — Audit du système existant (examen complet de lib/genapi)

| Item mission | Constat RÉEL | Statut |
|---|---|---|
| 1. Fichiers lib/genapi | 11 modules + gen3.proto + LISEZMOI (examinés un par un) | ✅ |
| 2. Serveur gRPC | `serveur.ts` : `@grpc/grpc-js@1.14.5` réel, **mTLS** (`ServerCredentials.createSsl` avec `checkClientCertificate = true` — rejet TLS sans certificat client signé CA), contrat `gen3.v1.Gen3` (4 RPC : Sante, ExecuterInference, StatutExecution, …), metadata `x-gen3-empreinte` | ✅ opérationnel + tests |
| 3. Master Daemon | `daemon.ts` (Options/Rapport DaemonGenAPI, `demanderArretGenAPI()` — arrêt propre) | ✅ opérationnel + tests |
| 4. Provisionnement | `provisionnement.ts` : Firestore `genapiClients` / `genapiPackages` / `genapiJournal` ; paquet [key+crt+proto+LISEZMOI] base64 **TTL 15 min usage unique** ; **AUTODESTRUCTION vérifiée** de client.key/csr (`existsSync === false`) | ✅ opérationnel + tests |
| 5. Certificats | `openssl.ts` : OpenSSL en terminal intégré (`execFile`, jamais de shell), CA racine gen3, empreinte SHA-256 du certificat (Firestore, JAMAIS la clé privée) | ✅ opérationnel + tests |
| 6. Communications | gRPC mTLS (interne) + **REST publique v2 ajoutée cette session** (app/api/v2) ; empreinte du certificat vérifiée par le serveur | ✅ |
| 7. Composants incomplets/simulés | voir §Limitations : video/automation/embeddings/training **indisponibles déclarés**, agents non exposés en API, applications/jobs en mémoire process, ASR/TTS bornés | documenté |
| 8. Tests | 66 tests existants (clients, compteur, openssl, paquet, provisionnement, serveur) verts ; +22 nouveaux (gateway/adaptateurs/jobs/facturation) | ✅ 88/88 |

## PHASES 2-6 — Construit cette session (réutilise l'existant, ne remplace rien)

- **PHASE 2 Gateway** : `lib/genapi/gateway.ts` — chaîne ordonnée permissions → validation zod → quota par application → timeout → journal borné → erreurs normalisées `{error:{code,message,requestId}}` ; versionnage `/v1`,`/v2` ; **porte v1 conservée** (auth `g3a_` + rate existant jamais réécrits).
- **PHASE 3 Permissions** : `services.ts` — 10 services, applications associées à UN propriétaire, permissions par service (refus AVANT exécution, handler jamais appelé), **révocation immédiate** (403 après revoquer), environnements test/production séparés (clé test refusée en prod), restrictions (appels/min + budget journalier).
- **PHASE 4 Adaptateurs** : `adaptateurs.ts` — chat/reasoning/research → **moteur neuronal Gen3 réel** (`router.generate`, le seul moteur du projet — aucune logique concurrente) ; vision → moteur vision LIVE réel (scène+temporalité+OCR branchable) ; audio → mesures WAV réelles (transcription déclarée absente) ; video/agents/automation/embeddings/training → **indisponibles avec raison explicite** (jamais simulés).
- **PHASE 5 Jobs** : `jobs.ts` + routes `POST/GET /api/v2/jobs`, `GET /api/v2/jobs/:id`, `POST /api/v2/jobs/:id/cancel` — référence immédiate `gen3_job_*`, 5 états, annulation propriétaire, **reprise après crash** (processing→queued, appelée à chaque requête), webhooks **signés réels** via `emitOutgoingEvent` existant (union `execution.*` conservée).
- **PHASE 6 Facturation** : `facturation.ts` sur la facturation portefeuille réelle existante (`api-usage`, tarifs 1 €/1M in + 1,50 €/1M out) — comptabilisation par application, **IDEMPOTENCE** par clé (`Idempotency-Key` → « déjà-facturée, aucun double débit »), **budget journalier refusé AVANT débit**, historique et cumul réels.

Routes REST publiques v2 réelles créées : `app/api/v2/chat/route.ts` (POST chat via Core + GET catalogue), `app/api/v2/jobs/*`. Auth Firebase + porte v1 + header `x-gen3ia-app-id` + propriété vérifiée à chaque appel.

## Limitations restantes (honnêteté — règle 5/12)

1. **Applications et jobs en mémoire process** : la persistance Firestore (`genapiApplications`) est prévue au PHASE 7 (portail) — déclarée non validée tant qu'elle n'existe pas.
2. **Services indisponibles** (déclarés, jamais simulés) : video, automation, embeddings, training ; agents non encore exposés en API publique (canal Live HITL existant non connecté à la gateway).
3. **Persistance Firestore réelle des adaptateurs/routes** non exécutable en sandbox (émulateurs absents) — le code est branché aux vraies dépendances mais non validé e2e.
4. **PHASE 7-10** (portail, OpenAPI/SDK, tests charge/sécurité réels, déploiement VPS mTLS) : à faire — aucun simulacre ne sera créé.
5. **Rotation des secrets** : la génération de nouvelles clés existe (`generateDeveloperApiKey`) ; la rotation automatisée avec double-validité reste à écrire (PHASE 7).
