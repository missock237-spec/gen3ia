/**
 * Logo officiel Gen3ia — icône générée « réseau neuronal » (fond noir arrondi,
 * anneau dégradé magenta-cyan, nœuds connectés, orbite pointillée).
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
    // eslint-disable-next-line @next/next/no-img-element -- ressource locale /public, dimensions fixes, pas d'optimisation Next nécessaire
    <img
      src="/icons/icon-192.png"
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      className={`g3-logo ${working ? "g3-logo--working" : ""} ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
