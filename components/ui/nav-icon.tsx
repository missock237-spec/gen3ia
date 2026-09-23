/**
 * NavIcon — icônes vectorielles cohérentes (trait 1.75px, style « Lucide »)
 * pour toute la navigation Gen3ia.
 *
 * Le NavRegistry stocke historiquement des glyphes Unicode (✦, ▦, ◎…). Ce
 * composant les remplace par des SVG nets et homogènes : résolution d'abord
 * par route (href), puis par glyphe, avec repli sur le glyphe d'origine.
 */

const P = {
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5",
  library: "M4 19.5V5a2 2 0 0 1 2-2h13v16H6.5A2.5 2.5 0 0 0 4 21.5M8 7h7M8 11h5",
  target: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  store: "M3 9l1.5-5h15L21 9M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 21v-6h6v6",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  brain: "M12 5a3 3 0 0 0-5.8-1A3 3 0 0 0 4 8.5a3.5 3.5 0 0 0 .5 6.3A3 3 0 0 0 9 19a3 3 0 0 0 3-2M12 5a3 3 0 0 1 5.8-1A3 3 0 0 1 20 8.5a3.5 3.5 0 0 1-.5 6.3A3 3 0 0 1 15 19a3 3 0 0 1-3-2M12 5v12",
  card: "M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20M6 15h4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  plus: "M12 5v14M5 12h14",
  key: "M15.5 7.5a4.5 4.5 0 1 1-6.4 6.4 4.5 4.5 0 0 1 6.4-6.4zM15.5 7.5 21 2M18 5l2 2",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  terminal: "M4 17l6-5-6-5M12 19h8",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  sparkles: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  play: "M6 4l14 8-14 8z",
  scale: "M12 3v18M5 21h14M3 7h18M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  layers: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
} as const;

type IconName = keyof typeof P;

const BY_HREF: Record<string, IconName> = {
  "/workspace": "chat",
  "/workspace/projects": "folder",
  "/workspace/files": "file",
  "/workspace/connectors": "plug",
  "/workspace/bibliotheque": "library",
  "/studio": "target",
  "/team": "users",
  "/live": "monitor",
  "/marketplace": "store",
  "/studio/schedules": "clock",
  "/memory": "brain",
  "/billing": "card",
  "/settings": "settings",
  "/studio/agents": "sparkles",
  "/observability": "activity",
  "/integrations": "layers",
  "/developer": "code",
  "/admin": "shield",
};

const BY_GLYPH: Record<string, IconName> = {
  "✦": "sparkles", "▦": "folder", "□": "file", "⧉": "plug", "◈": "library",
  "◎": "users", "◉": "monitor", "◇": "store", "◷": "clock", "◆": "brain",
  "₣": "card", "⚙": "settings", "⌂": "home", "＋": "plus", "⚿": "key",
  "∿": "activity", "❯_": "terminal", "⌥": "code", "⛨": "shield", "▶": "play",
  "⚖": "scale",
};

export function NavIcon({
  glyph,
  href,
  size = 16,
  className,
}: {
  glyph?: string;
  href?: string;
  size?: number;
  className?: string;
}) {
  const name = (href && BY_HREF[href]) || (glyph && BY_GLYPH[glyph]) || null;
  if (!name) return <span className={className} aria-hidden="true">{glyph}</span>;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={P[name]} />
    </svg>
  );
}
