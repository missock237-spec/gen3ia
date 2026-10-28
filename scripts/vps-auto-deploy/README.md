# Mise à jour automatique Gen3ia (VPS AlmaLinux)

Système de déploiement continu : chaque push sur `main` est détecté et
déployé sur le VPS **sans interruption de service ni perte d'état**.

## Fonctionnement

```
GitHub (main) ──▶ poller (toutes les 2 min, PM2 « updater ») ──▶ deploy.sh
                                                                    │
                              .─────────────────────────────────────┴──────────┐
                              │                                                 │
                    1. git fetch (rien de neuf → silence)                      │
                    2. worktree STAGING ← reset --hard origin/main              │
                       (.env.production de la prod : symlink, jamais touché)    │
                    3. npm ci UNIQUEMENT si package-lock.json a changé          │
                    4. next build DANS LE STAGING (l'app en ligne continue       │
                       de servir — zéro interruption pendant ~15 min)           │
                    5. swap atomique .next (l'ancienne version conservée)       │
                       + git reset prod (code + public/) + pm2 restart          │
                    6. health check 6×15 s ── échec ──▶ ROLLBACK .next.old     │
                       + blacklist du commit (jamais de boucle de crash)        │
                    7. succès ──▶ last-deployed.txt mis à jour                 │
```

## Installation (une seule fois, root)

```bash
# depuis ce dossier du repo :
cp deploy.sh auto-update.sh /opt/gen3ia-updater/   # après mkdir -p /opt/gen3ia-updater/state
bash install.sh   # installe le poller PM2 + état initial
```

`install.sh` attend les scripts dans `/opt/deploy.sh` et `/opt/auto-update.sh`
(chemins de transfert) — voir le script.

## État & supervision

| Fichier | Rôle |
|---|---|
| `state/last-deployed.txt` | SHA en production |
| `state/failed_commits.txt` | Commits dont le build/démarrage a échoué (jamais retentés) |
| `state/deploy.log` | Journal complet des déploiements |
| `pm2 logs updater` | Sortie du poller |

## Garanties « sans destruction d'état »

- `.env.production` est gitignored : aucun `git reset` ne peut le modifier.
- Le build échoue → l'app courante n'a pas bougé d'un octet.
- Le nouveau build démarre mal → rollback automatique sur la version
  précédente en moins de 90 secondes.
- Les données (R2) sont externes au VPS : jamais touchées.

## Déclencher un déploiement manuel

```bash
bash /opt/gen3ia-updater/deploy.sh   # déploie origin/main si différent
```

---

# Mode PULL (2026-10-26) — déploiement sans SSH entrant

**Problème résolu** : le transfert SCP runner→VPS dépend du SSH *entrant*,
régulièrement bloqué côté VPS (PerSourcePenalties / fail2ban / bruit SSH
partagé des IP GitHub — vagues #43-#49 puis #79-#88, ~16 h d'interruption CD).

**Principe** : le runner GitHub compile puis publie le build sur la release
`cd-latest` (dépôt public → téléchargement anonyme). Le VPS déploie en
HTTPS **sortant** uniquement, avec les garanties inchangées (swap atomique,
rollback, blacklist — `cd-finisher.sh` au SHA cible, jamais obsolète).

```
runner GitHub ──build──▶ release cd-latest (tar + sha256 + meta.json)
                              │
VPS poller updater (2 min) ──▶ pull-deploy.sh ──▶ cd-finisher.sh <sha>
```

### Installation (une fois, root, console fournisseur — aucun SSH requis)

```bash
curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/install-pull-mode.sh | bash
```

Installe `pull-deploy.sh`, rebanche le poller existant (`deploy.sh` → shim,
ancien mode conservé en `deploy.sh.build`) et lance un premier déploiement.

### Rétablissement DÉFINITIF du blocage VPS (gel dernier kilomètre)

Si la prod est figée (release `cd-latest` non délivrée) et/ou que le SSH
entrant renvoie `Not allowed at this time` (pénalités source OpenSSH ≥ 9.8),
un seul script traite les deux causes et blinde contre la récidive :

```bash
curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/fix-definitif-vps.sh | bash
```

8 étapes idempotentes (diagnostic, déblocage SSH `PerSourcePenalties no`
+ fail2ban + ufw, réinstallation poller, purge backoff/blacklist, réparation
PM2 « updater » + persistances, déploiement immédiat, **watchdog anti-récidive**
toutes les 5 min, verdict). Journaux : `/var/log/gen3ia-fix.log`,
`/var/log/gen3ia-watchdog.log`.

### Fichiers

| Fichier | Rôle |
|---|---|
| `pull-deploy.sh` | Télécharge la release `cd-latest`, vérifie le sha256, délègue au finisher |
| `install-pull-mode.sh` | Installation idempotente en une commande (console) |
| `fix-definitif-vps.sh` | Rétablissement définitif blocage VPS (SSH barré + poller mort) + watchdog |
| `state/pull-current.txt` | Stamp anti-reboucle du poller (supprimer pour forcer) |

Le mode build historique (ce README, ci-dessus) reste documenté et archivé :
il redevient pertinent si le VPS gagne un jour la RAM nécessaire au `next build`.
