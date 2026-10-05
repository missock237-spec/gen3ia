/**
 * Logo officiel Gen3ia — SVG inline (lot C4, audit perf 2-a) : fond sombre
 * arrondi, lettre « G » stylée en dégradé de marque violet → magenta → cyan
 * (--g3-gradient de app/globals.css) et point d'orbite. ~2 Ko rendus au lieu
 * de l'icône PNG 39 Ko (icon-192.png) — les PNG restent la source PWA /
 * manifest / favicon, ce composant ne sert plus que l'interface.
 *
 * Source unique de vérité de la marque dans TOUTE l'interface :
 * navigation latérale, vitrine publique, pages d'authentification,
 * marketplace, espace développeur, et pendant l'exécution des tâches
 * d'agents (prop `working` → halo pulsé, l'agent est en train de travailler).
 */

export function Gen3iaLogo({
  size = 36,
  working = false,
  className = "",
  alt = "Logo Gen3ia",
}: {
  /** Taille en pixels (carré). */
  size?: number;
  /** Pendant l'exécution d'une tâche : halo pulsé animé. */
  working?: boolean;
  className?: string;
  alt?: string;
}) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className={`g3-logo ${working ? "g3-logo--working" : ""} ${className}`}
      style={{ width: size, height: size }}
    >
      <defs>
        {/* Dégradé de marque (--g3-gradient, thème sombre) : violet → magenta → cyan. */}
        <linearGradient id="g3-logo-gradient" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7C5CFF" />
          <stop offset="0.5" stopColor="#C44BFF" />
          <stop offset="1" stopColor="#2AD4E8" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="11.5" fill="#0B0D1A" />
      <rect x="1.5" y="1.5" width="45" height="45" rx="11.5" fill="none" stroke="url(#g3-logo-gradient)" strokeOpacity="0.5" strokeWidth="1.5" />
      {/* Lettre G : arc ouvert à droite (sens antihoraire) + barre horizontale. */}
      <path
        d="M31.9 16.2 A11 11 0 1 0 34.9 26 L26 26"
        fill="none"
        stroke="url(#g3-logo-gradient)"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Point d'orbite de l'icône d'origine (nœud du réseau). */}
      <circle cx="37.6" cy="10.4" r="2.6" fill="url(#g3-logo-gradient)" />
    </svg>
  );
}
