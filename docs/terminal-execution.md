# Terminal intégré — exécution réelle (Task 122)

Le terminal intégré (agents IA **et** utilisateurs, Workshop IDE) exécute
désormais des commandes **RÉELLES** — plus de simulation par défaut.

## Chaîne de décision (honnête, annoncée dans chaque résultat)

```
Docker (SANDBOX_URL + SANDBOX_SHARED_SECRET configurés)
  └─ incident service → serverless (exécution réelle en-processus, cause annoncée)
Serverless (DÉFAUT sans Docker) — exécution réelle en-processus
  └─ runtime local absent (ex. python3 manquant) → simulation annoncée
```

Le mode employé (`sandbox` | `serverless` | `simulation`) est TOUJOURS renvoyé
au client et affiché (« Sandbox Docker (exécution réelle) » / « Exécution
réelle (serverless) » / « Simulation »).

## Mode « serverless » (exécution réelle en-processus) — garde-fous

Un Vercel Node function tourne dans une microVM éphémère et isolée : le code
exécuté est un subprocess `child_process.spawn` soumis à :

| Garde-fou | Implémentation |
|---|---|
| **Env nettoyé** | AUCUNE variable héritée de `process.env` — env minimal construit à la main : `PATH` standard, `HOME=/tmp`, `LANG`, `TMPDIR=/tmp`. Les secrets de la plateforme sont invisibles du code exécuté. |
| **cwd /tmp** | Workspace déterministe `/tmp/gen3ia-ws-<hash(userId)>` (mécanisme `lib/execution/workspace`). Jamais le répertoire du bundle. |
| **ulimit mémoire** | `bash --noprofile -lc 'ulimit -v …; cmd'`. Plancher 4 Go pour le shell (V8 réserve ~4 Go d'adressage virtuel — un plafond plus bas tuerait `node script.js`) ; python garde l'ulimit strict ; node est plafonné par `--max-old-space-size`. |
| **Timeout dur** | Spawn en groupe de processus distinct, kill du TREE entier (`kill -pgid SIGKILL`) à l'échéance. |
| **Sortie plafonnée** | Au-delà de `maxOutputBytes`, le processus est tué et la sortie tronquée (marqueur honnête). |
| **Deny-list durcie** | `lib/sandbox/policy.ts`, partagée par toutes les surfaces (réévaluée avant TOUT spawn) : sudo, `rm -rf /`, fork bomb, docker/mount, `chmod 777`, nc/socat, `/proc`, `/sys`, `/var/task` (bundle), `.env*`, historiques shell, `unset`/`eval` d'env, métadonnées cloud `169.254.169.254`, ssh/scp, `curl|sh`, `base64 -d|sh`, écriture hors `/tmp` (redirections, `tee`, `dd of=`, `install -t`). |

## Limites assumées du mode serverless

- **Éphémère par instance** : le workspace `/tmp` est réutilisé tant que la VM
  est « chaude » ; après un démarrage à froid, il est RECRÉÉ VIDE. Aucun état
  n'est garanti entre deux commandes froides — les fichiers ne survivent pas
  nécessairement d'une commande à l'autre.
- **Isolation = microVM Vercel** (un seul locataire par VM), pas un conteneur
  Docker dédié ; la mémoire RSS est bornée par la plateforme, l'ulimit `-v`
  borne l'adressage virtuel.
- **Runtime python** : si `python3` est absent de l'image Node, les jobs
  python retombent en simulation annoncée (node et bash sont toujours réels).
- Pas de réseau sortant pour les agents (network: "none" dans le contrat).

## Déployer le service `services/sandbox/` (Docker) — sessions persistantes

Pour une isolation conteneur complète (réseau `none`, read-only, limites
pids/mémoire/CPU) et des sessions qui ne dépendent pas du cycle de vie des
instances Vercel :

```bash
cd sandbox
npm install && npm run build

# Images d'exécution (utilisées par le runner avec ces noms EXACTS)
docker build -t gen3ia-sandbox-node docker/node
docker build -t gen3ia-sandbox-python docker/python

# Service HTTP (port 8080 par défaut) — secret HMAC partagé 32+ caractères
SANDBOX_SHARED_SECRET=$(openssl rand -hex 32) npm start
```

Puis renseigner côté app : `SANDBOX_URL=<url publique du service>` et le même
`SANDBOX_SHARED_SECRET`. La chaîne de décision bascule automatiquement sur le
mode `sandbox` (Docker), avec retombée serverless puis simulation en cas
d'incident — chaque résultat continue d'annoncer son mode réel.

## Outil agent `terminal.run`

L'agent IA dispose de l'outil **`terminal.run`** (catégorie `code`, risque
`medium`) : il exécute une commande via la même chaîne sécurisée et renvoie
stdout/stderr/exitCode **et le mode réel**. Journalisation en session terminal
(audit + flux temps réel du Workshop IDE, fail-soft).

**Politique d'approbation** : `terminal.run` est un outil **interne**
(`INTERNAL_ACTION_TOOLS`, directive 10-10) — il opère uniquement sur
l'infrastructure Gen3ia (env nettoyé : aucun secret utilisateur manipulé,
aucune app externe) et sa deny-list rejette les commandes dangereuses AVANT
exécution → **aucune carte de validation** (comme `files`), facturation et
audit restant appliqués. L'ancien `terminal.execute` (flux « commande
autorisée » à validation explicite) est conservé inchangé.
