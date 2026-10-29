"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Espace Business — page /business (Job 478451, it. 33 lot 1/3, it. 35
 * lot 2/3, it. 36 lot 3/3).
 *
 * Constat d'audit (garde anti-code-mort it. 29) : douze endpoints du lot
 * /api/business/* (≈ 2 000 lignes, CRUD complet, Zod, rate-limit, moteur
 * IA) étaient livrés, testés, déployés — sans AUCUNE surface utilisateur.
 * Un utilisateur ne pouvait ni voir ses impayés, ni sa trésorerie, ni ses
 * formations, ni sa maintenance.
 *
 * LOT 1 (it. 33) — les 4 modules à réponse homogène {records, kpis} :
 *  - GET /api/business/finance-unpaid         → {invoices, kpis}  (impayés)
 *  - GET /api/business/finance-cashflow       → {entries, kpis}   (trésorerie)
 *  - GET /api/business/hr-training            → {trainings, kpis} (formations)
 *  - GET /api/business/operations-maintenance → {assets, kpis}    (maintenance)
 *
 * LOT 2 (it. 35) — les 3 modules composites suivants :
 *  - GET /api/business/hr-leaves         → {leaves, balances}          (congés)
 *  - GET /api/business/compliance-gdpr   → {processing, requests, kpis} (RGPD)
 *  - GET /api/business/documents-onboarding → {flows, kpis}            (onboarding)
 *
 * LOT 3 (it. 36) — les 4 derniers modules de lecture :
 *  - GET /api/business/documents-contracts → {contracts}              (contrats)
 *  - GET /api/business/marketing-landing   → {pages}                  (landing)
 *  - GET /api/business/marketing-webinar   → {assets}                 (webinars)
 *  - GET /api/business/automations         → {workflows, runs, notifications}
 *    (la 3e liste est volontairement non dupliquée : les notifications
 *    ont déjà leur centre dédié — components/notifications/).
 *  Le 12e endpoint du lot (pulse) est une mission agent COÛTEUSE
 *  (POST) : volontairement hors vue lecture, documenté sur la page.
 *
 * TABLES SECONDAIRES (it. 35) : les modules composites renvoient deux
 * listes utiles (demandes + soldes ; DSR + registre ; workflows + runs).
 * La correspondance serveur (Record → lignes) est une transformation
 * PUREMENT STRUCTURELLE (Object.entries + spread des valeurs telles
 * quelles) — aucune valeur n'est recalculée côté client.
 *
 * HONNÊTETÉ KPI : les indicateurs affichent les valeurs TELLES QUE
 * calculées par le serveur ; les modules SANS KPI serveur déclarent
 * kpis: [] et aucun indicateur n'est inventé (5 modules concernés).
 *
 * FORMATEURS STRUCTURELS (jamais de calcul métier) : date (AAAA-MM-JJ),
 * date-ms (horodatage epoch), montant (nombre + devise ligne), direction
 * (in/out), taille (longueur d'une liste ou d'un objet serveur),
 * declencheur (trigger.type/eventType), oui-non (booléens). Les clés de
 * colonne acceptent la notation pointée (trigger.type) — lecture de
 * chemin, pas de transformation.
 *
 * Accessibilité : table natifs (en-têtes th scope), sections
 * aria-labelledby, zone role="status", aucun widget artificiel. Palette :
 * tokens g3-* existants UNIQUEMENT.
 */

type Kpis = Record<string, unknown>;
type Ligne = Record<string, unknown>;

type Colonne = {
  key: string;
  libelle: string;
  format?: "date" | "date-ms" | "montant" | "direction" | "taille" | "declencheur" | "oui-non";
};

type ModuleDef = {
  id: string;
  titre: string;
  description: string;
  endpoint: string;
  recordsKey: string;
  kpis: { key: string; libelle: string }[];
  colonnes: Colonne[];
  /** Table secondaire — deuxième liste renvoyée par le serveur pour les
   *  modules composites. libelleCle : nom de la première colonne, qui
   *  reçoit la clé de la correspondance renvoyée par l'API. */
  secondaire?: {
    recordsKey: string;
    libelleCle: string;
    titre: string;
    colonnes: Colonne[];
  };
};

