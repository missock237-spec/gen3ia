# Runbook — Réponse aux incidents

> Procédure opérationnelle de gestion des incidents de production
> (<https://gen3ia.online>). À suivre dans l'ordre ; chaque section indique
> quand passer à la suivante. Objectifs : qualifier en < 15 minutes, communiquer
> en < 30 minutes, restaurer le service avant l'analyse fine.

---

## 1. Détection

Trois sources déclenchent la prise d'incident — la première qui alerte lance la
procédure :

| Source | Signal | Où vérifier |
|---|---|---|
| **Moniteur d'uptime** | `GET /api/status` renvoie **503** (ou timeout/erreur réseau) — le code HTTP suffit, le corps n'a pas besoin d'être parsé | Tableau de bord du moniteur (alerte e-mail/notification) |
| **Sentry** | Hausse d'exceptions ou d'erreurs 5xx (`api.agent.execution.failed`, etc.) — les alertes `ProductionAlerts` (logger + Sentry, avec cooldown) couvrent les dérives | Sentry — projet Gen3ia, vues Issues / Alerts |
| **Signalement utilisateur** | Ticket, message, capture d'écran | Support / canal de contact |

Réflexe premier : distinguer **processus mort** vs **plateforme dégradée** :

```bash
# Heartbeat (aucune dépendance externe) :
curl -s -o /dev/null -w "%{http_code}\n" https://gen3ia.online/api/health
# → 200 : le processus répond ; l'incident est une DÉPENDANCE → continuer.

# Statut détaillé (auth / r2 / ticks) :
curl -s https://gen3ia.online/api/status | jq
# → 503 + status "degraded" : lire services.*.reason (not_configured / timeout / error).
```

- `/api/health` KO + `/api/status` KO → incident **processus/déploiement** (aller en §4).
- `/api/health` OK + `/api/status` 503 → incident **dépendance** (Firebase Admin, R2, file de ticks — aller en §4).
- Les deux OK mais Sentry sature → incident **applicatif** (aller en §4).

---

## 2. Classification

| Niveau | Critères | Exemples | Engagement |
|---|---|---|---|
| **P1 — Critique** | Service indisponible ou corrompu pour tous ; fuite de données ; facturation erronée à grande échelle | `/api/health` ou `/api/status` KO prolongé ; 5xx massifs ; secrets exposés | Réaction immédiate, 24/7, communication externe |
| **P2 — Majeur** | Fonctionnalité majeure dégradée pour une part significative d'utilisateurs ; dégradation sans contournement | Génération vidéo/voice en échec ; `/api/status` 503 mais app utilisable ; file de ticks bloquée | Réaction < 1 h ouvrées |
| **P3 — Mineur** | Impact limité, contournable ou cosmétique | Latence élevée ; bug d'affichage ; un type de mission en échec isolé | Traitement en file normale (< 3 jours ouvrés) |

Douter du niveau par excès : un P3 qui s'étend ou touche des données devient P2 ;
un P2 qui touche la disponibilité globale devient P1.

---

## 3. Rôles

| Rôle | Responsabilité |
|---|---|
| **Pilote d'incident** | Tient la procédure, l'horodatage, décide du niveau et du rollback ; UNE seule personne. Par défaut : premier intervenant disponible. |
| **Investigateur** | Exécute les diagnostics (§4), propose la correction ; peut être le pilote en P3. |
| **Communicant** | Rédige les communications (§6) ; en P1, distinct du pilote si possible. |
| **Propriétaire** | Arbitrage final (rollback vs correctif), décision de rétablissement, validation du post-mortem. |

En dessous de 3 personnes disponibles, le pilote cumule les rôles — mais reste
UNE seule source de décision.

---

## 4. Actions immédiates (checklist)

Ordre à dérouler SANS sauter d'étape ; consigner l'heure de chaque constat
(l'historique servira au post-mortem).

1. **Sonder** : `/api/health` puis `/api/status` (cf. §1) — noter les codes et
   `services.*.reason`.
2. **Logs Vercel** : dashboard du projet → onglet **Logs** (ou Observability) —
   filtrer sur les 15 dernières minutes et le `requestId` d'un échec si connu.
   Les logs applicatifs sont structurés (Pino) : chercher
   `"event":"api.agent.execution.failed"` ou `level>=40`.
3. **Sentry** : Issues triées par fréquence récente — identifier le premier
   déploiement touché (comparer « first seen » avec la liste des déploiements
   Vercel) et les `requestId`/`executionId` concernés.
4. **Firebase console** (si `services.auth` dégradé ou suspicion données) :
   santé du projet `gen3ia`, quotas Firestore, règles de sécurité déployées
   (comparez avec `scripts/backup_firebase_rules.mjs` si besoin).
5. **Décision** :
   - Cause liée au **dernier déploiement** → rollback immédiat
     (voir `docs/runbooks/deployment.md` §5) — ne pas tenter un correctif à chaud
     en P1/P2.
   - Cause **externe** (R2/Firebase/provider LLM) → suivre le statut du
     fournisseur, activer les replis prévus si le déploiement est sain.
   - Cause **données/quota** → agir sur la source (purge, relance de la file de
     ticks via sonde `POST` signée, augmentation de quota si justifiée).
6. **Vérifier la restauration** : re-sonder `/api/health` + `/api/status`
   jusqu'à 200/`ok` soutenu, et confirmer l'arrêt de la hausse d'erreurs dans
   Sentry.

Anti-checklist : ne JAMAIS déployer un correctif non testé sous pression ;
ne jamais modifier les règles Firestore en direct sans sauvegarde préalable ;
ne jamais publier de contenu de log brut (ils peuvent contenir des
`requestId` — OK — mais jamais de clés `g3a_`/`g3x_`).

---

## 5. Escalade

- **P1 non qualifié au bout de 15 minutes** → escalade au propriétaire
  (décision rollback) + activation d'un second investigateur.
- **P1 non résolu au bout de 1 heure** → communication externe large (page de
  statut / e-mail utilisateurs) et point de synchronisation toutes les 30 minutes.
- **Suspicion de fuite de secrets** (clé `g3a_`/`g3x_`, token, compte de
  service) → révocation immédiate depuis l'application (Paramètres → Clés API)
  ou la console du fournisseur, **avant** toute autre communication ; traiter
  en P1 même sans impact visible.
- **Impact facturation** (double charge, escrow bloqué) → traiter en P2
  minimum, journaliser dans `auditEvents` via l'action admin appropriée.

---

## 6. Communication

| Canal | Quand | Contenu |
|---|---|---|
| **Fil interne d'incident** | Dès la qualification | Niveau (P1/P2/P3), heure de détection, symptômes, `requestId` représentatifs, décisions prises — mis à jour à chaque changement de niveau |
| **Utilisateurs impactés** | P1 : < 30 min ; P2 : si > 1 h | Quoi / impact / contournement / prochaine mise à jour — ton factuel, sans jargon, sans promesse de délai non tenable |
| **Résolu — interne** | À la restauration | Chronologie, cause racine pressentie, actions de suivi |
| **Résolu — utilisateurs** | P1 uniquement | Rétablissement + mesure corrective en cours |

Toujours citer le **numéro d'incident** (convention : `INC-AAAAMMJJ-NN`) pour
pouvoir recouper avec les `requestId` des tickets support.

---

## 7. Post-mortem

Obligatoire pour tout P1 et tout P2 ayant duré plus de 2 heures. À rédiger dans
les 72 h suivant la résolution, ajouté au dossier `docs/` ou au fil interne,
avec :

1. **Chronologie horodatée** — de la détection à la restauration (c'est ici que
   les notes prises en §4 paient).
2. **Cause racine** — technique ET process (pourquoi le signal n'est pas arrivé
   plus tôt).
3. **Impact** — durée, utilisateurs touchés, requêtes échouées (extraire de
   Sentry/Vercel), coût éventuel.
4. **Ce qui a bien marché / mal marché** — inclure le temps de détection réel
   (cache CDN 30 s de `/api/status` : prendre en compte la fenêtre).
5. **Actions préventives** — chacune avec un responsable et une échéance ;
   trace enregistrée comme tâche de suivi. Exemples typiques : ajouter une
   sonde, ajouter un test de non-régression, renforcer `ProductionAlerts`.

Un post-mortem est **blâmable sur le système, jamais sur les personnes** : s'il
n'y a pas d'action préventive possible, le documenter explicitement.

---

## 8. Rappel des sondes disponibles

| Sonde | Portée | Auth |
|---|---|---|
| `GET /api/health` | Processus vivant uniquement (heartbeat, aucune dépendance) | publique |
| `GET /api/status` | Processus + Firebase Admin + R2 + file de ticks (200/503, cache 30 s) | publique |
| `GET /api/health/infra` | Détails complets par groupe de variables d'environnement | protégée |

Voir `docs/runbooks/deployment.md` pour le smoke test complet après
rétablissement.
