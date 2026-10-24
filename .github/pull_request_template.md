<!--
Modèle de pull request — Gen3ia (processus d'ingénierie : docs/processus-ingenierie.md).
Chaque section est OBLIGATOIRE : en mode solo + agents IA, la PR EST le support
de revue (le relecteur — humain ou agent indépendant — ne connaît que ce qu'on
lui montre). Une section vide est un signal d'alarme, pas un raccourci.
-->

## Contexte

<!-- Pourquoi ce changement ? Problème constaté, demande utilisateur, incident,
     mission (Task ID), doc de référence (worklog, postmortem, roadmap).
     Une phrase suffit si le lien parle de lui-même. -->

## Changements

<!-- Liste concise des modifications : fichiers clés, comportement avant/après.
     Signaler explicitement : suppressions de pages/routes, nouvelles variables
     d'environnement, changements de dépendances. -->

## Tests effectués

<!-- Preuves : vérifications locales (relecture statique, tests ciblés) +
     résultats CI. Toute PR doit arriver avec la CI VERTE (typecheck · lint ·
     tests · audit · build · budget, accessibilité, E2E, gitleaks) — cf.
     .github/workflows/ci.yml. Si un job ne s'applique pas, expliquer pourquoi. -->

## Risques & plan de rollback

<!-- Ce qui peut casser (perf, sécurité, données, prod) et comment revenir en
     arrière : revert git du commit, redirection next.config.ts si pages
     supprimées, rollback automatique .next.old côté VPS (infra/deploy/cd-finisher.sh),
     variable d'environnement à retirer… Un changement sans plan de rollback
     n'est pas un changement déployable. -->

## Checklist

- [ ] **CI verte** sur la PR (aucun merge sur CI rouge — jamais de push main en cas d'échec)
- [ ] **Aucun secret commité** (pas de clé/token ; toute nouvelle variable est documentée dans `.env.example` ; gitleaks au vert)
- [ ] **Documentation à jour** (README, `docs/`, `.env.example`, commentaires d'en-tête des fichiers touchés)
- [ ] **Périmètre respecté** (aucun fichier hors mission ; workflows existants intacts ; `package.json` non touché sauf nécessité justifiée)
- [ ] **Redirections mises à jour** si pages ou routes supprimées (`next.config.ts` → `redirects()`, liste blanche `lib/security/user-access.ts` alignée)
- [ ] **Relecture faite** par un relecteur distinct de l'auteur (humain ou agent indépendant — cf. `.github/CODEOWNERS`)
- [ ] **Branche courte** : vit < 48 h, base `main` à jour, prête à fusionner (trunk-based — cf. `docs/processus-ingenierie.md`)