const MODULES: ModuleDef[] = [
  {
    id: "impayes",
    titre: "Impayés",
    description:
      "Factures ouvertes et retard de paiement, telles qu'enregistrées par le module Finance.",
    endpoint: "/api/business/finance-unpaid",
    recordsKey: "invoices",
    kpis: [
      { key: "openTotalLabel", libelle: "Encours ouvert" },
      { key: "lateTotalLabel", libelle: "Montant en retard" },
      { key: "lateCount", libelle: "Factures en retard" },
      { key: "recoveryRate", libelle: "Taux de recouvrement (%)" },
    ],
    colonnes: [
      { key: "invoiceNumber", libelle: "Facture" },
      { key: "clientName", libelle: "Client" },
      { key: "amount", libelle: "Montant", format: "montant" },
      { key: "dueDate", libelle: "Échéance", format: "date" },
      { key: "lateDays", libelle: "Jours de retard" },
      { key: "status", libelle: "Statut" },
    ],
  },
  {
    id: "tresorerie",
    titre: "Trésorerie",
    description:
      "Mouvements réalisés et projections calculées par le moteur d'analyse (régression linéaire côté serveur).",
    endpoint: "/api/business/finance-cashflow",
    recordsKey: "entries",
    kpis: [
      { key: "realizedBalanceLabel", libelle: "Solde réalisé" },
      { key: "projection30", libelle: "Projection 30 j" },
      { key: "projection90", libelle: "Projection 90 j" },
      { key: "avgMonthlyOut", libelle: "Sortie mensuelle moyenne" },
    ],
    colonnes: [
      { key: "label", libelle: "Libellé" },
      { key: "direction", libelle: "Sens", format: "direction" },
      { key: "amount", libelle: "Montant", format: "montant" },
      { key: "category", libelle: "Catégorie" },
      { key: "dueDate", libelle: "Date", format: "date" },
    ],
  },
  {
    id: "formations",
    titre: "Formations",
    description:
      "Parcours de formation de l'équipe, heures planifiées et avancement.",
    endpoint: "/api/business/hr-training",
    recordsKey: "trainings",
    kpis: [
      { key: "total", libelle: "Formations" },
      { key: "completed", libelle: "Terminées" },
      { key: "inProgress", libelle: "En cours" },
      { key: "totalHours", libelle: "Heures totales" },
    ],
    colonnes: [
      { key: "title", libelle: "Formation" },
      { key: "employeeName", libelle: "Employé" },
      { key: "category", libelle: "Catégorie" },
      { key: "durationHours", libelle: "Heures" },
      { key: "dueAt", libelle: "Échéance", format: "date" },
      { key: "status", libelle: "Statut" },
    ],
  },
  {
    id: "maintenance",
    titre: "Maintenance",
    description:
      "Équipements, intervalles d'entretien et échéances (en retard / proche).",
    endpoint: "/api/business/operations-maintenance",
    recordsKey: "assets",
    kpis: [
      { key: "total", libelle: "Équipements" },
      { key: "overdue", libelle: "En retard" },
      { key: "dueSoon", libelle: "Échéance proche" },
    ],
    colonnes: [
      { key: "name", libelle: "Équipement" },
      { key: "location", libelle: "Emplacement" },
      { key: "intervalDays", libelle: "Intervalle (j)" },
      { key: "lastDoneAt", libelle: "Dernier entretien", format: "date" },
      { key: "status", libelle: "Statut" },
    ],
  },
  {
    id: "conges",
    titre: "Congés",
    description:
      "Demandes de congé de l'équipe (jours ouvrés calculés par le moteur de planification serveur) et soldes par employé.",
    endpoint: "/api/business/hr-leaves",
    recordsKey: "leaves",
    // Le serveur ne renvoie PAS de kpis pour ce module : aucun indicateur
    // n'est inventé côté client (honnêteté), les soldes servent de table
    // secondaire.
    kpis: [],
    colonnes: [
      { key: "employeeName", libelle: "Employé" },
      { key: "type", libelle: "Type" },
      { key: "startAt", libelle: "Début", format: "date" },
      { key: "endAt", libelle: "Fin", format: "date" },
      { key: "days", libelle: "Jours ouvrés" },
      { key: "status", libelle: "Statut" },
    ],
    secondaire: {
      recordsKey: "balances",
      libelleCle: "Employé",
      titre: "Soldes de congés (calculés par le serveur)",
      colonnes: [
        { key: "allowance", libelle: "Alloué (j)" },
        { key: "taken", libelle: "Pris (j)" },
        { key: "remaining", libelle: "Restant (j)" },
      ],
    },
  },
  {
    id: "conformite",
    titre: "Conformité RGPD",
    description:
      "Demandes des personnes concernées avec échéance réglementaire (30 jours, calculée côté serveur) et registre des traitements.",
    endpoint: "/api/business/compliance-gdpr",
    recordsKey: "requests",
    kpis: [
      { key: "openRequests", libelle: "Demandes ouvertes" },
      { key: "breached", libelle: "SLA dépassé" },
    ],
    colonnes: [
      { key: "typeLabel", libelle: "Type" },
      { key: "subjectName", libelle: "Personne" },
      { key: "subjectEmail", libelle: "E-mail" },
      { key: "status", libelle: "Statut" },
      { key: "daysLeft", libelle: "Jours restants" },
      { key: "sla", libelle: "SLA" },
    ],
    secondaire: {
      recordsKey: "processing",
      libelleCle: "Traitement",
      titre: "Registre des traitements",
      colonnes: [
        { key: "processingName", libelle: "Traitement" },
        { key: "legalBasis", libelle: "Base légale" },
        { key: "retentionDays", libelle: "Conservation (j)" },
        { key: "secured", libelle: "Sécurisé" },
      ],
    },
  },
  {
    id: "onboarding",
    titre: "Onboarding",
    description:
      "Parcours d'intégration générés depuis des modèles par rôle (employé, client, prestataire), avancement enregistré par le serveur.",
    endpoint: "/api/business/documents-onboarding",
    recordsKey: "flows",
    kpis: [
      { key: "total", libelle: "Parcours" },
      { key: "active", libelle: "Actifs" },
      { key: "completed", libelle: "Terminés" },
    ],
    colonnes: [
      { key: "name", libelle: "Parcours" },
      { key: "targetName", libelle: "Personne" },
      { key: "role", libelle: "Rôle" },
      { key: "steps", libelle: "Étapes", format: "taille" },
      { key: "status", libelle: "Statut" },
    ],
  },
  {
    id: "contrats",
    titre: "Contrats",
    description:
      "Contrats générés par le moteur documentaire (clauses comptées côté serveur) avec leurs conditions financières.",
    endpoint: "/api/business/documents-contracts",
    recordsKey: "contracts",
    // Le serveur ne renvoie pas de kpis : aucun indicateur inventé.
    kpis: [],
    colonnes: [
      { key: "title", libelle: "Contrat" },
      { key: "clientName", libelle: "Client" },
      { key: "type", libelle: "Type" },
      { key: "amount", libelle: "Montant", format: "montant" },
      { key: "startDate", libelle: "Début", format: "date" },
      { key: "clausesCount", libelle: "Clauses" },
    ],
  },
  {
    id: "landing",
    titre: "Landing pages",
    description:
      "Pages d'atterrissage générées pour un produit et une audience, avec leur statut de production.",
    endpoint: "/api/business/marketing-landing",
    recordsKey: "pages",
    // Le serveur ne renvoie pas de kpis : aucun indicateur inventé.
    kpis: [],
    colonnes: [
      { key: "name", libelle: "Nom" },
      { key: "product", libelle: "Produit" },
      { key: "audience", libelle: "Audience" },
      { key: "tone", libelle: "Ton" },
      { key: "language", libelle: "Langue" },
      { key: "status", libelle: "Statut" },
    ],
  },
  {
    id: "webinars",
    titre: "Kits webinar",
    description:
      "Transcriptions de webinars recyclées en kits de contenus (LinkedIn, e-mail, blog, thread) par l'IA Engine.",
    endpoint: "/api/business/marketing-webinar",
    recordsKey: "assets",
    // Le serveur ne renvoie pas de kpis : aucun indicateur inventé.
    kpis: [],
    colonnes: [
      { key: "title", libelle: "Titre" },
      { key: "audience", libelle: "Audience" },
      { key: "outputs", libelle: "Contenus du kit", format: "taille" },
    ],
  },
  {
    id: "automatisations",
    titre: "Automatisations",
    description:
      "Workflows configurés et leurs exécutions récentes (déclencheurs manuels ou événementiels). Les notifications générées restent dans leur centre dédié — cette vue ne les duplique pas.",
    endpoint: "/api/business/automations",
    recordsKey: "workflows",
    // Le serveur ne renvoie pas de kpis : aucun indicateur inventé.
    kpis: [],
    colonnes: [
      { key: "name", libelle: "Workflow" },
      { key: "trigger.type", libelle: "Déclencheur", format: "declencheur" },
      { key: "conditions", libelle: "Conditions", format: "taille" },
      { key: "steps", libelle: "Étapes", format: "taille" },
      { key: "enabled", libelle: "Active", format: "oui-non" },
    ],
    secondaire: {
      recordsKey: "runs",
      libelleCle: "Exécution",
      titre: "Exécutions récentes (journal serveur)",
      colonnes: [
        { key: "workflowName", libelle: "Workflow" },
        { key: "status", libelle: "Statut" },
        { key: "startedAt", libelle: "Début", format: "date-ms" },
        { key: "finishedAt", libelle: "Fin", format: "date-ms" },
      ],
    },
  },
];

