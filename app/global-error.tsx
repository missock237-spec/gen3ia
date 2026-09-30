"use client";

import { captureClientException } from "@/lib/telemetry/sentry-bridge-client";

/**
 * Boundary d'erreur global (App Router) : une exception de rendu sur une page
 * ne doit JAMAIS laisser l'utilisateur sur l'écran de crash brut de Next.js.
 * Le bouton Réessayer remonte l'erreur côté client ; le bouton Tableau de bord
 * offre une issue quand la page elle-même est cassée.
 *
 * Thème (étape 4) : cette page rend son PROPRE <html> — elle applique le
 * thème choisi (localStorage "gen3ia-theme", même convention que le layout
 * racine) et peint uniquement avec les variables --g3-* : l'écran d'erreur
 * suit sombre/clair exactement comme le reste de l'application.
 *
 * Sentry (Task 40) : capture via le pont asynchrone (file synchrone +
 * SDK au repos) — importer @sentry/nextjs ici remettrait +54 kB gzip sur
 * le chemin critique de chaque page (mesure ADR-005). Le digest Next est
 * conservé comme tag pour corréler avec les erreurs serveur.
 */

const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem("gen3ia-theme");var t=s||"dark";document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // useEffect ici est impossible (cette boundary rend <html> entier) :
  // capture au rendu, file bornée côté pont (dédupliquée par le SDK).
  captureClientException(error, { surface: "global-error", digest: error?.digest ?? "none" });

  const digest = error?.digest ? String(error.digest).slice(0, 16) : null;

  // Couleurs via variables CSS du thème (définies en secours ci-dessous :
  // globals.css n'est pas injecté dans cette boundary autonome).
  const vars = {
    bg: "var(--g3-bg, #0B0D1A)",
    card: "var(--g3-surface, #14162B)",
    text: "var(--g3-text, #F2F3FA)",
    muted: "var(--g3-muted, #8B90AB)",
    border: "var(--g3-border, #262A47)",
    dangerSoft: "var(--g3-danger-soft, rgba(246, 98, 110, 0.13))",
    dangerStrong: "var(--g3-danger-strong, #FB8E96)",
    primary: "var(--g3-primary, #7C5CFF)",
  } as const;

  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: vars.bg, color: vars.text }}>
        <div style={{ minHeight: "100vh", background: vars.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ maxWidth: 480, width: "100%", background: vars.card, borderRadius: 24, padding: 32, textAlign: "center", border: `1px solid ${vars.border}`, boxShadow: "0 14px 40px -18px rgba(0,0,0,0.4)" }}>
            <div style={{ width: 56, height: 56, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 16, background: vars.dangerSoft, fontSize: 28 }}>⚠️</div>
            <h1 style={{ marginTop: 20, fontSize: 22, fontWeight: 600, color: vars.text }}>Une erreur inattendue est survenue</h1>
            <p style={{ marginTop: 12, fontSize: 14, lineHeight: "22px", color: vars.muted }}>
              La page n&apos;a pas pu s&apos;afficher complètement. Vos données et vos agents ne sont pas affectés — vous pouvez réessayer tout de suite.
            </p>
            {digest ? (
              <p style={{ marginTop: 8, fontSize: 12, color: vars.muted }}>
                Référence d&apos;erreur : <code>{digest}</code>
              </p>
            ) : null}
            <div style={{ marginTop: 24, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={reset}
                style={{ padding: "10px 22px", borderRadius: 9999, background: vars.primary, color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                Réessayer
              </button>
              <a
                href="/dashboard"
                style={{ padding: "10px 22px", borderRadius: 9999, background: "transparent", color: vars.text, border: `1px solid ${vars.border}`, fontSize: 14, fontWeight: 600, textDecoration: "none" }}
              >
                Aller au tableau de bord
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
