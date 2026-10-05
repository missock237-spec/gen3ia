import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrous structurels du LOT UX & accessibilité (Task 3-d, d'après l'audit
 * UX/a11y 2-c). Convention du dépôt : ces tests lisent les sources pour
 * empêcher toute régression (cf. theme-consistency.test.ts,
 * pwa-consistency.test.ts).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("D1 — Formulaire auth : libellé pending fidèle au mode", () => {
  const form = read("components/auth/EmailAuthForm.tsx");

  it("une CONNEXION n'affiche plus « Création du profil… » (libellé conditionnel au mode)", () => {
    expect(form).toContain('pending ? (mode === "connexion" ? "Connexion…" : "Création du profil…")');
  });
});

describe("D2 — Dialog accessible (WCAG 2.4.3)", () => {
  const dialog = read("components/ui/dialog.tsx");

  it("le piège de focus cycle Tab (et Maj+Tab) dans le panneau", () => {
    expect(dialog).toContain('event.key === "Tab"');
    expect(dialog).toContain("event.shiftKey");
    expect(dialog).toContain("panel.contains(current)");
    expect(dialog).toContain('querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)');
  });

  it("le titre et la description sont reliés via aria-labelledby / aria-describedby (ids uniques)", () => {
    expect(dialog).toContain("aria-labelledby={titleId}");
    expect(dialog).toContain("aria-describedby={description ? descriptionId : undefined}");
    expect(dialog).toContain("useId()");
    expect(dialog).toContain('id={titleId}');
    expect(dialog).toContain('id={descriptionId}');
  });

  it("la fermeture Échap et la restauration du focus déclencheur restent en place", () => {
    expect(dialog).toContain('event.key === "Escape"');
    expect(dialog).toContain("previousFocus?.focus?.()");
  });

  it("l'API publique du composant est inchangée (tous les appelants compatibles)", () => {
    expect(dialog).toContain("open: boolean;");
    expect(dialog).toContain("onClose: () => void;");
    expect(dialog).toContain("title: string;");
    expect(dialog).toContain("description?: string;");
    expect(dialog).toContain("footer?: React.ReactNode;");
    expect(dialog).toContain("className?: string;");
  });
});

describe("D3 — Hors-ligne visible (réseaux instables)", () => {
  const banner = read("components/nav/offline-banner.tsx");
  const shell = read("components/nav/app-shell.tsx");

  it("la bannière écoute offline/online + les événements pwa-register vérifiés", () => {
    // Noms EXACTS émis par components/pwa-register.tsx (cf. audit 2-c) :
    // gen3ia:online et gen3ia:outbox-pending (il n'existe PAS de gen3ia:offline).
    expect(banner).toContain('addEventListener("offline"');
    expect(banner).toContain('addEventListener("online"');
    expect(banner).toContain('"gen3ia:online"');
    expect(banner).toContain('"gen3ia:outbox-pending"');
  });

  it("les libellés FR sont présents et annoncés aux lecteurs d'écran", () => {
    expect(banner).toContain("Hors ligne — les modifications seront envoyées au retour du réseau");
    expect(banner).toContain("De retour en ligne");
    expect(banner).toContain("Missions en attente d'envoi");
    expect(banner).toContain('role="status"');
    expect(banner).toContain('aria-live="polite"');
  });

  it("safe-area-inset-bottom respectée (PWA iOS standalone) + habillage par tokens", () => {
    expect(banner).toContain("env(safe-area-inset-bottom)");
    expect(banner).toContain("var(--g3-warning-soft)");
  });

  it("montée dans l'app authentifiée via AppShell (layout racine intact)", () => {
    expect(shell).toContain('!chrome && <OfflineBanner />');
  });
});

describe("D4 — Monnaie XAF (0 décimale)", () => {
  const hub = read("components/marketplace/marketplace-hub.tsx");
  const fiche = read("app/marketplace/[id]/page.tsx");

  it("plus aucun /100 manuel + suffixe XAF dans la marketplace (helper centralisé)", () => {
    expect(hub).toContain('from "@/lib/ui/money"');
    expect(hub).not.toMatch(/amountMinor [\s\S]{0,40}\.toLocaleString/);
    expect(fiche).toContain('from "@/lib/ui/money"');
    expect(fiche).not.toContain('toLocaleString("fr-FR")} ${pricing.currency');
  });
});

describe("D5 — Cibles tactiles 44px", () => {
  it("theme-toggle passe de h-9 à h-11 (44px)", () => {
    const toggle = read("components/ui/theme-toggle.tsx");
    expect(toggle).toContain('compact ? "h-11 w-11" : "h-11 w-full px-3 sm:w-11"');
    expect(toggle).not.toContain("h-9");
  });

  it("composer de prompt : joindre/capacités/voix/envoyer à 44px", () => {
    const composer = read("components/ui/chatgpt-prompt-input.tsx");
    expect(composer).toContain('className="grid h-11 w-11 place-items-center rounded-full text-[var(--g3-muted)] transition hover:bg-[var(--g3-elevated)] hover:text-[var(--g3-text)] disabled:opacity-30" aria-label="Joindre un fichier"');
    expect(composer).toContain('aria-label="Voix"><MicIcon');
    expect(composer).toContain('aria-label="Envoyer"><SendIcon');
    expect(composer).not.toContain("h-9");
  });

  it("liste de conversations : replier/déplier/nouvelle conversation à 44px", () => {
    const list = read("components/workspace/conversation-list.tsx");
    expect(list).toContain("g3-btn g3-btn-ghost h-11 w-11 justify-center !px-0");
    expect(list).toContain("g3-btn g3-btn-primary h-11 w-11 justify-center !px-0");
    expect(list).not.toContain("h-9 w-9");
  });

  it("menu mobile flottant passé de 38px à 44px (+ dégagement du fil d'Ariane)", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.g3-mobile-menu \{[\s\S]{0,400}width: 44px;[\s\S]{0,80}height: 44px;/);
    expect(css).toContain("padding: 14px 64px 0 64px;");
  });
});