const TAILLE_PAGE = 8;

/** Lecture d'une clé de colonne, avec notation pointée (trigger.type) —
 *  simple résolution de chemin, aucune transformation de valeur. */
function lireValeur(ligne: Ligne, cle: string): unknown {
  if (!cle.includes(".")) return ligne[cle];
  return cle
    .split(".")
    .reduce<unknown>(
      (acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined),
      ligne,
    );
}

function formaterValeur(ligne: Ligne, colonne: Colonne): string {
  const brut = lireValeur(ligne, colonne.key);
  if (brut === undefined || brut === null || brut === "") return "—";
  if (colonne.format === "date") {
    const t = new Date(`${String(brut)}T00:00:00Z`).getTime();
    return Number.isNaN(t)
      ? String(brut)
      : new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  }
  if (colonne.format === "date-ms") {
    // Horodatage epoch (ms) renvoyé par le journal d'exécution serveur.
    const t = Number(brut);
    return Number.isFinite(t) && t > 0
      ? new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
      : String(brut);
  }
  if (colonne.format === "montant") {
    const devise = String(ligne.currency ?? "");
    const nombre = Number(brut);
    return `${Number.isNaN(nombre) ? String(brut) : nombre.toFixed(2)}${devise ? ` ${devise}` : ""}`;
  }
  if (colonne.format === "direction") {
    const texte = String(brut);
    return texte === "in" ? "Entrée" : texte === "out" ? "Sortie" : texte;
  }
  if (colonne.format === "taille") {
    // Comptage STRUCTUREL d'une liste ou d'un objet renvoyé par le
    // serveur (ex. : étapes, conditions, contenus d'un kit) — jamais un
    // calcul métier.
    if (Array.isArray(brut)) return String(brut.length);
    if (brut && typeof brut === "object") return String(Object.keys(brut).length);
    return "—";
  }
  if (colonne.format === "declencheur") {
    // Libellé du type de déclencheur (valeur serveur mappée, pas calculée).
    const type = String(brut);
    if (type === "manual") return "Manuel";
    if (type === "event") {
      const evenement = String(lireValeur(ligne, "trigger.eventType") ?? "");
      return evenement ? `Événement : ${evenement}` : "Événement";
    }
    return type;
  }
  if (colonne.format === "oui-non") {
    if (brut === true) return "Oui";
    if (brut === false) return "Non";
    return String(brut);
  }
  return String(brut);
}

