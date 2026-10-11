# Politique de divulgation responsable (bug bounty)

> Task 130 — runbook sécurité. Gen3ia prend la sécurité de sa plateforme
> au sérieux et remercie tout chercheur qui agit de bonne foi. Ce document
> est notre engagement mutuel : ce qui est éligible, ce qui ne l'est pas,
> et les délais que nous tenons en échange. Version courte : **écrivez à
> security@gen3ia.online, ne cassez rien, ne consultez que vos propres
> données, on vous répond.**

## 1. Engagement de Gen3ia

- **Accusé de réception sous 72 heures** ouvrées ;
- **Triage avec sévérité confirmée sous 7 jours** (critique : sous 48 h) ;
- **Correctif visé** : critique sous 7 jours, élevé sous 30 jours,
  moyen sous 90 jours ; faible au fil des sprints ;
- **Transparence** : statut communiqué au chercheur à chaque étape
  (reçu → confirmé → en correction → corrigé), et mention publique
  (remerciement, §6) sauf demande contraire ;
- **Non-poursuite** : aucune action en justice contre un signalement de
  bonne foi respectant le présent cadre (safe harbor, §5).

## 2. Périmètre éligible

- **Production uniquement** : `https://gen3ia.online` (toutes les
  routes, y compris `/api/*`), et aucun autre domaine ni environnement.
- Trouvailles acceptées **uniquement** sur des comptes, équipes et
  données que le chercheur a lui-même créés (cf. règles, §4).
- Exemples de classes recherchées : contournement d'autorisation
  inter-organisations (IDOR), fuite de données d'autrui, XSS persistante,
  SSRF via les intégrations, contournement MFA, usage de clés API
  révoquées, rejeu de webhooks de téléphonie (Twilio/Plivo).

## 3. Sévérités (échelle interne de triage)

| Niveau | Exemples Gen3ia | Correctif visé |
|---|---|---|
| **Critique** | Exécution de code sur le serveur ; accès massif aux conversations/artefacts de toutes les organisations ; contournement complet de l'authentification ou de la facturation ; fuite de clés de service (Firebase, R2) | 7 jours |
| **Élevé** | IDOR donnant accès aux données d'UNE autre organisation ; contournement du MFA sur les surfaces monétaires (wallet, topup) ; XSS volant la session ; SSRF atteignant le réseau interne | 30 jours |
| **Moyen** | Contournement de quota/rate-limit avec impact métier ; XSS réfléchie sans vol de session ; fuite d'informations de configuration sensible ; rejeu de webhook avec effet limité | 90 jours |
| **Faible** | En-tête de sécurité manquant ; énumération d'utilisateurs ; fuite d'information bénigne (version, timestamps internes) ; comportement inattendu sans impact démontré | Au fil des sprints |

La sévérité finale est arbitrée par l'équipe sécurité de Gen3ia à partir
de l'impact réel démontré, pas de la classification de l'outil utilisé.

## 4. Exclusions — signalements non éligibles

- **Attaques par déni de service (DoS/DDoS)** et, de manière générale,
  tout test visant à saturer la plateforme ;
- **Tests de charge non autorisés** : tout tir k6/JMeter/gatling au-delà
  du cadre publié (`docs/load-testing.md`) — les tests de charge ne sont
  autorisés que menés par Gen3ia sur sa propre plateforme ;
- **Rapports de scanners automatisés sans preuve** : sortie brute de
  nuclei/ZAP/Burp sans démonstration d'impact exploitable — nous faisons
  déjà tourner nos propres scans (ZAP hebdomadaire, CodeQL, gitleaks,
  npm audit) et trions leurs résultats en continu ;
- **Vulnérabilités des services tiers** en tant que tels (Vercel, Google
  Firebase, Cloudflare, Twilio…) — à signaler à leurs programmes
  respectifs ; seul l'usage que NOUS en faisons est éligible ;
- **Ingénierie sociale, phishing** de l'équipe ou des utilisateurs ;
- **Attaques physiques**, attaques contre nos employés ou nos locaux ;
- **Spam, scraping, abusive automation** (création de masse de comptes) ;
- **Accès à des données d'autres utilisateurs** au-delà du strict
  nécessaire pour démontrer la vulnérabilité — la preuve d'un accès
  suffit, son exploitation (téléchargement, modification, publication) est
  une faute ;
- Futilités : absence de `robots.txt`, divulgations de version sans
  exploitation, formulaires d'auto-inscription fonctionnels, HTTP 4xx/5xx
  sans contexte, contenus publiés volontairement par nos propres
  utilisateurs.

## 5. Règles de conduite et safe harbor

1. Agir de **bonne foi**, dans le respect de la loi, sans intention
   nuisible ;
2. **Signaler vite** (security@gen3ia.online) dès qu'une vulnérabilité
   est confirmée — ne pas « garder » une trouvaille ;
3. **Ne pas dégrader le service** : pas d'automatisation agressive, pas
   de tests destructifs, pas de chiffrement de données, tout dans la
   fenêtre la plus légère possible ;
4. **Ne toucher qu'à ses propres données** (comptes/équipes créés pour
   le test) ;
5. **Pas de divulgation publique** avant correction (embargo jusqu'à
   correction + 30 jours, sauf accord écrit) ;
6. Utiliser uniquement les moyens décrits au §2 (la production) ; tout
   autre accès (réseau interne, employés) est hors cadre ;
7. Un chercheur respectant ce cadre est **considéré de bonne foi** :
   aucune poursuite, et nous intercédons si un tiers réagissait mal.

## 6. Récompenses symboliques

Gen3ia est une jeune plateforme : le programme est aujourd'hui
**symbolique** (pas de prime monétaire).

- **Critique/élevé** : remerciement public (hall of fame de la page
  sécurité, sur accord écrit) + accès offert au niveau payant pendant
  12 mois ;
- **Moyen** : remerciement public + 3 mois d'accès offert ;
- **Faible** : remerciement dans notre journal des signalements ;
- Les doublons sont crédités au premier signalement horodaté dans la
  boîte security@gen3ia.online.

## 7. Contact

- **Signalements sécurité** : **security@gen3ia.online** (chiffré de
  préférence — clé publique sur demande dans la réponse d'accusé de
  réception) ;
- Questions sur ce cadre : même adresse, objet « Question — politique
  de divulgation » ;
- Urgence (critique confirmée, données exposées) : objet préfixé
  « [URGENT] » — tri prioritaire sous 48 h y compris week-end.

*Ressources internes associées : `docs/security/pentest-checklist.md`
(méthodologie et sévérités), `docs/load-testing.md` (cadre des tests de
charge), `.github/workflows/security.yml` (scan ZAP hebdomadaire),
`docs/enterprise-security.md` (MFA, SSO, CMEK).*
