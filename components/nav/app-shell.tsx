"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Breadcrumbs } from "@/components/nav/breadcrumbs";
import { OfflineBanner } from "@/components/nav/offline-banner";
import { ScrollTop } from "@/components/nav/scroll-top";
import { isImmersiveChatRoute } from "@/lib/ui/chat-surface";

/**
 * Task 96-d (budget bundle /layout à 100 %) : AppNav et NotificationCenter
 * sont chargés À LA DEMANDE (chunks séparés, téléchargés après le JS
 * principal) au lieu de gonfler le chunk partagé de TOUTES les routes.
 * ssr:false assumé : ces deux composants ne produisent rien d'utile au
 * premier paint serveur (AppNav attend le rôle renvoyé par /api/auth/access,
 * NotificationCenter attend la session Firebase) et n'existent que côté
 * client.
 *
 * Squelettes de MÊMES dimensions que les cibles (sidebar .g3-sidebar vide,
 * pastille fixe 40×40 au même emplacement) : aucun décalage de mise en page
 * pendant le chargement des chunks.
 */

/** Squelette AppNav : l'aside vide porte la même classe de mise en page que
 * la vraie sidebar — largeur et position réservées dès la première peinture. */
function AppNavSkeleton() {
  return <aside className="g3-sidebar" aria-hidden="true" />;
}

/** Squelette NotificationCenter : pastille fixe (h-10 w-10, right/top
 * identiques au bouton cloche) — position:fixed, zéro impact sur le flux.
 * La classe g3-shell-skeleton sert d'ancre au bloc safe-area top standalone
 * (globals.css section 16) : en PWA installée la pastille passe sous la
 * notch iOS sinon. */
function NotificationCenterSkeleton() {
  return (
    <div className="g3-shell-skeleton fixed right-3 top-2.5 z-[70] sm:right-4" aria-hidden="true">
      <div className="h-10 w-10 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)]" />
    </div>
  );
}

const AppNav = dynamic(
  () => import("@/components/nav/app-nav").then((m) => m.AppNav),
  { ssr: false, loading: () => <AppNavSkeleton /> },
);

const NotificationCenter = dynamic(
  () =>
    import("@/components/notifications/notification-center").then(
      (m) => m.NotificationCenter,
    ),
  { ssr: false, loading: () => <NotificationCenterSkeleton /> },
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isVitrine = pathname === "/";
  const isAuth = pathname === "/login" || pathname === "/signup";
  const isApproval = pathname.startsWith("/approvals");
  const isClient = pathname === "/client" || pathname.startsWith("/client/");
  const chrome = isVitrine || isAuth || isApproval || isClient;
  // Surfaces de chat immersives (conversation + chat d'agent IA) : l'interface
  // de discussion prend toute la hauteur de l'appareil — pas de fil d'Ariane,
  // et la chaîne de hauteur (#g3-main-content en h-full) est propagée jusqu'au
  // chat pour que le fil défile en interne et que le composer reste en bas.
  const immersiveChat = isImmersiveChatRoute(pathname);

  return (
    <div className="g3-shell flex overflow-hidden">
      <a href="#g3-main-content" className="g3-skip-link">
        Aller au contenu principal
      </a>
      {!chrome && (
        <>
          <AppNav />
          <button
            type="button"
            aria-label="Ouvrir le menu principal"
            onClick={() => window.dispatchEvent(new Event("gen3ia:open-nav"))}
            className="g3-mobile-menu"
          >
            <span aria-hidden="true">☰</span>
          </button>
        </>
      )}
      <main
        id="g3-scroll"
        tabIndex={-1}
        className="g3-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        {!chrome && !immersiveChat && <Breadcrumbs />}
        <div id="g3-main-content" className={immersiveChat ? "h-full" : undefined}>{children}</div>
      </main>
      {/* Centre de notifications (validation à distance des actions sensibles) :
          disponible sur toutes les pages applicatives, même hors des chats. */}
      {!chrome && <NotificationCenter />}
      {/* Bannière hors-ligne (réseaux instables) : uniquement dans l'app
          authentifiée — la vitrine et l'auth restent épurées. */}
      {!chrome && <OfflineBanner />}
      <ScrollTop />
    </div>
  );
}
