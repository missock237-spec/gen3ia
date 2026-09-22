"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authFetch, logout, useAuth } from "@/lib/firebase/auth-client";

import { CommandPalette } from "./command-palette";
import { NAV_GROUPS, type NavItem } from "./nav-items";

type PlatformRole = "user" | "developer" | "admin";

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [platformRole, setPlatformRole] = useState<PlatformRole>("user");

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("gen3ia:open-nav", handler);
    return () => window.removeEventListener("gen3ia:open-nav", handler);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
        return;
      }
      if (event.key === "Escape") {
        setAccountOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void authFetch("/api/auth/access", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { role?: PlatformRole };
        if (!cancelled && (data.role === "admin" || data.role === "developer" || data.role === "user")) {
          setPlatformRole(data.role);
        }
      })
      .catch(() => {
        if (!cancelled) setPlatformRole("user");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (pathname === "/") return null;

  const canDeveloper = platformRole === "developer" || platformRole === "admin";
  const name =
    user?.displayName?.trim() || user?.email?.split("@")[0] || "Compte";
  const initial = name.charAt(0).toUpperCase();
  const active = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  const visibleGroups = NAV_GROUPS
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.requiredRole !== "developer" || canDeveloper),
    }))
    .filter((group) => group.items.length > 0);

  const NavGroup = ({
    title,
    items,
  }: {
    title: string;
    items: NavItem[];
  }) => (
    <div className="g3-nav-group">
      {!compact && <p className="g3-nav-group-title">{title}</p>}
      <div className="space-y-1">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            title={compact ? item.label : undefined}
            aria-current={active(item.href) ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={
              "g3-side-link " + (active(item.href) ? "is-active" : "")
            }
          >
            <span className="g3-side-icon" aria-hidden="true">{item.icon}</span>
            {!compact && (
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.hint && <span className="g3-nav-hint">{item.hint}</span>}
              </span>
            )}
            {!compact && item.shortcut && (
              <kbd className="g3-nav-shortcut">{item.shortcut}</kbd>
            )}
          </Link>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        canDeveloper={canDeveloper}
      />
      <div
        className={"g3-sidebar-backdrop " + (open ? "is-open" : "")}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      <aside className={
        "g3-sidebar " + (open ? "is-open " : "") + (compact ? "is-compact" : "")
      }>
        <div className="flex h-full flex-col">
          <div className="g3-nav-header">
            <Link href="/dashboard" className="g3-brand" onClick={() => setOpen(false)}>
              <span className="g3-brand-mark">G3</span>
              {!compact && <span className="g3-brand-name">Gen3ia</span>}
            </Link>
            <button
              type="button"
              className="g3-nav-toggle"
              onClick={() => setCompact((value) => !value)}
              aria-label={compact ? "Développer la navigation" : "Réduire la navigation"}
              title={compact ? "Développer" : "Réduire"}
            >
              {compact ? "›" : "‹"}
            </button>
          </div>

          <div className="px-2.5 pt-3">
            <Link
              href="/studio"
              onClick={() => setOpen(false)}
              className={"g3-new-task " + (compact ? "is-compact" : "")}
              title={compact ? "Nouvelle tâche" : undefined}
            >
              <span>+</span>
              {!compact && <><strong>Nouvelle tâche</strong><kbd>⌘ K</kbd></>}
            </Link>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className={"g3-nav-search " + (compact ? "is-compact" : "")}
              aria-label="Rechercher une destination"
            >
              <span aria-hidden="true">⌕</span>
              {!compact && <><span className="min-w-0 flex-1 truncate text-left">Rechercher une destination…</span><kbd>⌘K</kbd></>}
            </button>
          </div>

          <nav className="g3-nav-scroll flex-1 space-y-5 px-2.5 py-4" aria-label="Navigation principale">
            {visibleGroups.map((group) => (
              <NavGroup key={group.title} title={group.title} items={group.items} />
            ))}
          </nav>

          <div className="g3-nav-footer">
            <div className="relative">
              {accountOpen && (
                <div className={"g3-account-menu " + (compact ? "is-compact" : "")}>
                  {confirmDelete ? (
                    <div className="space-y-1">
                      <p className="px-2 py-1 text-[10px] font-semibold leading-4 text-red-600">
                        Supprimer définitivement votre compte et toutes vos données ?
                      </p>
                      <button
                        type="button"
                        className="g3-account-item danger font-semibold"
                        disabled={deleting}
                        onClick={async () => {
                          setDeleting(true);
                          try {
                            const response = await authFetch("/api/auth/account", { method: "DELETE" });
                            if (!response.ok) {
                              const data = await response.json().catch(() => ({}));
                              throw new Error(data.error ?? "Suppression impossible.");
                            }
                            await logout();
                            router.push("/login");
                          } catch {
                            setDeleting(false);
                            setConfirmDelete(false);
                          }
                        }}
                      >
                        {deleting ? "Suppression…" : "Oui, tout supprimer"}
                      </button>
                      <button type="button" className="g3-account-item" onClick={() => setConfirmDelete(false)}>
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <>
                      {canDeveloper && (
                        <Link href="/developer" onClick={() => setAccountOpen(false)} className="g3-account-item">
                          Developer Studio
                        </Link>
                      )}
                      <Link href="/settings" onClick={() => setAccountOpen(false)} className="g3-account-item">
                        Paramètres
                      </Link>
                      <Link href="/team" onClick={() => setAccountOpen(false)} className="g3-account-item">
                        Équipe
                      </Link>
                      <Link href="/privacy" onClick={() => setAccountOpen(false)} className="g3-account-item">
                        Politique de confidentialité
                      </Link>
                      <button
                        type="button"
                        className="g3-account-item danger"
                        onClick={() => setConfirmDelete(true)}
                      >
                        Supprimer le compte
                      </button>
                      <button
                        type="button"
                        className="g3-account-item"
                        onClick={async () => {
                          setAccountOpen(false);
                          await logout();
                          router.push("/login");
                        }}
                      >
                        Se déconnecter
                      </button>
                    </>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => setAccountOpen((value) => !value)}
                className={"g3-account-button " + (compact ? "is-compact" : "")}
                aria-expanded={accountOpen}
              >
                <span className="g3-account-avatar">{initial}</span>
                {!compact && (
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs font-semibold">{name}</span>
                    <span className="block truncate text-[10px] text-neutral-400">
                      {user?.email || "Session Gen3ia"}
                    </span>
                  </span>
                )}
                <span className="text-neutral-400">•••</span>
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
