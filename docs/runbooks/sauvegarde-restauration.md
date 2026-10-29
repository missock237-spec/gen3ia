# Runbook — Sauvegarde & restauration des données Firestore

> Source de vérité : `lib/db/backup-policy.ts` (politique codifiée, gardée par
> `tests/unit/backup-policy.test.ts`). Opérateurs : `scripts/backup_firestore_data.mjs`
> (status/export/enable-pitr) et `scripts/verify_backup_restore.mjs` (vérification
> PASS/FAIL, conçue pour un cron mensuel).

## 1. Objectifs de reprise

| Indicateur | Valeur | Signification |
|---|---|---|
| **RPO** | 24 h | Perte de données maximale acceptable en cas d'incident |
| **RTO** | 2 h | Durée maximale entre la décision de restauration et le service restauré |
| Rétention exports GCS | 30 j | Une préfixe `firestore-exports/<horodatage>/` par export |
| PITR | 7 j | Récupération point-in-time à la seconde (base entière) |
| Exécution | 03:00 (heure serveur) | Fenêtre de trafic minimal (cf. docs/sre/sli-slo.md) |

La couverture repose sur **trois couches complémentaires** : PITR (erreur humaine
des 7 derniers jours, restauration à la seconde), exports GCS quotidiens
(conservation 30 jours, indépendants de la base), backups planifiés
Google-managed (dernier recours si le bucket GCS est compromis).

## 2. Collections critiques (périmètre de restauration obligatoire)

users, tasks, agents, memories, conversations, messages, teams, extensions,
installations, executions — toute procédure de restauration qui ignore l'une de
ces collections est incomplète et refuse le verrou final du runbook.

## 3. Mise en œuvre initiale (une fois)

1. Créer un bucket GCS dédié, versionné, non public :
   `gcloud storage buckets create gs://gen3ia-backups --location=europe-west1 --uniform-bucket-level-access`
2. Placer la clé de service `.fb_deploy_key.json` à la racine du projet
   (même convention que `backup_firebase_rules.mjs`) — jamais commitée, jamais
   en CI tant que le secret dédié n'existe pas.
3. Activer PITR : `node scripts/backup_firestore_data.mjs --enable-pitr`
4. Planifier l'export quotidien (crontab VPS, utilisateur applicatif) :
   `0 3 * * * cd /srv/gen3ia && GCS_BACKUP_BUCKET=gs://gen3ia-backups node scripts/backup_firestore_data.mjs --export >> /var/log/gen3ia-backup.log 2>&1`
5. Planifier la vérification mensuelle (cron VPS, alerte par exit code) :
   `0 4 1 * * cd /srv/gen3ia && node scripts/verify_backup_restore.mjs --strict`
6. Créer le schedule Google-managed hebdomadaire (console Firebase → Firestore →
   Backup schedules, rétention 30 jours) — filet dernier niveau.

## 4. Procédures de restauration

### 4.1 Erreur de données récente (< 7 jours) — PITR

Récupération de la base entière à un instant T (écrase l'état actuel : décision
P1, double validation owner + opérateur, fenêtre annoncée aux utilisateurs) :

```bash
gcloud firestore databases restore \
  --source-backup=<BACKUP> --destination-database=gen3ia-restored
# PITR : clone à l'instant T puis bascule
gcloud firestore databases clone \
  --source-database='projects/<p>/databases/gen3ia' \
  --destination-database=gen3ia-restored \
  --point-in-time='2026-10-29T08:15:00Z'
```

Basculer l'application vers la base restaurée via `FIRESTORE_DATABASE_ID`
(`DOTENV_PRODUCTION`), puis re-sonder : `/api/health`, `/chat` (conversation de
référence), `/dashboard` (missions).

### 4.2 Perte partielle (collection) — export GCS

1. Identifier la préfixe de l'export le plus récent SAIN :
   `gcloud storage ls gs://gen3ia-backups/firestore-exports/`
2. Importer dans une base d'écart `gen3ia-import` (JAMAIS directement en prod) :
   `gcloud firestore import gs://gen3ia-backups/firestore-exports/<stamp> --database=gen3ia-import`
3. Extraire la collection saine et la re-fusionner en prod **document par
   document** (script ad hoc relu à deux) — jamais d'import direct écrasant.
4. Vérifier le périmètre complet (§2) avant réouverture : chaque collection
   critique comparée en comptage avant/après.

### 4.3 Après restauration — verrou final

- `node scripts/verify_backup_restore.mjs --strict` → 4/4 PASS
- Sonde de régression : `node scripts/sonde_regression_prod.mjs` → 10/10
- Postmortem (docs/sre/postmortem-modele.md) sous 48 h si perte effective.

## 5. Vérification continue

| Fréquence | Contrôle | Outil |
|---|---|---|
| Quotidienne (03:00) | Export GCS lancé | cron + log `/var/log/gen3ia-backup.log` |
| Mensuelle (1er, 04:00) | 4 contrôles PASS/FAIL (PITR, schedule, fraîcheur RPO, runbook complet) | `verify_backup_restore.mjs --strict` |
| Trimestrielle | Exercice de restauration complet sur base d'écart | runbook §4.2 (base `gen3ia-import`) |

Règle d'or : **un backup qui n'a jamais été restauré est une hypothèse, pas
une capacité de reprise.** L'exercice trimestriel est obligatoire pour
qualifier le RTO de 2 h.
