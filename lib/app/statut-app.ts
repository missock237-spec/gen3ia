/**
 * STATUT DE L'APPLICATION — le même moteur d'empreintes que le
 * DeployWatcher (gen3ia-app-version dans localStorage, /api/deploy-info,
 * /version.json) exposé en fonctions PURES pour la section « Application »
 * des Paramètres. L'utilisateur y voit la preuve que son app installée est
 * la même version que le site, et que les mises à jour s'appliquent
 * automatiquement.
 *
 * HONNÊTETÉ : quand les deux sondes divergent (fenêtre de bascule mv→cp,
 * rollback en cours), le statut est « indéterminé » — jamais de décision
 * sur une information contradictoire (même règle que le watcher).
 */

export type EtatApplication = "a-jour" | "nouvelle-version" | "indetermine";

export interface EntreesStatutApplication {
  /** Empreinte renvoyée par /api/deploy-info (BUILD_ID du build servi). */
  apiId: string | null;
  /** Empreinte renvoyée par /version.json (manifeste statique du build). */
  manifestVersion: string | null;
  /** Version déjà enregistrée par ce navigateur (localStorage gen3ia-app-version). */
  versionLocale: string | null;
  /** Un service worker attend d'être appliqué (reg.waiting présent). */
  nouvelleVersionEnAttente?: boolean;
}

export interface StatutApplication {
  etat: EtatApplication;
  /** Empreinte retenue (serveur) — affichée dans les Paramètres. */
  versionActive: string | null;
  libelle: string;
  detail: string;
}

/** Dérive le statut réel de l'app installée vs la version servie par le site. */
export function deriveStatutApplication(entrees: EntreesStatutApplication): StatutApplication {
  const { apiId, manifestVersion, versionLocale, nouvelleVersionEnAttente } = entrees;
  // Les deux sondes répondent mais divergent : fenêtre de bascule ou
  // rollback — état ambigu, aucune décision ce cycle (règle du watcher).
  if (apiId !== null && manifestVersion !== null && apiId !== manifestVersion) {
    return {
      etat: "indetermine",
      versionActive: null,
      libelle: "Vérification en cours…",
      detail:
        "Les deux sondes de version divergent (bascule de déploiement ou rollback en cours) — le statut exact sera affiché à la prochaine vérification.",
    };
  }
  const versionActive = apiId ?? manifestVersion;
  if (versionActive === null) {
    return {
      etat: "indetermine",
      versionActive: null,
      libelle: "Vérification indisponible",
      detail:
        "Impossible de joindre le serveur de versions (hors-ligne ou incident) — une nouvelle vérification sera tentée au retour du réseau.",
    };
  }
  // Une version attend par le service worker : la nouvelle version est
  // déjà TÉLÉCHARGÉE et s'applique (skipWaiting + reload au moment sûr).
  if (nouvelleVersionEnAttente || (versionLocale !== null && versionLocale !== versionActive)) {
    return {
      etat: "nouvelle-version",
      versionActive,
      libelle: "Nouvelle version disponible — application automatique",
      detail:
        "Cette app installée est connectée au site : la nouvelle version s'applique automatiquement (rechargement transparent au moment sûr — onglet en arrière-plan ou bannière avec compte à rebours). Aucune réinstallation nécessaire.",
    };
  }
  return {
    etat: "a-jour",
    versionActive,
    libelle: "À jour ✓",
    detail:
      "Cette application tourne sur la même version que le site web (même session, même données) et se met à jour automatiquement à chaque déploiement — sans réinstallation.",
  };
}

/** Dernière vérification lisible (horodatage → texte humain FR). */
export function libelleDerniereVerification(horodatageMs: number | null, maintenantMs: number): string {
  if (horodatageMs === null) return "jamais";
  const ecartSecondes = Math.max(0, Math.floor((maintenantMs - horodatageMs) / 1000));
  if (ecartSecondes < 60) return "il y a moins d'une minute";
  const ecartMinutes = Math.floor(ecartSecondes / 60);
  if (ecartMinutes < 60) return `il y a ${ecartMinutes} min`;
  const ecartHeures = Math.floor(ecartMinutes / 60);
  if (ecartHeures < 24) return `il y a ${ecartHeures} h`;
  return `il y a ${Math.floor(ecartHeures / 24)} j`;
}
