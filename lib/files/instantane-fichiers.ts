/**
 * INSTANTANÉ DE FICHIERS — matérialisation d'une vue LIVE (FileList) avant
 * toute mise en file d'attente d'état React.
 *
 * INCIDENCE RÉELLE (it.143, 2026-11-10, production) : le composer du chat
 * appelait `ajouterFichiers(e.target.files)` PUIS `e.target.value = ""`.
 * `FileList` est une vue LIVE sur l'input : au moment où React exécute
 * l'updater différé de `setFichiers` (au rendu, APRÈS le retour du
 * handler), la vue était déjà vidée — `Array.from(liste)` ≡ [] — d'où une
 * pièce jointe perdue SILENCIEUSEMENT (aucun toast, aucune puce, message
 * envoyé sans fichier, réponse générique du cerveau). La matérialisation
 * nom/taille/type/fichier rend l'ajout indépendant du calendrier de rendu.
 */
export interface FichierInstantane {
  readonly nom: string;
  readonly taille: number;
  readonly type: string;
  readonly fichier: File;
  readonly image: boolean;
}

/** Copie superficielle immédiate des fichiers — sûre à lire plus tard. */
export function instantaneFichiers(
  liste: FileList | File[] | null | undefined,
): FichierInstantane[] {
  return Array.from(liste ?? []).map((f) => ({
    nom: f.name,
    taille: f.size,
    type: f.type,
    fichier: f,
    image: f.type.startsWith("image/"),
  }));
}
