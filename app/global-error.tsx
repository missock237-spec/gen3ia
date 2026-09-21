"use client";

/**
 * Boundary d'erreur global (App Router) : une exception de rendu sur une page
 * ne doit JAMAIS laisser l'utilisateur sur l'écran de crash brut de Next.js.
 * Le bouton Réessayer remonte l'erreur côté client ; le bouton Tableau de bord
 * offre une issue quand la page elle-même est cassée.
 */

export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const digest = error?.digest ? String(error.digest).slice(0, 16) : null;

  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <div style={{ minHeight: "100vh", background: "#f6f4ef", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ maxWidth: 480, width: "100%", background: "#fff", borderRadius: 24, padding: 32, textAlign: "center", border: "1px solid rgba(23,23,20,0.09)", boxShadow: "0 14px 40px -18px rgba(28,27,24,0.22)" }}>
            <div style={{ width: 56, height: 56, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 16, background: "#fee2e2", fontSize: 28 }}>⚠️</div>
            <h1 style={{ marginTop: 20, fontSize: 22, fontWeight: 600, color: "#171714" }}>Une erreur inattendue est survenue</h1>
            <p style={{ marginTop: 12, fontSize: 14, lineHeight: "22px", color: "#737373" }}>
              La page n&apos;a pas pu s&apos;afficher complètement. Vos données et vos agents ne sont pas affectés — vous pouvez réessayer tout de suite.
            </p>
            {digest ? (
              <p style={{ marginTop: 8, fontSize: 12, color: "#a3a3a3" }}>
                Référence d&apos;erreur : <code>{digest}</code>
              </p>
            ) : null}
            <div style={{ marginTop: 24, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={reset}
                style={{ padding: "10px 22px", borderRadius: 9999, background: "#0ea5e9", color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                Réessayer
              </button>
              <a
                href="/dashboard"
                style={{ padding: "10px 22px", borderRadius: 9999, background: "transparent", color: "#171714", border: "1px solid rgba(23,23,20,0.15)", fontSize: 14, fontWeight: 600, textDecoration: "none" }}
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
