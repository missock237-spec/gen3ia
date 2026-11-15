# Triage des alertes CodeQL (Task 104)

Historique et justifications des qualifications. Les alertes réellement
corrigées le sont dans les commits du dépôt (pas de fermeture sans examen) ;
les faux positifs sont écartés dans l'interface Code Scanning avec un
commentaire court renvoyant aux sections ci-dessous (limite API : 280
caractères), qui portent la preuve complète.

## §scripts-ops — `js/file-access-to-http` sur `scripts/*.mjs` (#57 à #67, 10 alertes)

Faux positifs qualifiés le 2026-10-08. Motif commun à tous ces scripts :
lire un credential appartenant à l'opérateur puis l'utiliser comme
authentification Bearer auprès de son émetteur légitime.

- `scripts/setup_qstash_schedule.mjs` lit `QSTASH_TOKEN` / `CRON_SECRET`
  (env ou `.env.local`) et appelle `qstash.upstash.io` — l'API officielle
  qui a émis ce token. Le flux « fichier/env → requête sortante » EST la
  procédure d'authentification prévue ; il n'existe aucun scénario où un
  tiers pourrait substituer une destination : la constante
  `QSTASH_BASE` est en dur dans le script.
- `scripts/backup_firebase_rules.mjs`, `verify_firebase_rules.mjs`,
  `inspect_firebase_rules.mjs`, `deploy_firebase_prod.mjs`,
  `probe_firebase_indexes.mjs` échangent la clé du compte de service
  Firebase (fichier fourni par l'opérateur) contre un jeton d'accès auprès
  de l'endpoint de token Google IAM, puis appellent l'API de gestion
  Firestore de Google. Encore une fois : le détenteur légitime du secret
  est l'expéditeur — le modèle d'exfiltration de la requête CodeQL ne peut
  pas se matérialiser.
- Aucune entrée utilisateur ne participe à ces flux (paramètres validés par
  constantes du script), et `scripts/**` n'est PAS empaqueté dans le
  déploiement Next.js : le traçage de sortie (`outputFileTracing`) ne suit
  que les imports depuis `app/` et `lib/`. Ces scripts ne s'exécutent qu'à
  la main par un opérateur authentifié sur sa machine.

## §create-zip — `js/insecure-temporary-file` sur `lib/tools/files/create-zip.ts:75` (#56)

Faux positif qualifié le 2026-10-08, quatre preuves visibles dans le code :

1. **Lecture en `O_RDONLY | O_NOFOLLOW`** : un lien symbolique planté au
   chemin fait échouer l'ouverture avec `ELOOP` au lieu d'être suivi.
2. **`fstat` sur le descripteur ouvert** : le type et la taille sont lus
   sur l'inode réellement ouvert — les données proviennent exactement de
   l'inode vérifié, jamais d'un chemin re-résolu. La fenêtre TOCTOU
   (fichier substitué par un lien symbolique entre `lstat` et `readFile`)
   est fermée par construction.
3. **Rejet amont des liens symboliques** : `readdir(withFileTypes)` identifie
   les entrées non régulières et lève avant toute ouverture (double
   barrière avec le point 1).
4. **Répertoire workspace créé `0700`** par l'application : un processus
   tiers local ne peut ni y déposer un lien symbolique ni remplacer un
   fichier. Le chemin n'est en outre jamais écrit — lecture seule.

## Alertes corrigées dans le code (Task 104, commit 26c9319)

| Alerte | Correctif |
| --- | --- |
| #54 `js/request-forgery` (critique) `lib/queue/tick-queue.ts` (ex-qstash.ts) | Origine canonique serveur uniquement (`GEN3IA_APP_ORIGIN` + allowlist `lib/queue/origin.ts`), aucun repli sur l'origine requête, `assertSafeDestinationUrl` en défense en profondeur. |
| #53 `js/polynomial-redos` (haute) `sdk/src/client.ts` | Regex `/\/+$/` remplacée par un trimage linéaire `endsWith/slice` ; test anti-backtracking (chaîne pathologique < 100 ms). |
| #55 (haute) `lib/documents/file-engine.ts` | Écriture `rm` puis création exclusive `wx` mode `0600` dans un répertoire workspace `0700`. |
| #69/#70 (haute/moyenne) `lib/video/security.ts` | Binaire FFmpeg runtime épinglé (`b6.0`) + SHA256 officiels vérifiés AVANT toute écriture (fail-closed), écriture en création exclusive `0700` puis renommage atomique. |
| #68 (moyenne) `lib/video/asset-service.ts` | Sonde ffprobe : écriture exclusive `wx` mode `0600` dans `mkdtemp` `0700`. |

Si les alertes #68/#69/#70 persistent après la nouvelle analyse (le suivi
de teinte CodeQL ne reconnaît pas la vérification cryptographique comme
barrière), la justification est : données réseau = binaire statique dont
l'empreinte SHA256 est épinglée en code et vérifiée avant écriture ;
destination constante du serveur ; répertoire `0700` — le flux restant est
la fonctionnalité voulue (provisionnement du binaire de rendu vidéo).