type EtatModule =
  | { etat: "chargement" }
  | { etat: "vide" }
  | { etat: "erreur"; message: string }
  | { etat: "pret"; lignes: Ligne[]; kpis: Kpis; total: number; secondaires?: Ligne[] };

export function BusinessDashboard() {
  const [etats, setEtats] = useState<Record<string, EtatModule>>({});

  const charger = useCallback(async () => {
    const initial: Record<string, EtatModule> = {};
    for (const m of MODULES) initial[m.id] = { etat: "chargement" };
    setEtats(initial);
    const reponses = await Promise.allSettled(
      MODULES.map((m) => authFetch(m.endpoint, { cache: "no-store" })),
    );
    MODULES.forEach((module, indice) => {
      const promesse = reponses[indice];
      if (promesse.status === "rejected") {
        setEtats((precedent) => ({
          ...precedent,
          [module.id]: {
            etat: "erreur",
            message: promesse.reason instanceof Error ? promesse.reason.message : "Lecture impossible.",
          },
        }));
        return;
      }
      const reponse = promesse.value;
      // La réponse est consommée dans tous les cas (pas de corps suspendu).
      void reponse
        .json()
        .catch(() => null)
        .then((corps) => {
          if (!reponse.ok) {
            setEtats((precedent) => ({
              ...precedent,
              [module.id]: { etat: "erreur", message: String(corps?.error ?? `Erreur ${reponse.status}`) },
            }));
            return;
          }
          const brut = corps?.[module.recordsKey];
          const lignes: Ligne[] = Array.isArray(brut) ? (brut as Ligne[]) : [];
          const kpis = (corps?.kpis ?? {}) as Kpis;
          // Table secondaire : la correspondance serveur (Record) devient
          // des lignes — transformation structurelle, valeurs TELLES
          // QUELLES (spread), aucun recalcul.
          const sec = module.secondaire;
          let secondaires: Ligne[] | undefined;
          if (sec) {
            const brutSec = corps?.[sec.recordsKey];
            secondaires =
              brutSec && typeof brutSec === "object" && !Array.isArray(brutSec)
                ? Object.entries(brutSec as Record<string, unknown>).map(([cle, valeurs]) => ({
                    [sec.libelleCle]: cle,
                    ...(valeurs && typeof valeurs === "object" ? (valeurs as Ligne) : {}),
                  }))
                : [];
          }
          setEtats((precedent) => ({
            ...precedent,
            [module.id]:
              lignes.length === 0 && (secondaires ?? []).length === 0
                ? { etat: "vide" }
                : { etat: "pret", lignes, kpis, total: lignes.length, secondaires },
          }));
        });
    });
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  const toutChargement =
    MODULES.length > 0 &&
    MODULES.every((m) => {
      const etat = etats[m.id];
      return etat === undefined || etat.etat === "chargement";
    });

  return (
    <div>
      <section className="g3-gradient-border mt-6 p-6" aria-labelledby="business-titre">
        <h1 id="business-titre" className="font-[family-name:var(--font-display)] text-2xl font-semibold">
          Business
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
          Vue lecture de vos modules métier : impayés, trésorerie, formations, maintenance,
          congés, conformité RGPD, onboarding, contrats, landing pages, kits webinar et
          automatisations. Les indicateurs sont calculés par les moteurs serveur et affichés
          tels quels ; les tableaux montrent les {TAILLE_PAGE} enregistrements les plus récents.
          Cette vague couvre 11 des 12 modules métier — le dernier (pulse), mission agent coûteuse, reste volontairement hors vue lecture.
        </p>
        <div role="status" aria-live="polite" className="mt-3">
          {toutChargement ? (
            <p className="text-sm text-[var(--g3-muted)]" aria-busy="true">
              Chargement des modules métier…
            </p>
          ) : null}
        </div>
      </section>

      {MODULES.map((module) => {
        const etat = etats[module.id] ?? { etat: "chargement" };
        const secondaire = module.secondaire;
        const lignesSecondaires = etat.etat === "pret" ? etat.secondaires : undefined;
        return (
          <section
            key={module.id}
            className="g3-gradient-border mt-6 p-6"
            aria-labelledby={`business-${module.id}-titre`}
          >
            <h2 id={`business-${module.id}-titre`} className="font-[family-name:var(--font-display)] text-xl font-semibold">
              {module.titre}
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">{module.description}</p>

            {etat.etat === "chargement" ? (
              <p className="mt-4 text-sm text-[var(--g3-muted)]" aria-busy="true">
                Chargement…
              </p>
            ) : etat.etat === "erreur" ? (
              <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 text-sm text-[var(--g3-danger)]">
                {etat.message}
              </p>
            ) : etat.etat === "vide" ? (
              <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 text-sm text-[var(--g3-muted)]">
                Aucun enregistrement pour le moment.
              </p>
            ) : (
              <>
                {module.kpis.length > 0 ? (
                  <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                    {module.kpis.map((kpi) => (
                      <div
                        key={kpi.key}
                        className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-3"
                      >
                        <dt className="text-xs leading-5 text-[var(--g3-muted)]">{kpi.libelle}</dt>
                        <dd className="mt-1 text-lg font-semibold text-[var(--g3-text)]">
                          {etat.kpis[kpi.key] === undefined || etat.kpis[kpi.key] === null
                            ? "—"
                            : String(etat.kpis[kpi.key])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {etat.lignes.length > 0 ? (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-[var(--g3-border)]">
                          {module.colonnes.map((colonne) => (
                            <th key={colonne.key} scope="col" className="px-2 py-2 text-xs font-semibold text-[var(--g3-muted)]">
                              {colonne.libelle}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {etat.lignes.slice(0, TAILLE_PAGE).map((ligne, indice) => (
                          <tr key={String(ligne.id ?? indice)} className="border-b border-[var(--g3-border)] last:border-0">
                            {module.colonnes.map((colonne) => (
                              <td key={colonne.key} className="px-2 py-2 text-[var(--g3-text)]">
                                {formaterValeur(ligne, colonne)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 text-sm text-[var(--g3-muted)]">
                    Aucun enregistrement dans cette liste pour le moment.
                  </p>
                )}
                {etat.total > TAILLE_PAGE ? (
                  <p className="mt-2 text-xs leading-5 text-[var(--g3-muted)]">
                    … et {etat.total - TAILLE_PAGE} autres enregistrements (total : {etat.total}).
                  </p>
                ) : null}
                {secondaire && lignesSecondaires && lignesSecondaires.length > 0 ? (
                  <div className="mt-6">
                    <h3 className="text-sm font-semibold text-[var(--g3-text)]">{secondaire.titre}</h3>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-[var(--g3-border)]">
                            <th scope="col" className="px-2 py-2 text-xs font-semibold text-[var(--g3-muted)]">
                              {secondaire.libelleCle}
                            </th>
                            {secondaire.colonnes.map((colonne) => (
                              <th key={colonne.key} scope="col" className="px-2 py-2 text-xs font-semibold text-[var(--g3-muted)]">
                                {colonne.libelle}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {lignesSecondaires.slice(0, TAILLE_PAGE).map((ligne, indice) => (
                            <tr
                              key={String(ligne[secondaire.libelleCle] ?? indice)}
                              className="border-b border-[var(--g3-border)] last:border-0"
                            >
                              <td className="px-2 py-2 text-[var(--g3-text)]">
                                {String(ligne[secondaire.libelleCle] ?? "—")}
                              </td>
                              {secondaire.colonnes.map((colonne) => (
                                <td key={colonne.key} className="px-2 py-2 text-[var(--g3-text)]">
                                  {formaterValeur(ligne, colonne)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {lignesSecondaires.length > TAILLE_PAGE ? (
                      <p className="mt-2 text-xs leading-5 text-[var(--g3-muted)]">
                        … et {lignesSecondaires.length - TAILLE_PAGE} autres enregistrements (total :{" "}
                        {lignesSecondaires.length}).
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
