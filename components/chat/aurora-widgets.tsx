"use client";

import type { ReactNode } from "react";

/**
 * Widgets purs du chat Aurora (/chat) : icônes, écran d'accueil, carte
 * d'authentification et utilitaires de formatage. Aucune donnée métier —
 * le composant principal (aurora-chat.tsx) orchestre l'état et le flux.
 */

/* ================= Icônes SVG ================= */

const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const Icones = {
  envoi: (
    <svg {...svgProps} strokeWidth={2.5}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
  stop: <svg {...svgProps}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></svg>,
  copie: (
    <svg {...svgProps}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  regen: (
    <svg {...svgProps}>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  ),
  edit: (
    <svg {...svgProps}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
  exportMd: (
    <svg {...svgProps}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  ),
  burger: (
    <svg {...svgProps}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  ),
  trombone: (
    <svg {...svgProps}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  ),
  outils: (
    <svg {...svgProps}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.6-.6-2.1 2.5-2.5z" />
    </svg>
  ),
  chevron: (
    <svg {...svgProps} strokeWidth={2.5}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  bas: (
    <svg {...svgProps} strokeWidth={2.5}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  ),
};

/* ================= Utilitaires ================= */

export function formaterTaille(octets: number): string {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

export function iconePourNom(nom: string): string {
  const ext = (nom.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["xlsx", "csv"].includes(ext)) return "📊";
  if (ext === "docx") return "📘";
  if (ext === "pptx") return "📙";
  if (["json", "md", "txt"].includes(ext)) return "📝";
  if (["zip", "rar", "7z"].includes(ext)) return "🗜️";
  return "📎";
}

/** Groupe temporel de la sidebar (même découpage que l'interface d'origine). */
export function groupeDe(ts: number | string): string {
  const date = typeof ts === "number" ? ts : new Date(ts).getTime();
  const maintenant = new Date();
  const ceJour = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate()).getTime();
  const jour = 86_400_000;
  if (date >= ceJour) return "Aujourd'hui";
  if (date >= ceJour - jour) return "Hier";
  if (date >= ceJour - 7 * jour) return "7 derniers jours";
  return "Plus ancien";
}

export function heureFr(ts: number | string): string {
  const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/* ================= Suggestions de suivi ================= */

/**
 * Suggestions de suivi affichées après une réponse : priorité au champ
 * `suggestions` généré par le serveur (moteur conversationnel), repli
 * heuristique sur le contenu (même logique que l'interface d'origine).
 */
export function suggestionsPour(dernierContenu: string): string[] {
  const t = dernierContenu.toLowerCase();
  if (t.includes("n8n") || t.includes("workflow")) {
    return ["Ajoute une étape de notification", "Exporte ce workflow en JSON", "Explique chaque nœud"];
  }
  if (t.includes("tiktok") || t.includes("vidéo")) {
    return ["Écris le script complet de la vidéo 1", "Propose 5 légendes", "Quel format pour les Shorts ?"];
  }
  if (t.includes("relance") || t.includes("message")) {
    return ["Version plus courte", "Version plus ferme", "Ajoute une relance J+7"];
  }
  return ["Résume en 3 points", "Donne-moi un exemple concret", "Quelle est la prochaine étape ?"];
}

/* ================= Écran d'accueil ================= */

const CARTES_ACCUEIL = [
  {
    suggestion: "Rédige un message de relance client poli pour un restaurant",
    ico: "✉️",
    titre: "Relance client",
    desc: "Un message court et poli",
  },
  {
    suggestion: "Crée un workflow n8n simple qui enregistre les leads dans Google Sheets",
    ico: "⚡",
    titre: "Workflow n8n",
    desc: "Automatiser en 3 étapes",
  },
  {
    suggestion: "Propose 3 idées de vidéos TikTok sur l'IA pour débutants",
    ico: "🎬",
    titre: "Idées TikTok",
    desc: "Hooks et formats viraux",
  },
  {
    suggestion: "Résume ce que fait Gen3ia en quelques phrases",
    ico: "🚀",
    titre: "Présenter Gen3ia",
    desc: "Un résumé clair du produit",
  },
] as const;

export function WelcomeAurora({ onSuggestion }: { onSuggestion: (texte: string) => void }) {
  return (
    <div className="welcome">
      <div className="welcome-logo">✨</div>
      <h2>Comment puis-je t&apos;aider ?</h2>
      <p>Pose une question, joins un fichier ou choisis une suggestion.</p>
      <div className="cartes">
        {CARTES_ACCUEIL.map((carte) => (
          <button key={carte.titre} type="button" className="carte" onClick={() => onSuggestion(carte.suggestion)}>
            <div className="carte-ico">{carte.ico}</div>
            <div className="carte-titre">{carte.titre}</div>
            <div className="carte-desc">{carte.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ================= Carte connexion requise ================= */

export function CarteAuth() {
  return (
    <div className="carte-auth">
      <h3>Connecte-toi pour discuter</h3>
      <p>
        Le chat Gen3ia garde tes conversations dans ton espace personnel.
        Crée un compte ou connecte-toi pour commencer — c&apos;est inclus.
      </p>
      <div className="actions">
        <a className="btn-plein" href="/login">
          Se connecter
        </a>
        <a className="btn-contour" href="/signup">
          Créer un compte
        </a>
      </div>
    </div>
  );
}

/* ================= Ligne d'état système (fil) ================= */

export function CarteSysteme({
  ico,
  children,
  erreur = false,
}: {
  ico: string;
  children: ReactNode;
  erreur?: boolean;
}) {
  return (
    <div className={`carte-systeme${erreur ? " carte-erreur" : ""}`}>
      <span className="ico" aria-hidden>
        {ico}
      </span>
      <div>{children}</div>
    </div>
  );
}
