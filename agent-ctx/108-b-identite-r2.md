# Task 108-b — Base de données d'identités R2 (lot identité/profil)

Agent : développement Next.js 15 / TypeScript. Dépôt : main 84f8ce2, zéro commande git, zéro installation.

## Périmètre réellement touché

Créés (`lib/identity/`) :
- `lib/identity/schema.ts` — IdentitySchema zod (document stocké) + IdentityPatchSchema (strictObject, 11 champs modifiables).
- `lib/identity/r2-identity-store.ts` — LA base : clé canonique `identities/{uid}.json`, uid revalidé avant composition de clé, putIdentity (re-parse schéma + canonique clés triées + garde 64 Ko), getIdentity (absence→null, corrompu→IdentityError, plafond lecture 128 Ko), deleteIdentity idempotent, listIdentities paginé, IdentityError{not_found|corrupted|too_large|unavailable|invalid}, estAbsenceR2 (NoSuchKey/404 SDK v3 + mocks).
- `lib/identity/service.ts` — ensureIdentity idempotent (création complète / fusion remplissage-des-vides / throttle lastLoginAt >1 h miroir Task 101 / providers dédupliqués / email vérifié = autorité serveur), updateIdentity (immutables ignorés, inconnus rejetés), setEmailFromVerifiedToken, getIdentitySafe, deleteIdentityForAccount, publicIdentity, identityErrorStatus.
- Tests : `r2-identity-store.test.ts` (20), `service.test.ts` (23), `source-guard.test.ts` (5 — gardes fs : lib/identity sans firebase-admin/Supabase/SDK AWS direct ; routes sans ensureUserProfile).

Modifiés (`app/api/auth/`) :
- `session/route.ts` — ensureUserProfile (Firestore) → ensureIdentity (R2) ; degraded:true si panne R2, session établie quand même ; `user.theme` additionnel en POST/GET ; wallet inchangé.
- `profile/route.ts` — POST d'inscription historique préservé à l'identique (contrat auth-client.ts hors lot) mais écrit en R2 ; GET → identité complète (requireUser, uid du jeton uniquement) ; PUT → IdentityPatch strict + `theme` (contrat 108-c) ; 404/422/503 FR.
- `account/route.ts` — cascade RGPD + `deleteIdentityForAccount` (étape 3, avant Auth) ; panne R2 → journalise et continue ; `deleted.identityDeleted` additionnel.

Tests routes : `app/api/auth/session.test.ts` (7), `profile.test.ts` (10), `account.test.ts` (3). Mocks R2 en mémoire (Map) fidèles — pattern workspace-durability.test.ts.

## Forme du document identité

`identities/{uid}.json` — JSON canonique (clés triées récursivement), ≤64 Ko, `identityVersion: 1` : uid, email (null|≤254), emailVerified, displayName/firstName/lastName/username/photoURL/phoneNumber/country/bio (null|bornés), language "fr", timezone "UTC", theme "dark"|"light", providers[], plan "free", role "user", status "active", createdAt/updatedAt/lastLoginAt (ISO), identityVersion. Écriture contentType application/json via putObject, lecture downloadFromR2 (plafond 128 Ko).

## Sémantique de dégradation

- Panne R2 ≠ invalidation d'authentification : session 200 + degraded:true + cookie posé (philosophie bug « database was deleted » conservée).
- profile GET/PUT → 503 explicite ; 404 si non provisionné ; 422 champ inconnu (strict).
- account DELETE : Auth/Firestore TOUJOURS supprimés même si R2 tombe (identityDeleted:false + logger.warn).

## Validation (chiffrée)

- `npx vitest run lib/identity app/api/auth` → 6 fichiers / **68 tests verts** (124 ms).
- `npx eslint` (12 fichiers du périmètre) `--max-warnings 0` → **0 erreur / 0 warning**.
- `npx tsc --noEmit` → **0 erreur périmètre 108-b** ; 1 erreur HORS périmètre : `lib/video/queue-resume.ts(101) Cannot find name 'RenderJob'` (lot 108-a en cours de purge Supabase — vérifiée non liée).
- Total : 9 fichiers créés/modifiés, 2514 lignes (dont 1232 lignes de tests).

## Écarts / décisions à connaître (réconciliation orchestrateur)

1. Codes harmonisés : le brief cite « identity_too_large »/« identity_corrupted » ; implémenté avec les codes de classe uniques `too_large`/`corrupted` (contrat de la classe IdentityError).
2. `ensureIdentity` accepte les champs d'inscription étendus (firstName/lastName/username/phoneNumber/country/bio/language/timezone) en plus des params du brief — requis pour préserver le POST /api/auth/profile du client hors lot `lib/firebase/auth-client.ts` (désormais écrit en R2).
3. `listIdentities` pagine sur un scan ≤1000 objets (le client `listObjectsUnderPrefix` agrège sans curseur natif) — suffisant pour l'usage audit/RGPD futur, documenté dans le code.
4. Champs immutables (email/role/plan/status/…) : filtrés AVANT le parse strict → silencieusement IGNORÉS (200 sans effet) plutôt que rejetés, tandis que tout AUTRE champ inconnu est rejeté (422) — satisfait les deux exigences du brief.
5. `lib/firebase/users.ts` et les lecteurs domaines users/{uid} (low-balance, push, access, mfa, admin/users) intacts, conformément au worklog 108-0.
