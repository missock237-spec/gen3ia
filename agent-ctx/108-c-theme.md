# Task ID: 108-c — Thème : 2 palettes uniquement (Porcelaine bleutée ↔ Nebula)

Agent : développement Next.js 15 / TypeScript / CSS. Dépôt main = 84f8ce2 (aucune commande git, aucune dépendance ajoutée).

## Périmètre réellement touché (contrat 108-0 respecté)
- `app/globals.css` — blocs de tokens + overrides clair + îlot `.g3-agent-light`
- `components/ui/theme-choice.tsx` — persistance serveur fire-and-forget
- `components/ui/theme-toggle.tsx` — NON MODIFIÉ (déjà conforme : 2 valeurs seulement, vérifié par test)
- `components/agent/agent-chat-panel.tsx` — tokenisation 100 % (0 hex, 0 rgba, 0 bg-white)
- `app/layout.tsx` — uniquement le meta theme-color anti-FOUC (#F1F2F8 → #EFF7FB)
- `app/theme-consistency.test.ts` — extension (10 → 18 tests), assertions d'origine conservées
- JAMAIS touché : routes auth / lib/identity (108-b), package.json, supabase/, lib/db, lib/cache (108-a)

## 1. Thème clair « Porcelaine bleutée » (= ambiance agent IA, [data-theme="light"])
| Token | Avant | Après | Note |
|---|---|---|---|
| --g3-bg | #F1F2F8 (gris-violet) | **#EFF7FB** | la porcelaine bleutée du panneau agent |
| --g3-surface | #FFFFFF | #FFFFFF | blanche (inchangée) |
| --g3-elevated | #E9EBF5 | #E3EEF5 | bleuté |
| --g3-deep | #12152B | #101B26 | bleu-nuit (blocs de code) |
| --g3-border / strong | #E2E4F0 / #C9CCE2 | #D9E6EF / **#B7D8E8** | bordure forte = bleu doux agent |
| --g3-text | #14162B | **#101B26** | bleu-nuit profond (17.4:1) |
| --g3-text-secondary | #3B3F5C | **#1F4E5F** | canard profond (9.1:1) |
| --g3-muted | #6B7092 | **#3E6478** | gris-canard (6.4:1) |
| --g3-faint | #9CA0BC (2.6:1) | #6E8A9B | méta (3.6:1, was 2.6) |
| --g3-primary | #6C48FF | #6C48FF | CONSERVÉ (verrou) |
| --g3-info (NOUVEAU) | — | #1F4E5F | teinte info/lien fort agent |
| --g3-info-soft / -border (NOUVEAUX) | — | rgba(31,78,95,.07) / #B7D8E8 | surfaces info du panneau |
| --g3-warning | #D97706 | **#B45309** | ambre-brun (5.0:1) ; strong = **#6B5210** |
| --g3-warning-border (NOUVEAU) | — | #E4C88E | |
| --g3-danger | #DC2626 | **#B33636** | rouge doux agent (6.0:1) ; strong #9B2C2C |
| --g3-danger-border (NOUVEAU) | — | rgba(179,54,54,.45) | |
| --gen3ia-dark | #14162B | #101B26 | alias bleu-nuit |
| gradients | — | inchangés | signature 6C48FF→C026D3→0899B4 conservée |

Overrides clair remis en cohérence : `.sky-hero` (fin #E9F3F9), `.grid-bg` (rgba(31,78,95,.06)), `.cream-card` (#F4F9FC + ombre bleu-nuit), `.g3-command-backdrop` (rgba(16,27,38,.35)), NOUVEAU : encre claire #C9DEE8 pour les surfaces code sur îlot bleu-nuit `--g3-deep` (.g3-code, console, result pre — corrige 1.75:1 → 12.5:1).

## 2. Thème sombre « Nebula » (affinage :root, identité intacte)
- VERROUS conservés EXACTS (test app/offline-page.test.ts) : --g3-bg #05060C, --g3-surface #0B0D17, --g3-primary #7C5CFF.
- Hiérarchie de texte (sur #0B0D17) : text #F4F5FB ≈17.8:1 ; text-secondary #C7CBE4 ≈12.1:1 ; **muted #8F95B8→#9AA0C2 (6.6→7.5:1)** ; **faint #5C6284→#6B7194 (3.3→4.1:1)** — tous ≥ 4.5:1 sauf faint (méta, ≥ 3:1).
- Fonds : **elevated #121527→#101325**, **deep #070812→#060710** (plus profonds) ; hover .07→.06.
- Softs plus subtils : primary .16→.14, secondary .13→.11, magenta .14→.12, états .13→.11.
- Ombres : shadow-sm/md/glow dé-noirées (teintes 3,4,12 / 4,5,16), glow-ring .35→.26 (plus discret).
- Valeurs sombres des NOUVEAUX tokens : --g3-info #8FD8EC (12.2:1), info-soft rgba(143,216,236,.10) (10.2:1), info-border rgba(143,216,236,.32), warning-border rgba(245,174,49,.40), danger-border rgba(246,98,110,.42).
- Gradient signature : INTACT.

## 3. Îlot `.g3-agent-light` (atelier, §14)
Ajout des 5 nouveaux tokens avec les valeurs historiques du panneau (info #1F4E5F/#B7D8E8, warning-border #E8C97A, danger-border rgba(194,65,65,.45)) : l'îlot crème garde son identité pendant que le panneau, DÉHORS de l'îlot, suit désormais les 2 thèmes. Aucun renommage, aucun nouveau sélecteur de thème.

## 4. agent-chat-panel.tsx — tokenisation intégrale
15 occurrences supprimées : #D97757→var(--g3-primary) ; #E8C97A/#FBF3DF/#D9BE7E/#F3E6C3→warning-border/-soft/-soft ; #6B5210/#8A6A1E→warning-strong ; #B7D8E8/#EFF7FB/#E3F0F7→info-border/-soft/-soft ; #1F4E5F→info ; rgba(194,65,65,*)→danger-border/-soft ; #B33636→danger (hover = renforcement border+text, contraste meilleur que l'ancien hover bg) ; #F5F3EC→hover ; #6B695F→muted ; hover:bg-white→hover:bg-[var(--g3-elevated)] (corrige un texte invisible au survol en sombre) ; 3 ombres rgba(59,56,45,*)→var(--gen3ia-shadow-md)/hover:shadow-md. Zéro hex/rgba restant (verrouillé par test).

## 5. theme-choice.tsx — contrat 108-b
`persistThemeOnServer()` : `fetch("/api/auth/profile", { method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({theme: next}), credentials:"same-origin" }).catch(() => undefined)` — appelé après CHAQUE `apply()` (sombre et clair). Jamais bloquant, jamais d'erreur visible. localStorage inchangé. Libellé clair : « Porcelaine bleutée ».

## 6. layout.tsx — anti-FOUC uniquement
THEME_BOOTSTRAP + viewport.themeColor : #F1F2F8 → #EFF7FB (barre navigateur = nouveau fond clair). Sous-chaînes testées `m.setAttribute("content"` / `t==="light"` conservées.

## 7. Verrou « 2 thèmes »
rg data-theme dans le dépôt : valeurs = dark|light uniquement (layout, global-error, globals.css, tests) ; ThemeChoice/ThemeToggle : union `"dark" | "light"` uniquement (testé). `.g3-agent-light` = classe SCOPÉE (pas un data-theme). Aucun 3e thème créé.

## Validation chiffrée
- `npx tsc --noEmit` : 27 erreurs TOUTES hors périmètre (imports @/lib/db/dual-write, @/lib/db/firestore-fallback, @/lib/supabase/config, @/lib/infra/upstash — purge 108-a en cours) ; **0 erreur dans mes 6 fichiers**.
- `npx eslint ... --max-warnings 0` sur les 5 fichiers TS/TSX : **0 erreur / 0 warning**. `app/globals.css` : ignoré structurellement par ESLint 9 flat config (aucun parseur CSS dans le dépôt — un plugin = nouvelle dépendance INTERDITE) → écart documenté, contrôle qualité CSS assuré par les tests structurels.
- `npx vitest run app/theme-consistency.test.ts components/ui` → **18/18 verts** (exit 0).
- Suites lisant globals.css : offline-page 9/9, ux-accessibility 23/23, media-progress-frame 24/24.
- `vitest run app components` : 381 tests passés ; 4 fichiers FAIL à l'IMPORT (ai-response-quality, agents/route-org, health/infra, queue/mission-tick) — tous sur les modules supprimés par 108-a (firestore-fallback/dual-write), hors périmètre.
- CSS : 471 accolades équilibrées ; 37 tokens --g3-* par bloc, parité dark↔light = OK.

## Écarts
1. ESLint ne peut pas linté .css (aucun plugin CSS dans le dépôt, dépendance interdite) — la commande littérale demandée sort exit 1 sur globals.css ; validé à la place : eslint 0/0 sur les 5 fichiers TS/TSX + verrous structurels vitest sur le CSS.
2. `--g3-bg/surface/primary` sombres non retouchés (légère retouche demandée sur 4 fonds) : verrou dur app/offline-page.test.ts (#05060C/#0B0D17/#7C5CFF) — fichier hors périmètre ; retouche appliquée à elevated/deep + ombres/softs.
3. Les 2 ombres `rgba(59,56,45,…)` du composer (command-composer) sont hors de mes fichiers ; le panneau lui-même est 100 % tokenisé.
