import type { Metadata } from "next";

import { sonderServices } from "@/lib/observability/statut-services";
import { getSystemHealth } from "@/lib/observability/metrics";
import VueSobrieteEnergie from "@/components/neural/vue-sobriete-energie";

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
 * par React 19) — la page reste un document servi même en dégradation
 * partielle. it.78 (candidat №2 reporté it.74 §7 / it.76 §8 / it.77 §9) :
 * la vue de sobriété énergétique (widget client it.75) est rendue ici en
 * second emplacement public — l'état du service montre AUSSI la mesure de
 * la demande propriétaire (énergie) ; son polling 30 s est gaté par la
 * visibilité (zéro requête en arrière-plan), le meta-refresh du document
 * reste inchangé.
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

      {/* it.78 — second emplacement public de la mesure de sobriété
          (candidat №2 reporté trois fois) : profil actif, compteurs
          persistés, règle d'honnêteté — le tout consommé depuis
          /api/energie par le widget client sobre (it.75). */}
      <VueSobrieteEnergie />

      {/* Axe 5 (audit 2 nov. 2026) — engagements publics (SLA) : les cibles
          reprises ici sont celles de docs/sre/sli-slo.md §3 (calibrées VPS
          solo 2 Go) + le SLE de livraison encodé dans le CD (issue #109).
          Aucune promesse non mesurée : chaque ligne renvoie à sa mesure. */}
      <section
        aria-label="Nos engagements de service"
        className="mb-8 rounded-xl border border-neutral-200 p-4 sm:p-6 dark:border-neutral-800"
      >
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
          Nos engagements (SLA)
        </h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Cibles publiques, calibrées pour un VPS solo — mesurées en continu
          (sondes ci-dessus, CD et guérisseur automatiques).
        </p>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
            <dt className="font-medium text-neutral-900 dark:text-neutral-100">Disponibilité</dt>
            <dd className="text-neutral-600 dark:text-neutral-400">≥ 99,5 % par mois (≤ 3,65 h d&apos;indisponibilité)</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
            <dt className="font-medium text-neutral-900 dark:text-neutral-100">Réponse du chat</dt>
            <dd className="text-neutral-600 dark:text-neutral-400">
              réponse en quelques secondes ; au-delà de 35 s, une réponse de repli honnête est
              envoyée dans le fil et votre message reste renvoyable
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
            <dt className="font-medium text-neutral-900 dark:text-neutral-100">Erreurs serveur (5xx)</dt>
            <dd className="text-neutral-600 dark:text-neutral-400">&lt; 0,5 % des requêtes par mois</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
            <dt className="font-medium text-neutral-900 dark:text-neutral-100">Livraison des mises à jour</dt>
            <dd className="text-neutral-600 dark:text-neutral-400">
              cycle de déploiement visé ≤ 2 min après publication ; au-delà de 10 min sans bascule,
              une alerte automatique est déclenchée et visible publiquement (issue + run rouge) ;
              en cas d&apos;échec de livraison, nouvelle tentative rapide (1 min), puis espacée
              (2, 5 puis 15 min)
            </dd>
          </div>
        </dl>
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
