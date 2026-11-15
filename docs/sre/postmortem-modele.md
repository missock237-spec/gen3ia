# Modèle de postmortem « sans blâme » (blameless)

> Modèle à **copier** dans `docs/sre/postmortems/AAAA-MM-JJ-slug.md` pour
> chaque incident P1/P2 (et tout dépassement d'error budget — cf.
> `docs/sre/sli-slo.md` §4). Le postmortem se rédige **après** le
> rétablissement, dans les 5 jours ouvrés, et se relit en équipe (30 min).

---

## Principes sans blâme (à lire avant d'écrire)

1. **Chaque personne a agi raisonnablement** avec les informations, les
   outils et les contraintes qu'elle avait à ce moment-là. Si une erreur
   humaine semble en cause, la question est : *quel système a permis à
   cette erreur de causer un incident ?*
2. On analyse des **causes systémiques** (process, outillage, surveillance,
   documentation), jamais des individus. Un postmortem qui nomme un
   coupable est invalide et doit être réécrit.
3. **Les hypothèses sont étiquetées comme telles** ; ce qui est affirmé est
   sourcé (logs, métriques, liens Sentry, PR, graphiques).
4. L'objectif est un **plan d'actions daté et attribué** — pas une liste de
   vœux. Sans action suivie, le document ne sert à rien.
5. Le document est **interne et diffusé largement** : les incidents coûtent
   cher, leur enseignement doit profiter à tout le monde.

---

## Modèle

```markdown
# Postmortem — [Titre court de l'incident]

- **Date de l'incident** : AAAA-MM-JJ (UTC)
- **Durée d'impact** : HH:MM UTC → HH:MM UTC (durée totale : XhYY)
- **Gravité** : P1 / P2 / P3 (critères : docs/runbooks/incident-response.md §2)
- **Auteur·e du postmortem** : …
- **Statut** : BROUILLON / RELU / ACTIONS OUVERTES / CLÔT
- **Error budget consommé** : X % du budget mensuel (SLO concerné : …)

---

## 1. Résumé (5 lignes max)

Que s'est-il passé, sur quel périmètre, quel impact pour les utilisateurs,
comment c'est rétabli. Rédigé pour quelqu'un qui n'était pas présent.

## 2. Impact

- **Utilisateurs** : combien, quelles fonctionnalités, quelle durée
  (ex. « chat indisponible ~25 min », « N échecs de génération vidéo »).
- **Métriques** : dispo sur la fenêtre (%), pics 5xx, latence P95
  (sources : /api/metrics, logs nginx, Sentry).
- **Données / argent** : données perdues ou corrompues ? paiements/wallet
  affectés ? (si oui : action de réconciliation chiffrée).
- **Ce qui a continué de fonctionner** (utile pour calibrer les SLO).

## 3. Chronologie (tous horaires UTC)

| Heure | Événement | Source |
|---|---|---|
| HH:MM | Faits déclenchants (déploiement, charge, maintenance…) | CD / cron / Sentry |
| HH:MM | Premier signal d'alerte (moniteur, utilisateur) | … |
| HH:MM | Début de l'intervention ; diagnostic | … |
| HH:MM | Décision et action majeure (rollback, restart, config) | … |
| HH:MM | Rétablissement du service | … |
| HH:MM | Fin de surveillance renforcée | … |

Indiquer explicitement les **temps d'attente** (alerte tardive, escalade,
décision) : ce sont les gisements d'amélioration les plus rentables.

## 4. Analyse — 5 pourquoi

Pourquoi 1 → pourquoi 2 → … jusqu'à la cause **systémique**.
(Représentation libre ; s'arrêter quand la réponse n'est plus « parce que
quelqu'un a… » mais « parce que le système ne garantissait pas… ».)

## 5. Causes racines (systémiques)

- **Cause principale** : …
- **Facteurs contributifs** : surveillance manquante, documentation obsolète,
  test absent, dépendance non bornée, charge non prévue…
- **Ce qui a bien fonctionné** (rollback CD, alerte, runbook…) — à préserver
  explicitement, sinon on le casse à la prochaine refactorisation.

## 6. Actions correctives

| # | Action | Type (empêcher / détecter / atténuer) | Responsable | Échéance | Suivi (PR / issue) |
|---|---|---|---|---|---|
| 1 | … | empêcher | … | AAAA-MM-JJ | … |
| 2 | … | détecter | … | AAAA-MM-JJ | … |

Règles : ≤ 5 actions (le reste va au backlog), chaque action a UN
responsable et une échéance, priorité aux actions « empêcher » et
« détecter » sur les actions « process » pures.

## 7. Leçons retenues

- 3 à 5 phrases transférables (pour la base de connaissances de l'équipe).
- Ce que le prochain postmortem fera différemment (outillage du document
  lui-même).

## 8. Annexes

- Liens : run CD défaillant, PR suspecte, issue Sentry, extraction de logs,
  courbes (/api/metrics, nginx).
- Requêtes de diagnostic réutilisables (curl, awk) qui ont permis le
  diagnostic.
```

---

## Rappel de calendrier

| Étape | Délai |
|---|---|
| Rétablissement constaté | — |
| Postmortem brouillon | ≤ 2 jours ouvrés |
| Relecture sans blâme (équipe) | ≤ 5 jours ouvrés |
| Actions ouvertes suivies | revue à chaque rapport mensuel SLI (cf. `docs/sre/sli-slo.md` §4) |
