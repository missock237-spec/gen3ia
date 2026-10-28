import type { Metadata } from "next";

import { sonderServices } from "@/lib/observability/statut-services";
import { getSystemHealth } from "@/lib/observability/metrics";

/**
 * /status — PAGE PUBLIQUE D'ÉTAT DU SERVICE (durcissement production —
 * « accueillir des utilisateurs à grande échelle » implique la TRANSPARENCE :
 * en incident, les utilisateurs vérifient l'état de la plateforme au lieu
 * d'ouvrir des tickets en cascade).
 *
 * Même code de sondes que /api/status (source unique :
 * lib/observability/statut-services.ts) + informations process locales
 * (uptime, mémoire — les mêmes que /api/metrics, sans aucune donnée
 * utilisateur). Aucun secret, aucun identifiant : utilisable anonymement.
 *
 * Rafraîchissement auto 60 s via <meta httpEquiv="refresh"> (hoisté en head
 * par React 19) — zéro JavaScript client, la page reste un document statique
 * servi même en dégradation partielle.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gen3ia — État du service",
  robots: { index: false, follow: false },
};

const LIBELLÉS_SERVICES: Record<string, { nom: string; description: string }> = {
  auth: { nom: "Authentification", description: "Connexion sécurisée des comptes (e-mail + Google)" },
  r2: { nom: "Stockage des fichiers", description: "Documents, images et médias des conversations" },
  ticks: { nom: "File d'exécution", description: "Tâches planifiées, agents et workflows en arrière-plan" },
};

function Badge({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        ok ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
      {ok ? "Opérationnel" : "Dégradé"}
    </span>
  );
}

export default async function PageStatut() {
  const statut = await sonderServices();
  const health = getSystemHealth();
  const global = statut.status === "ok";

  const ratioHeap = Math.round(
    (health.memory.heapUsedMb / Math.max(1, health.memory.heapTotalMb)) * 100,
  );
  const dureeUptime =
    health.uptimeSec >= 86_400
      ? `${Math.floor(health.uptimeSec / 86_400)} j ${Math.floor((health.uptimeSec % 86_400) / 3_600)} h`
      : `${Math.floor(health.uptimeSec / 3_600)} h ${Math.floor((health.uptimeSec % 3_600) / 60)} min`;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-10 sm:py-14">
      {/* Rafraîchissement automatique (60 s) — document statique, zéro JS client. */}
      <meta httpEquiv="refresh" content="60" />

      <header className="mb-8">
        <p className="text-sm font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Gen3ia
        </p>
        <h1 className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-50 sm:text-3xl">
          État du service
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Cette page reflète l&apos;état réel des services de la plateforme. Elle se
          rafraîchit automatiquement toutes les 60 secondes.
        </p>
      </header>

      <section
        aria-label="État global"
        className={`mb-6 flex items-center justify-between rounded-xl border p-4 sm:p-6 ${
          global
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-amber-500/40 bg-amber-500/5"
        }`}
      >
        <div>
          <p className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {global ? "Tous les systèmes sont opérationnels" : "Certains services sont dégradés"}
          </p>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Vérifié le {new Date(statut.checkedAt).toLocaleString("fr-FR")}
          </p>
        </div>
        <Badge ok={global} />
      </section>

      <section aria-label="Services" className="mb-6 divide-y rounded-xl border border-neutral-200 dark:border-neutral-800">
        {Object.entries(statut.services).map(([cle, service]) => {
          const libellé = LIBELLÉS_SERVICES[cle] ?? { nom: cle, description: "" };
          return (
            <div key={cle} className="flex items-center justify-between gap-4 p-4 sm:p-5">
              <div>
                <p className="font-medium text-neutral-900 dark:text-neutral-100">{libellé.nom}</p>
                <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">{libellé.description}</p>
                {!service.ok && service.reason ? (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Raison : {service.reason === "not_configured" ? "non configuré" : service.reason}
                  </p>
                ) : null}
              </div>
              <Badge ok={service.ok} />
            </div>
          );
        })}
      </section>

      <section aria-label="Processus applicatif" className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Version servie</p>
          <p className="mt-1 truncate font-mono text-sm text-neutral-900 dark:text-neutral-100" title={statut.version}>
            {statut.version}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Temps de fonctionnement</p>
          <p className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{dureeUptime}</p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Mémoire applicative</p>
          <p className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {health.memory.heapUsedMb} Mo / {health.memory.heapTotalMb} Mo ({ratioHeap} %)
          </p>
        </div>
      </section>

      <footer className="mt-auto border-t border-neutral-200 pt-4 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <p>
          Machine-readable :{" "}
          <a className="underline hover:text-neutral-700 dark:hover:text-neutral-300" href="/api/status">
            /api/status
          </a>{" "}
          · Heartbeat :{" "}
          <a className="underline hover:text-neutral-700 dark:hover:text-neutral-300" href="/api/health">
            /api/health
          </a>
        </p>
      </footer>
    </main>
  );
}