describe("D6 — Metadata SEO des segments publics", () => {
  it("marketplace : layout serveur avec title exact, description FR et openGraph", () => {
    const layout = read("app/marketplace/layout.tsx");
    expect(layout).toContain('absolute: "Marketplace — Gen3ia"');
    expect(layout).toContain("openGraph:");
    expect(layout).toContain('locale: "fr_FR"');
    // Un layout imbriqué ne redéclare JAMAIS html/body (App Router).
    expect(layout).not.toContain("<html>");
    expect(layout).not.toContain("<body>");
  });

  it("studio : metadata servie par le layout serveur (le shell client est déplacé, pas supprimé)", () => {
    const layout = read("app/studio/layout.tsx");
    const client = read("app/studio/studio-layout-client.tsx");
    expect(layout).toContain('absolute: "Studio — Gen3ia"');
    expect(layout).toContain("<StudioLayoutClient>");
    expect(client).toContain('"use client"');
    expect(client).toContain("<WorkspaceShell />");
    expect(layout).not.toContain("<html>");
  });
});

describe("D7 — loading.tsx de perception de vitesse", () => {
  const segments = ["dashboard", "billing", "settings", "memory", "team", "admin", "live", "marketplace"];

  it("chaque segment applicatif possède un skeleton cohérent (partagé ou inline)", () => {
    for (const segment of segments) {
      const source = read(`app/${segment}/loading.tsx`);
      const shared = source.includes("Skeleton");
      const inline = source.includes("var(--g3-elevated)") || source.includes("aria-busy");
      expect(
        shared || inline,
        `skeleton manquant/incohérent : app/${segment}/loading.tsx`,
      ).toBe(true);
    }
  });
});

describe("D8 — 404 : deux issues distinctes", () => {
  it("« Tableau de bord » pointe /dashboard, « Ouvrir le Studio » pointe /studio", () => {
    const page = read("app/not-found.tsx");
    expect(page).toContain('href="/dashboard"');
    expect(page).toContain('href="/studio"');
  });
});

describe("D9 — PWA installée : safe-area top + installation in-app (Task 99-c)", () => {
  it("globals.css : bloc @media (display-mode: standalone) décale le menu ☰ au-dessus de la notch", () => {
    const css = read("app/globals.css");
    const block = css.match(/@media \(display-mode: standalone\) \{[\s\S]*?\n\}/);
    expect(block, "bloc standalone manquant dans app/globals.css").not.toBeNull();
    expect(block?.[0]).toContain(".g3-mobile-menu");
    expect(block?.[0]).toContain("env(safe-area-inset-top)");
    // La cloche de notifications (classe posée côté composant par 99-b)
    // et le squelette app-shell sont couverts par le même bloc.
    expect(block?.[0]).toContain(".g3-notification-bell");
    expect(block?.[0]).toContain(".g3-shell-skeleton");
  });

  it("app-shell : le squelette du centre de notifications porte l'ancre g3-shell-skeleton", () => {
    const shell = read("components/nav/app-shell.tsx");
    expect(shell).toContain("g3-shell-skeleton");
  });

  it("app/studio/loading.tsx et app/developer/loading.tsx existent avec le squelette conventionnel", () => {
    for (const segment of ["studio", "developer"]) {
      const source = read(`app/${segment}/loading.tsx`);
      const shared = source.includes("Skeleton");
      const inline = source.includes("var(--g3-elevated)") || source.includes("aria-busy");
      expect(
        shared || inline,
        `skeleton manquant/incohérent : app/${segment}/loading.tsx`,
      ).toBe(true);
    }
  });

  it("install-button : beforeinstallprompt, navigator.standalone et appinstalled gérés", () => {
    const button = read("components/pwa/install-button.tsx");
    expect(button).toContain('"beforeinstallprompt"');
    expect(button).toContain("navigator.standalone");
    expect(button).toContain('"appinstalled"');
    // Le bouton ne réapparaît jamais en mode application installée.
    expect(button).toContain('(display-mode: standalone)');
  });

  it("les Paramètres exposent la section « Application » avec état + instructions iOS", () => {
    const settings = read("app/settings/page.tsx");
    expect(settings).toContain("PwaInstallSection");
    const section = read("components/settings/pwa-install-section.tsx");
    expect(section).toContain("Application installée");
    expect(section).toContain("Navigateur");
    expect(section).toContain("Sur l&apos;écran d&apos;accueil");
  });
});
