# Sécurité entreprise — MFA, SSO/OIDC, chiffrement CMEK

> Task 63 (priorité #6 de la feuille de route). Ce guide couvre l'activation
> et l'exploitation des trois briques « entreprise » de Gen3ia : l'authen-
> tification multi-facteurs (TOTP), la fédération d'identité SSO (OIDC/SAML
> via Identity Platform) et le chiffrement géré par le client (CMEK).

## 1. MFA — authentification multi-facteurs (TOTP)

### 1.1 Ce qui est déjà en place (code)

| Composant | Rôle |
|---|---|
| `lib/security/mfa.ts` | Détection du second facteur dans un token vérifié (`firebase.sign_in_second_factor`), politique « MFA requis » par compte (`users/{uid}.mfaRequired`), assertion centralisée `assertStrongAuth` |
| `lib/server/session-cookie.ts` | Le cookie de session signé recopie la preuve MFA (champ `mfa`) — les sessions cookie héritent du niveau d'assurance |
| `app/api/auth/session` | Répond `mfa: true/false` au client et pose le cookie enrichi |
| `app/api/admin/security/mfa-requirement` | Politique par compte réservée admin (GET/POST) avec garde anti-locked-out |
| `app/api/billing/topup` | Surface sensible protégée : `assertStrongAuth` avant tout rechargement wallet |
| `lib/auth/mfa-client.ts` | Flux SDK client : enrôlement TOTP (QR + confirmation), résolution du défi de connexion, désinscription |

### 1.2 Prérequis : activer Identity Platform

L'enrôlement TOTP exige **Firebase Authentication avec Identity Platform**
(la version gratuite standard ne le supporte pas) :

1. Console GCP → **Identity Platform** → activer pour le projet Firebase de
   l'application (facturation à l'usage, paliers MAU — négligeable au
   démarrage) ;
2. Firebase Console → Authentication → Settings → **User session
   management / MFA** : activer « Multi-factor authentication », facteur
   **TOTP** ;
3. Dans Vercel, ajouter la variable `FIREBASE_AUTH_IDENTITY_PLATFORM_ENABLED=true`
   (production) — elle débloque la route admin de politique (garde
   anti-locked-out : on ne peut pas exiger le MFA d'un compte tant qu'il ne
   peut pas s'enregistrer).

### 1.3 Flux utilisateur (après activation)

- **Enrôlement** : paramètres de sécurité → « Activer la double
  authentification » → `startTotpEnrollment()` affiche le QR (authenticator
  Google/Aegis/1Password) → l'utilisateur saisit le code à 6 chiffres →
  `enrollTotpMfa(code)` finalise.
- **Connexion** : le sign-in classique renvoie l'erreur
  `auth/multi-factor-auth-required` → l'UI collecte le code →
  `resolveTotpChallenge(erreur, code)` → session établie avec le flag MFA.
- **Application** : toute route sensibles appelle `assertStrongAuth` — un
  compte marqué `mfaRequired` qui se connecte SANS second facteur reçoit
  403 avec un message explicite de réparation.

### 1.4 Politique et Audit

- Le flag `mfaRequired` est POSÉ PAR COMPTE par un admin
  (`POST /api/admin/security/mfa-requirement`), jamais par l'utilisateur ;
- Chaque changement écrit une entrée `mfaAuditLogs` (acteur, cible,
  précédent) ;
- Le fail-open sur panne Firestore (`isMfaRequiredForUser`) est
  volontairement documenté : une indisponibilité de la politique ne doit
  jamais verrouiller en masse — la surface argent reste protégée par les
  autres garde-fous (rate limits, audit, wallet).

## 2. SSO d'entreprise (OIDC / SAML)

La fédération passe par Identity Platform (même activation que le MFA).
Deux chemins selon la taille de l'organisation :

### 2.1 OIDC générique (Azure AD / Okta / Keycloak…)

1. Console → Identity Platform → Providers → **Add a provider → OIDC** ;
2. Renseigner l'issuer URL du fournisseur, client ID/secret, scopes
   (`openid email profile`) ;
3. Autoriser le domaine de rappel : Firebase Console → Authentication →
   Settings → Authorized domains → ajouter `gen3ia.online` (déjà en place)
   et le domaine du fournisseur si popup nécessaire ;
4. Côté application : le bouton de connexion utilise
   `signInWithPopup(auth, new OAuthProvider(issuerId))` (SDK déjà chargé
   pour Google/GitHub — `lib/firebase/client.ts`) ;
5. Le provisionnement utilisateur est automatique : `POST /api/auth/session`
   appelle `ensureUserProfile` avec le provider OIDC — wallet, équipes et
   rôles suivent le même chemin que les connexions sociales existantes.

### 2.2 Google Workspace (cas le plus simple)

Identity Platform → Providers → Google → restreindre l'audience au domaine
de l'organisation (`hd` claim) ; la route session existante fonctionne sans
modification.

### 2.3 Règles de sécurité associées

- Les comptes SSO héritent des **mêmes** politiques (rôles plateformes,
  cloisonnement orgId Task 58, wallet) — aucun privilège implicite ;
- Recommandé : exiger le MFA du fournisseur d'identité (imposé côté Azure
  AD/Okta) ET conserver `mfaRequired` Gen3ia pour les comptes locaux.

## 3. Chiffrement CMEK (Google Cloud KMS)

Le chiffrement au repos Firestore est actif par défaut (clés Google). Le
**CMEK** (Customer-Managed Encryption Keys) donne à l'organisation la
maîtrise des clés — exigence de certains silos enterprise.

Prérequis : projet GCP facturé (la création de bases CMEK exige le support
Cloud Firestore CMEK, disponible en édition standard) :

1. **KMS** : créer un trousseau + clé (`projects/<gcp-project>/locations/<region>/keyRings/gen3ia/cryptoKeys/firestore`);
2. **Identité de service** : accorder `roles/cloudkms.cryptoKeyEncrypterDecrypter`
   à l'agent de service Firestore (`service-<project-number>@gcp-sa-firestore.iam.gserviceaccount.com`) ;
3. **Base CMEK** : créer une NOUVELLE base Firestore avec `--database-id`
   et la clé CMEK (gcloud firestore databases create --cmek-key …) — la
   base par défaut ne peut PAS être convertie après coup ;
4. **Migration** : exporter/importer les collections (gcloud firestore
   export → import vers la base CMEK) puis basculer les variables
   `FIREBASE_PROJECT_ID` — les règles et index sont recréés à l'identique ;
5. **Rotation** : planifier la rotation de la clé KMS (max 90 jours
   recommandé enterprise) — transparente pour l'application.

Le stockage d'objets (S3 utilisé par l'application) supporte SSE-KMS côté
AWS avec la même démarche (`aws:kmKeyId` sur le bucket — `lib/storage/r2.ts`
ne stocke aucune clé).

## 4. Limites connues et suivi

- L'UI d'enrôlement MFA (section paramètres de sécurité) est branchée sur
  `lib/auth/mfa-client.ts` — visible dès Identity Platform actif ;
- SAML : Identity Platform le supporte (edition Cloud Identity Plus) —
  même démarche que l'OIDC, provider « SAML » ;
- Le flag MFA par compte est la première étape : une politique par
  ORGANISATION (`orgs/{orgId}.mfaRequired`) s'appuiera sur le même
  `assertStrongAuth` (extension naturelle du cloisonnement Task 58).
