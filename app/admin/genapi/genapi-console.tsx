"use client";

import { useCallback, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { StatusBadge } from "@/components/shells/status-badge";
import type { ClientGenAPI, EntreeJournalGenAPI, StatutGenAPI } from "@/lib/genapi/types";

/**
 * Console genAPI (Agent OS gRPC) — interactions admin : provisionnement de
 * clients mTLS, révocation, livraison du paquet à usage unique et journal.
 * Les données initiales sont lues côté serveur (page.tsx lit directement le
 * socle lib/genapi) ; les actions passent par /api/admin/genapi.
 */

interface GenAPIConsoleProps {
  statutInitial: StatutGenAPI | null;
  clientsInitiaux: ClientGenAPI[];
  journalInitial: EntreeJournalGenAPI[];
  erreurInitiale: string;
}

interface LivraisonPaquet {
  uid: string;
  email: string;
  jeton: string;
  expireA: string;
}

/** Convention /billing : montant en minor / 100, format fr-FR, devise XAF. */
function formatDevise(minor: number): string {
  return `${(minor / 100).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} XAF`;
}

/** Empreinte SHA-256 tronquée façon ab12…ef90 — jamais affichée en entier. */
function tronquerEmpreinte(empreinte: string): string {
  return empreinte.length > 8 ? `${empreinte.slice(0, 4)}…${empreinte.slice(-4)}` : empreinte;
}

function formatDate(valeur: string | undefined): string {
  if (!valeur) return "—";
  const date = new Date(valeur);
  return Number.isNaN(date.getTime())
    ? valeur
    : date.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const CARTE = "rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6";
const TITRE = "font-serif text-lg font-semibold text-[var(--g3-text)]";
const CHAMP =
  "w-full rounded-lg border border-white/10 bg-[var(--g3-deep)]/60 px-3 py-2 text-sm text-[var(--g3-text-secondary)] outline-none focus:border-[var(--g3-primary-border)] placeholder:text-[var(--g3-faint)]";

export function GenAPIConsole({ statutInitial, clientsInitiaux, journalInitial, erreurInitiale }: GenAPIConsoleProps) {
  const [statut, setStatut] = useState<StatutGenAPI | null>(statutInitial);
  const [clients, setClients] = useState<ClientGenAPI[]>(clientsInitiaux);
  const [journal, setJournal] = useState<EntreeJournalGenAPI[]>(journalInitial);

  const [uid, setUid] = useState("");
  const [email, setEmail] = useState("");
  const [enProvisionnement, setEnProvisionnement] = useState(false);
  const [enRevocation, setEnRevocation] = useState<string | null>(null);
  const [enActualisation, setEnActualisation] = useState(false);
  const [livraison, setLivraison] = useState<LivraisonPaquet | null>(null);
  const [copie, setCopie] = useState(false);
  const [messageErreur, setMessageErreur] = useState("");
  const [noticeInfo, setNoticeInfo] = useState("");

  /** Recharge clients + statut + journal après une action (best-effort). */
  const recharger = useCallback(async () => {
    setEnActualisation(true);
    try {
      const [repClients, repStatut] = await Promise.all([
        authFetch("/api/admin/genapi/clients", { cache: "no-store" }),
        authFetch("/api/admin/genapi/statut", { cache: "no-store" }),
      ]);
      if (repClients.ok) {
        const corps = (await repClients.json()) as { clients?: ClientGenAPI[] };
        setClients(corps.clients ?? []);
      }
      if (repStatut.ok) {
        const corps = (await repStatut.json()) as { statut?: StatutGenAPI | null; journal?: EntreeJournalGenAPI[] };
        setStatut(corps.statut ?? null);
        setJournal(corps.journal ?? []);
      }
    } catch {
      /* Les données affichées restent en place en cas de panne réseau. */
    } finally {
      setEnActualisation(false);
    }
  }, []);

  const provisionner = async () => {
    setMessageErreur("");
    setNoticeInfo("");
    if (!uid.trim() || !email.trim()) {
      setMessageErreur("Renseignez l'identifiant utilisateur (uid) et l'email du client avant de provisionner.");
      return;
    }
    setEnProvisionnement(true);
    try {
      const response = await authFetch("/api/admin/genapi/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "provisionner", uid: uid.trim(), email: email.trim() }),
      });
      const corps = (await response.json()) as {
        ok?: boolean;
        jetonTelechargement?: string;
        expireA?: string;
        erreur?: string;
        error?: string;
      };
      if (!response.ok) {
        setMessageErreur(corps.error ?? `Provisionnement impossible (erreur ${response.status}).`);
        return;
      }
      if (!corps.ok) {
        // Refus métier du socle (CA indisponible, budget Chariow…) — honnête.
        setMessageErreur(`Provisionnement refusé : ${corps.erreur ?? "le socle genAPI a refusé la demande."}`);
        return;
      }
      if (corps.jetonTelechargement) {
        setLivraison({ uid: uid.trim(), email: email.trim(), jeton: corps.jetonTelechargement, expireA: corps.expireA ?? "" });
        setCopie(false);
      }
      setUid("");
      setEmail("");
      await recharger();
    } catch {
      setMessageErreur("genAPI indisponible : le provisionnement n'a pas abouti. Réessayez dans un instant.");
    } finally {
      setEnProvisionnement(false);
    }
  };

  const revoquer = async (cible: ClientGenAPI) => {
    if (
      !window.confirm(
        `Révoquer le certificat genAPI de ${cible.email} (${cible.uid}) ? Le client ne pourra plus se connecter au daemon.`,
      )
    ) {
      return;
    }
    setMessageErreur("");
    setNoticeInfo("");
    setEnRevocation(cible.uid);
    try {
      const response = await authFetch("/api/admin/genapi/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoquer", uid: cible.uid }),
      });
      const corps = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) {
        setMessageErreur(corps.error ?? `Révocation impossible (erreur ${response.status}).`);
        return;
      }
      setNoticeInfo(corps.ok ? `Certificat de ${cible.uid} révoqué.` : "Le socle genAPI n'a pas confirmé la révocation.");
      await recharger();
    } catch {
      setMessageErreur("genAPI indisponible : la révocation n'a pas abouti. Réessayez dans un instant.");
    } finally {
      setEnRevocation(null);
    }
  };

  const copierLien = async () => {
    if (!livraison) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/api/admin/genapi/paquets/${livraison.jeton}`);
      setCopie(true);
      window.setTimeout(() => setCopie(false), 2500);
    } catch {
      /* Presse-papiers indisponible : l'URL reste sélectionnable en clair. */
    }
  };

  return (
    <div className="space-y-7">
      <header>
        <h1 className="font-serif text-2xl font-semibold text-[var(--g3-text)] md:text-3xl">genAPI — Agent OS gRPC</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--g3-muted)]">
          Tunnels mTLS souverains pour gen3 : provisionnement de certificats clients par le Master Daemon, paquets à
          usage unique, facturation Chariow à l&apos;exécution.
        </p>
      </header>

      {erreurInitiale && (
        <div className="rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] p-4 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {erreurInitiale}
        </div>
      )}
      {messageErreur && (
        <div className="rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] p-4 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {messageErreur}
        </div>
      )}
      {noticeInfo && (
        <div className="rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] p-4 text-sm text-[var(--g3-success-strong)]" role="status">
          {noticeInfo}
        </div>
      )}

      {/* Carte STATUT — CA racine, compteurs du jour, crédits Chariow. */}
      <section aria-label="Statut du socle genAPI" className={CARTE}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={TITRE}>Statut du socle</h2>
          <button type="button" onClick={() => void recharger()} disabled={enActualisation} className="g3-btn">
            {enActualisation ? "Actualisation…" : "Actualiser"}
          </button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/50 p-4">
            <div className="text-xs font-medium uppercase tracking-[.14em] text-[var(--g3-faint)]">CA racine</div>
            <div className="mt-2 flex items-center gap-2 text-base font-bold text-[var(--g3-text)]">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: statut?.caDisponible ? "var(--g3-success)" : "var(--g3-danger)" }}
              />
              {statut ? (statut.caDisponible ? "Disponible" : "Indisponible") : "—"}
            </div>
            <div className="mt-1 text-xs text-[var(--g3-faint)]">Signature des certificats clients</div>
          </div>
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/50 p-4">
            <div className="text-xs font-medium uppercase tracking-[.14em] text-[var(--g3-faint)]">Clients</div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--g3-text)]">
              {statut ? `${statut.clientsActifs} / ${statut.clientsTotal}` : "—"}
            </div>
            <div className="mt-1 text-xs text-[var(--g3-faint)]">Actifs / total provisionnés</div>
          </div>
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/50 p-4">
            <div className="text-xs font-medium uppercase tracking-[.14em] text-[var(--g3-faint)]">Exécutions du jour</div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--g3-text)]">{statut ? statut.executions : "—"}</div>
            <div className="mt-1 text-xs text-[var(--g3-faint)]">Appels gRPC authentifiés</div>
          </div>
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/50 p-4">
            <div className="text-xs font-medium uppercase tracking-[.14em] text-[var(--g3-faint)]">Échecs du jour</div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--g3-text)]">{statut ? statut.echecs : "—"}</div>
            <div className="mt-1 text-xs text-[var(--g3-faint)]">À examiner si non nul</div>
          </div>
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/50 p-4">
            <div className="text-xs font-medium uppercase tracking-[.14em] text-[var(--g3-faint)]">Crédits débités</div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--g3-text)]">
              {statut ? formatDevise(statut.creditsDebitesMinor) : "—"}
            </div>
            <div className="mt-1 text-xs text-[var(--g3-faint)]">Facturation Chariow à l&apos;exécution</div>
          </div>
        </div>
      </section>

      {/* Bandeau de LIVRAISON — lien one-time après provisionnement réussi. */}
      {livraison && (
        <section aria-label="Livraison du paquet client" className="rounded-3xl border border-[var(--g3-info-border)] bg-[var(--g3-info-soft)] p-6">
          <h2 className={TITRE}>Paquet client prêt — {livraison.email}</h2>
          <p className="mt-1 text-sm text-[var(--g3-muted)]">
            Transmettez ce lien à usage unique à la machine cliente ({livraison.uid}). Expiration&nbsp;: {formatDate(livraison.expireA)}.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <code className="max-w-full overflow-x-auto rounded-lg border border-white/10 bg-[var(--g3-deep)]/60 px-3 py-2 font-mono text-xs text-[var(--g3-text-secondary)]">
              /api/admin/genapi/paquets/{livraison.jeton}
            </code>
            <button type="button" onClick={() => void copierLien()} className="g3-btn">
              {copie ? "Copié" : "Copier le lien"}
            </button>
            <a href={`/api/admin/genapi/paquets/${livraison.jeton}`} download className="g3-btn g3-btn-primary">
              Télécharger le paquet
            </a>
          </div>
          <div className="mt-4 rounded-2xl border border-[var(--g3-warning-border)] bg-[var(--g3-warning-soft)] p-4 text-sm leading-6 text-[var(--g3-warning-strong)]" role="note">
            La clé privée a été détruite du serveur après création du package (zéro fuite). Ce lien est à usage unique
            et expire dans 15 minutes.
          </div>
        </section>
      )}

      {/* Carte CLIENTS — registre + révocation par ligne. */}
      <section aria-label="Clients genAPI" className={CARTE}>
        <h2 className={TITRE}>Clients provisionnés</h2>
        {clients.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--g3-muted)]">
            Aucun client genAPI pour le moment. Provisionnez le premier ci-dessous.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">
                  <th scope="col" className="py-2 pr-4 font-medium">uid</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Email</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Empreinte</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Statut</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Créé</th>
                  <th scope="col" className="py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.uid} className="border-t border-[var(--g3-border)] text-[var(--g3-text-secondary)]">
                    <td className="py-3 pr-4 font-mono text-xs">{client.uid}</td>
                    <td className="py-3 pr-4">{client.email}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-[var(--g3-faint)]">{tronquerEmpreinte(client.empreinte)}</td>
                    <td className="py-3 pr-4">
                      <StatusBadge
                        status={client.statut === "actif" ? "active" : "revoked"}
                        label={client.statut === "actif" ? "Actif" : "Révoqué"}
                      />
                    </td>
                    <td className="py-3 pr-4 text-xs text-[var(--g3-faint)]">{formatDate(client.creeA)}</td>
                    <td className="py-3">
                      {client.statut === "actif" && (
                        <button
                          type="button"
                          onClick={() => void revoquer(client)}
                          disabled={enRevocation === client.uid}
                          className="g3-btn g3-btn-danger"
                        >
                          {enRevocation === client.uid ? "Révocation…" : "Révoquer"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Formulaire de provisionnement. */}
      <section aria-label="Provisionner un nouveau client" className={CARTE}>
        <h2 className={TITRE}>Provisionner un nouveau client</h2>
        <p className="mt-1 text-sm text-[var(--g3-muted)]">
          Crée un certificat client mTLS signé par le CA racine genAPI et un paquet à usage unique (facturation
          Chariow à l&apos;exécution).
        </p>
        <form
          className="mt-4 grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void provisionner();
          }}
        >
          <div>
            <label htmlFor="genapi-uid" className="mb-1.5 block text-xs font-semibold uppercase tracking-[.14em] text-[var(--g3-faint)]">
              Identifiant utilisateur (uid)
            </label>
            <input
              id="genapi-uid"
              value={uid}
              onChange={(event) => setUid(event.target.value)}
              placeholder="uid Firestore du client"
              className={CHAMP}
            />
          </div>
          <div>
            <label htmlFor="genapi-email" className="mb-1.5 block text-xs font-semibold uppercase tracking-[.14em] text-[var(--g3-faint)]">
              Email du client
            </label>
            <input
              id="genapi-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="client@exemple.com"
              className={CHAMP}
            />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={enProvisionnement} className="g3-btn g3-btn-primary">
              {enProvisionnement ? "Provisionnement en cours…" : "Provisionner"}
            </button>
          </div>
        </form>
      </section>

      {/* Journal des événements genAPI. */}
      <section aria-label="Journal genAPI" className={CARTE}>
        <h2 className={TITRE}>Journal</h2>
        {journal.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--g3-muted)]">Aucun événement journalisé pour le moment.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {journal.map((entree, index) => (
              <li
                key={`${entree.a}-${index}`}
                className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/50 p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--g3-text)]">{entree.evenement}</span>
                  <span className="text-xs text-[var(--g3-faint)]">{formatDate(entree.a)}</span>
                </div>
                <p className="mt-1 text-sm leading-6 text-[var(--g3-muted)]">{entree.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
