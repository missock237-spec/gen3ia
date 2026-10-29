"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Vue compte « Mes extensions » — page /extensions (Job 478451, it. 31).
 *
 * Constat d'audit (garde anti-code-mort it. 29) : quatre endpoints du lot
 * marketplace existaient, testés et déployés, sans AUCUNE surface
 * utilisateur — l'utilisateur ne pouvait ni voir ses installations,
 * ni ses achats, ni ses licences, ni l'usage réel de ses extensions :
 *  - GET /api/extensions/installed — installations actives (détail extension) ;
 *  - GET /api/extensions/purchases — historique d'achats (montant, canal,
 *    statut : pending | paid | failed | refunded) ;
 *  - GET /api/extensions/licenses — clés de licence (statut, expiration) ;
 *  - GET /api/extensions/usage?extensionId=… — exécutions réelles par
 *    extension (403 si l'extension n'est pas installée : le serveur est
 *    la source de vérité, l'UI restitue l'erreur telle quelle).
 *
 * Honnêteté copiée du serveur : les achats affichent le canal réel
 * (Portefeuille ou Chariow — Chariow restant l'unique canal de paiement
 * externe de la plateforme) et le statut brut du serveur, sans
 * adoucissement. Aucune action d'achat ici : la page constate, elle ne
 * vend pas (le tunnel d'achat reste Facturation / fiches catalogue).
 *
 * Accessibilité : boutons natifs (aria-expanded pour l'usage), zone
 * role="status" pour les retours, aucun widget artificiel. Palette :
 * tokens g3-* existants UNIQUEMENT.
 */

type ExtensionResume = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  developerName?: string;
  latestVersion?: string;
  approvedVersion?: string | null;
};

type Installation = {
  id: string;
  extensionId: string;
  version: string;
  status: string;
  installedAt: number;
  extension: ExtensionResume | null;
};

type Achat = {
  id: string;
  extensionId: string;
  version?: string;
  provider: "wallet" | "chariow";
  amountMinor: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  kind: "one_time" | "subscription";
  createdAt: number;
  paidAt?: number | null;
  extension: { id: string; name: string } | null;
};

type Licence = {
  id: string;
  licenseKey: string;
  extensionId: string;
  status: string;
  expiresAt: number | null;
  createdAt: number;
  extension: { id: string; name: string } | null;
};

type Execution = {
  id: string;
  version: string;
  toolId: string;
  ok: boolean;
  status: string;
  durationMs: number;
  createdAt: number;
  error: string | null;
};

type Usage = {
  extension: { id: string; name: string };
  installation: { version: string; status: string };
  executions: Execution[];
};

const LIBELLES_STATUT_ACHAT: Record<Achat["status"], string> = {
  pending: "En attente",
  paid: "Payée",
  failed: "Échouée",
  refunded: "Remboursée",
};

const LIBELLES_CANAL: Record<Achat["provider"], string> = {
  wallet: "Portefeuille",
  chariow: "Chariow",
};

const LIBELLES_TYPE: Record<Achat["kind"], string> = {
  one_time: "Achat unique",
  subscription: "Abonnement",
};

function formaterMontant(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

function formaterDate(horodatage: number | null | undefined): string {
  if (!horodatage) return "—";
  return new Date(horodatage).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function ExtensionsAccount() {
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  const [achats, setAchats] = useState<Achat[] | null>(null);
  const [licences, setLicences] = useState<Licence[] | null>(null);
  const [erreurInitiale, setErreurInitiale] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [usageOuvert, setUsageOuvert] = useState<string | null>(null);
  const [usageParExtension, setUsageParExtension] = useState<Record<string, Usage>>({});
  const [usageEnCours, setUsageEnCours] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ton: "ok" | "erreur"; texte: string } | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreurInitiale(null);
    try {
      const [reponseInstallations, reponseAchats, reponseLicences] = await Promise.all([
        authFetch("/api/extensions/installed", { cache: "no-store" }),
        authFetch("/api/extensions/purchases", { cache: "no-store" }),
        authFetch("/api/extensions/licenses", { cache: "no-store" }),
      ]);
      if (!reponseInstallations.ok || !reponseAchats.ok || !reponseLicences.ok) {
        throw new Error("Lecture de vos extensions impossible.");
      }
      const corpsInstallations = (await reponseInstallations.json()) as { installations?: Installation[] };
      const corpsAchats = (await reponseAchats.json()) as { purchases?: Achat[] };
      const corpsLicences = (await reponseLicences.json()) as { licenses?: Licence[] };
      setInstallations(corpsInstallations.installations ?? []);
      setAchats(corpsAchats.purchases ?? []);
      setLicences(corpsLicences.licenses ?? []);
    } catch (cause) {
      setInstallations([]);
      setAchats([]);
      setLicences([]);
      setErreurInitiale(cause instanceof Error ? cause.message : "Lecture de vos extensions impossible.");
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  const basculerUsage = useCallback(
    async (extensionId: string) => {
      if (usageOuvert === extensionId) {
        setUsageOuvert(null);
        return;
      }
      setUsageOuvert(extensionId);
      setMessage(null);
      if (usageParExtension[extensionId]) return;
      setUsageEnCours(extensionId);
      try {
        const reponse = await authFetch(
          `/api/extensions/usage?extensionId=${encodeURIComponent(extensionId)}`,
          { cache: "no-store" },
        );
        const corps = (await reponse.json().catch(() => ({}))) as Partial<Usage> & { error?: string };
        if (!reponse.ok) throw new Error(corps.error || "Lecture de l'usage impossible.");
        setUsageParExtension((precedent) => ({
          ...precedent,
          [extensionId]: {
            extension: corps.extension ?? { id: extensionId, name: extensionId },
            installation: corps.installation ?? { version: "?", status: "?" },
            executions: corps.executions ?? [],
          },
        }));
      } catch (cause) {
        setUsageOuvert(null);
        setMessage({
          ton: "erreur",
          texte: cause instanceof Error ? cause.message : "Lecture de l'usage impossible.",
        });
      } finally {
        setUsageEnCours(null);
      }
    },
    [usageOuvert, usageParExtension],
  );

  if (chargement) {
    return (
      <section className="g3-gradient-border mt-6 p-6" aria-busy="true">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">Mes extensions</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
          Chargement de vos installations, achats et licences…
        </p>
      </section>
    );
  }

  // Après chargement, les trois listes sont TOUJOURS des tableaux (remplies
  // en succès comme en erreur) — locals pour aider le narrowing TS.
  const listeInstallations = installations ?? [];
  const listeAchats = achats ?? [];
  const listeLicences = licences ?? [];

  return (
    <div>
      <section className="g3-gradient-border mt-6 p-6" aria-labelledby="extensions-titre">
        <h1 id="extensions-titre" className="font-[family-name:var(--font-display)] text-2xl font-semibold">
          Mes extensions
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
          Vos installations actives, l&apos;historique de vos achats, vos licences et l&apos;usage
          réel de chaque extension installée. Cette page constate vos droits — l&apos;achat et
          l&apos;installation se font depuis le catalogue et la Facturation.
        </p>

        <div role="status" aria-live="polite">
          {message ? (
            <p
              className={
                "mt-3 rounded-lg border px-3 py-2 text-sm " +
                (message.ton === "ok"
                  ? "border-[var(--g3-border)] bg-[var(--g3-elevated)] text-[var(--g3-text)]"
                  : "border-[var(--g3-danger)] bg-[var(--g3-elevated)] text-[var(--g3-danger)]")
              }
            >
              {message.texte}
            </p>
          ) : null}
        </div>

        {erreurInitiale ? (
          <div className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
            <p className="text-sm text-[var(--g3-text)]">{erreurInitiale}</p>
            <button type="button" className="g3-btn mt-3" onClick={() => void charger()}>
              Réessayer
            </button>
          </div>
        ) : null}
      </section>

      {/* Installations */}
      <section className="g3-gradient-border mt-6 p-6" aria-labelledby="extensions-installations-titre">
        <h2 id="extensions-installations-titre" className="font-[family-name:var(--font-display)] text-xl font-semibold">
          Installations actives
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
          Extensions actuellement actives sur votre compte. Dépliez l&apos;usage pour voir les
          exécutions réelles (outil, durée, succès ou échec) telles qu&apos;enregistrées par la plateforme.
        </p>
        {listeInstallations.length === 0 ? (
          <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 text-sm text-[var(--g3-muted)]">
            Aucune extension installée pour le moment. Le catalogue accessible à votre compte est
            servi par l&apos;API ; l&apos;installation se fait depuis les fiches d&apos;extension.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {listeInstallations.map((installation) => {
              const nom = installation.extension?.name ?? installation.extensionId;
              return (
                <li
                  key={installation.id}
                  className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-[var(--g3-text)]">
                        {nom}
                        <span className="ml-2 rounded-md border border-[var(--g3-border)] px-1.5 py-0.5 text-xs text-[var(--g3-muted)]">
                          v{installation.version}
                        </span>
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
                        {installation.extension?.developerName ? `${installation.extension.developerName} · ` : ""}
                        Installée le {formaterDate(installation.installedAt)}
                        {installation.extension?.category ? ` · ${installation.extension.category}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="g3-btn"
                      aria-expanded={usageOuvert === installation.extensionId}
                      disabled={usageEnCours !== null}
                      onClick={() => void basculerUsage(installation.extensionId)}
                    >
                      {usageOuvert === installation.extensionId ? "Masquer l'usage" : "Voir l'usage"}
                    </button>
                  </div>
                  {usageOuvert === installation.extensionId ? (
                    <div className="mt-3 border-t border-[var(--g3-border)] pt-3">
                      {usageEnCours === installation.extensionId ? (
                        <p className="text-sm text-[var(--g3-muted)]" aria-busy="true">
                          Chargement de l&apos;usage…
                        </p>
                      ) : usageParExtension[installation.extensionId] &&
                        usageParExtension[installation.extensionId].executions.length === 0 ? (
                        <p className="text-sm text-[var(--g3-muted)]">
                          Aucune exécution enregistrée pour cette extension.
                        </p>
                      ) : usageParExtension[installation.extensionId] ? (
                        <ul className="space-y-2">
                          {usageParExtension[installation.extensionId].executions.map((execution) => (
                            <li
                              key={execution.id || `${execution.toolId}-${execution.createdAt}`}
                              className="text-sm leading-6 text-[var(--g3-text)]"
                            >
                              <span aria-hidden="true">{execution.ok ? "✓" : "✗"}</span>{" "}
                              <code className="text-xs">{execution.toolId || "(outil inconnu)"}</code>{" "}
                              — {formaterDate(execution.createdAt)} · {execution.durationMs} ms
                              {execution.ok ? null : (
                                <span className="block text-xs text-[var(--g3-danger)]">
                                  {execution.error || "Échec d'exécution"}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Achats */}
      <section className="g3-gradient-border mt-6 p-6" aria-labelledby="extensions-achats-titre">
        <h2 id="extensions-achats-titre" className="font-[family-name:var(--font-display)] text-xl font-semibold">
          Achats
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
          Historique de vos achats d&apos;extensions, avec le canal réellement utilisé
          (Portefeuille interne ou Chariow) et le statut enregistré par le serveur.
        </p>
        {listeAchats.length === 0 ? (
          <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 text-sm text-[var(--g3-muted)]">
            Aucun achat enregistré sur votre compte.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {listeAchats.map((achat) => (
              <li
                key={achat.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4"
              >
                <div>
                  <p className="text-sm font-semibold text-[var(--g3-text)]">
                    {achat.extension?.name ?? achat.extensionId}
                    <span className="ml-2 text-xs font-normal text-[var(--g3-muted)]">
                      {LIBELLES_TYPE[achat.kind] ?? achat.kind}
                    </span>
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
                    {formaterDate(achat.createdAt)} · Canal : {LIBELLES_CANAL[achat.provider] ?? achat.provider}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-[var(--g3-text)]">
                    {formaterMontant(achat.amountMinor, achat.currency)}
                  </p>
                  <p className="text-xs text-[var(--g3-muted)]">
                    {LIBELLES_STATUT_ACHAT[achat.status] ?? achat.status}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Licences */}
      <section className="g3-gradient-border mt-6 p-6" aria-labelledby="extensions-licences-titre">
        <h2 id="extensions-licences-titre" className="font-[family-name:var(--font-display)] text-xl font-semibold">
          Licences
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
          Clés de licence associées à vos achats. Conservez-les : elles font foi de votre droit
          d&apos;usage, y compris en cas de réinstallation.
        </p>
        {listeLicences.length === 0 ? (
          <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 text-sm text-[var(--g3-muted)]">
            Aucune licence enregistrée sur votre compte.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {listeLicences.map((licence) => (
              <li
                key={licence.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4"
              >
                <div>
                  <p className="text-sm font-semibold text-[var(--g3-text)]">
                    {licence.extension?.name ?? licence.extensionId}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
                    Émise le {formaterDate(licence.createdAt)} ·{" "}
                    {licence.expiresAt
                      ? `Expire le ${formaterDate(licence.expiresAt)}`
                      : "Sans date d'expiration"}
                  </p>
                </div>
                <code className="rounded-md border border-[var(--g3-border)] px-2 py-1 text-xs text-[var(--g3-text)]">
                  {licence.licenseKey}
                </code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
