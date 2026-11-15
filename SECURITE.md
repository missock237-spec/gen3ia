# SECURITE.md — Forteresse Gen3ia

Politique de défense en profondeur et de **confidentialité absolue** des
données des utilisateurs. Objectif affiché : même un attaquant automatisé
(une IA) ne doit pouvoir ni compromettre la plateforme, ni lire, ni
falsifier les données des utilisateurs.

## 1. Modèle de menace

Trois familles d'adversaires sont considérées :

1. **L'attaquant automatisé (IA)** — agents capables d'inonder les
   endpoints, de rejouer des requêtes, de forger des payloads, de tenter
   des injections de prompts ou de payloads, et de déguiser leur trafic.
2. **L'insider du stockage** — tout accès brut (volontaire ou non) au
   stockage objet (R2) ou aux sauvegardes.
3. **Le pair malveillant du réseau P2P** — un navigateur qui tente de
   rejoindre un essaim privé qui ne lui appartient pas, ou de corrompre
   un modèle stocké.

## 2. Défenses en profondeur (par couches)

| Couche | Mécanisme | Emplacement |
|---|---|---|
| Transport / origine | Vérification d'origine (Origin/Referer), blocage d'en-têtes suspects, taille de corps plafonnée | `lib/security/request-security.ts` |
| Authentification | Firebase ID token (RS256) + cookie de session signé HMAC ; quota global 100 req/min/utilisateur | `lib/security/authenticated-request.ts`, `lib/server/session-cookie.ts` |
| Limitation de débit | Locale (fenêtre glissante) + Redis partagé ; limites MÉTIER par route (arène 3/h, tickets mesh 10/h, chat, orgs…) | `lib/security/rate-limit.ts` + routes |
| En-têtes | CSP stricte sans `unsafe-eval`, HSTS preload, `X-Frame-Options DENY`, `Referrer-Policy`, `Permissions-Policy` | `middleware.ts`, `next.config.ts` |
| Données au repos | **Chiffrement AES-256-GCM par utilisateur + scellement HMAC** des artefacts de modèles (états d'arène, modèles améliorés) | `lib/security/forteresse.ts` |
| Intégrité des journaux | **Journal d'audit chaîné HMAC** : toute suppression/modification/réordonnancement est détectée | `lib/security/journal-chaine.ts`, `lib/training/audit.ts` |
| Confidentialité des journaux | **Aucune IP brute persistée** — empreinte salée tournante (rotation quotidienne) | `lib/security/forteresse.ts` (`empreinteIp`) |
| Sanitisation | Détails d'audit plafonnés (~2 Ko), jamais de contenu ni de secret | `lib/training/audit.ts` |
| Essaim privé | Tickets d'admission signés (HMAC, TTL 10 min), registre **isolé** des salles publiques, refus 403 sans ticket valide | `lib/ondes/mesh-prive.ts`, `app/api/ondes/signaling/route.ts` |
| Timebox d'entraînement | Deadline physique dans la boucle (1 h max/modèle/session) + verrou anti-concurrence TTL + limite 3/h | `lib/training/timebox.ts`, `lib/training/verrou.ts` |

## 3. Pourquoi « même une IA ne peut pas hacker »

Une automatisation attaque par volume et par variations rapides. Chaque
levier est fermé indépendamment :

- **Volume** : quotas globaux (100/min/uid) + limites métier (arène 3/h,
  tickets mesh 10/h) + files bornées côté registre (LRU, TTL 45 s) →
  aucun déni de service applicatif rentable.
- **Rejeu / falsification** : tickets mesh TTL 10 min liés à la salle
  exacte ; scellés HMAC sur les artefacts (tout octet modifié casse le
  sceau) ; journal chaîné (une suppression décale toute la chaîne).
- **Injection de payloads** : validation Zod systématique des entrées ;
  `sanitizeDetails` plafonne ce qui entre dans l'audit ; CSP sans
  `unsafe-eval` empêche l'exécution de scripts injectés.
- **Exfiltration de modèles** : les artefacts sont chiffrés par
  utilisateur (clé HKDF dérivée de la clé maîtresse SERVEUR + uid) — un
  vol de stockage brut ne donne que des blobs illisibles, et l'artefact
  d'un compte ne s'ouvre pas sous un autre compte.
- **Corruption de modèles** (attaque d'un pair sur le stockage) : le
  sceau HMAC est recalculé au chargement ; un modèle falsifié est
  REFUSÉ, jamais exécuté (`deployerForteresse`).

## 4. Confidentialité absolue — ce qui est garanti

1. **Les modèles des utilisateurs sont chiffrés au repos** (AES-256-GCM,
   clé dérivée par utilisateur, IV aléatoire par écriture, tag GCM
   vérifié à la lecture).
2. **Le mesh privé ne fait sortir aucune donnée du parc** : le serveur
   ne relaie QUE les enveloppes d'établissement WebRTC (volatiles,
   purgées en 45 s) ; l'inférence et les paquets d'ondes circulent en
   direct entre les postes ; les salles privées vivent dans un registre
   distinct du public.
3. **Les journaux ne contiennent ni contenu, ni IP brute, ni secret** :
   empreintes tournantes, compteurs et identifiants uniquement.
4. **Aucune IA externe** : tout le moteur est interne (SNN Gen3, ondes
   W-DNN) — aucun contenu utilisateur ne transite vers un fournisseur
   tiers d'IA.

## 5. Gestion des clés

| Variable | Rôle | Recommandation |
|---|---|---|
| `SESSION_SECRET` | Cookies de session, repli forteresse/mesh | `openssl rand -hex 32`, dédié |
| `MESH_SIGNING_KEY` | Tickets d'admission mesh privé | dédié, rotation sans effet sur les sessions |
| `MODELS_SEALING_KEY` | Chiffrement/scellement artefacts + chaînage journal | dédié, **rotation = re-scellement nécessaire** (prévoir double lecture lors de la rotation) |

Sans variable dédiée, la clé est dérivée des variables d'environnement
stables (aucun secret en dur dans le code, jamais — vérifié par gitleaks).

## 6. Périmètre et feuille de route

Déjà couvert par ce niveau : sessions d'arène, états « élève amélioré »,
journal d'audit du Training Studio, signalisation d'essaim, routes
d'entraînement. Prochaines étapes planifiées : extension du chiffrement
au repos à TOUS les artefacts de modèles du Studio (format
`gen3-language-model` complet, avec déchiffrement à la volée dans les
routes d'export), et scellement des artefacts produits par gen3-local à
la source.
