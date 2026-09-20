"use client";

import { usePathname } from "next/navigation";
import { AppNav } from "@/components/nav/app-nav";
import { Breadcrumbs } from "@/components/nav/breadcrumbs";
import { ScrollTop } from "@/components/nav/scroll-top";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isVitrine = pathname === "/";
  const isAuth = pathname === "/login" || pathname === "/signup";
  const isApproval = pathname.startsWith("/approvals");
  const chrome = isVitrine || isAuth || isApproval;

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
        {!chrome && <Breadcrumbs />}
        <div id="g3-main-content">{children}</div>
      </main>
      <ScrollTop />
    </div>
  );
}
