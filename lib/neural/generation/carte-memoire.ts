/**
 * CARTE DE MÉMOIRE GEN3 (générée par scripts/genere-carte-memoire.ts —
 * 2026-11-07T13:14:10.474Z — depuis le DISQUE, vérité terrain).
 *
 * Demande propriétaire : « assure-toi qu'il a bien mémorisé où [les datasets]
 * se trouvent dans sa mémoire ». Cette carte est la mémoire d'emplacement :
 * 27 fenêtres d'assets réels (846 fichiers, 165.21 Mo)
 * + 25 snapshots SNN cumulatifs (dernier : cortex-multimodal-it123.bin, 12.58 Mo).
 */
export interface FenetreMemoire {
  readonly fenetre: string;
  readonly chemin: string;
  readonly images: number;
  readonly audios: number;
  readonly videos: number;
  readonly assets: number;
  readonly octets: number;
  readonly snapshot: string | null;
  readonly snapshotOctets: number | null;
}

export const CARTE_MEMOIRE: readonly FenetreMemoire[] = [
  { fenetre: "it.90", chemin: "/multimodal-it90/", images: 76, audios: 40, videos: 2, assets: 118, octets: 5892334, snapshot: null, snapshotOctets: null },
  { fenetre: "it.94", chemin: "/multimodal-it94/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6495519, snapshot: null, snapshotOctets: null },
  { fenetre: "it.95", chemin: "/multimodal-it95/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5453895, snapshot: "/neural/cortex-multimodal-it95.bin", snapshotOctets: 12582960 },
  { fenetre: "it.96", chemin: "/multimodal-it96/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6623093, snapshot: "/neural/cortex-multimodal-it96.bin", snapshotOctets: 12582960 },
  { fenetre: "it.97", chemin: "/multimodal-it97/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5797271, snapshot: "/neural/cortex-multimodal-it97.bin", snapshotOctets: 12582960 },
  { fenetre: "it.98", chemin: "/multimodal-it98/", images: 20, audios: 8, videos: 0, assets: 28, octets: 7155370, snapshot: "/neural/cortex-multimodal-it98.bin", snapshotOctets: 12582960 },
  { fenetre: "it.99", chemin: "/multimodal-it99/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5893360, snapshot: "/neural/cortex-multimodal-it99.bin", snapshotOctets: 12582960 },
  { fenetre: "it.101", chemin: "/multimodal-it101/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5135838, snapshot: "/neural/cortex-multimodal-it101.bin", snapshotOctets: 12582960 },
  { fenetre: "it.104", chemin: "/multimodal-it104/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5526761, snapshot: "/neural/cortex-multimodal-it104.bin", snapshotOctets: 12582960 },
  { fenetre: "it.105", chemin: "/multimodal-it105/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6293154, snapshot: "/neural/cortex-multimodal-it105.bin", snapshotOctets: 12582960 },
  { fenetre: "it.106", chemin: "/multimodal-it106/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5501426, snapshot: "/neural/cortex-multimodal-it106.bin", snapshotOctets: 12582960 },
  { fenetre: "it.107", chemin: "/multimodal-it107/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6659023, snapshot: "/neural/cortex-multimodal-it107.bin", snapshotOctets: 12582960 },
  { fenetre: "it.108", chemin: "/multimodal-it108/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5634349, snapshot: "/neural/cortex-multimodal-it108.bin", snapshotOctets: 12582960 },
  { fenetre: "it.109", chemin: "/multimodal-it109/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6098507, snapshot: "/neural/cortex-multimodal-it109.bin", snapshotOctets: 12582960 },
  { fenetre: "it.110", chemin: "/multimodal-it110/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6412298, snapshot: "/neural/cortex-multimodal-it110.bin", snapshotOctets: 12582960 },
  { fenetre: "it.111", chemin: "/multimodal-it111/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5186714, snapshot: "/neural/cortex-multimodal-it111.bin", snapshotOctets: 12582960 },
  { fenetre: "it.112", chemin: "/multimodal-it112/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6601898, snapshot: "/neural/cortex-multimodal-it112.bin", snapshotOctets: 12582960 },
  { fenetre: "it.113", chemin: "/multimodal-it113/", images: 20, audios: 8, videos: 0, assets: 28, octets: 7872382, snapshot: "/neural/cortex-multimodal-it113.bin", snapshotOctets: 12582960 },
  { fenetre: "it.115", chemin: "/multimodal-it115/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6600748, snapshot: "/neural/cortex-multimodal-it115.bin", snapshotOctets: 12582960 },
  { fenetre: "it.116", chemin: "/multimodal-it116/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6324868, snapshot: "/neural/cortex-multimodal-it116.bin", snapshotOctets: 12582960 },
  { fenetre: "it.117", chemin: "/multimodal-it117/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6396455, snapshot: "/neural/cortex-multimodal-it117.bin", snapshotOctets: 12582960 },
  { fenetre: "it.118", chemin: "/multimodal-it118/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6185050, snapshot: "/neural/cortex-multimodal-it118.bin", snapshotOctets: 12582960 },
  { fenetre: "it.119", chemin: "/multimodal-it119/", images: 20, audios: 8, videos: 0, assets: 28, octets: 7738129, snapshot: "/neural/cortex-multimodal-it119.bin", snapshotOctets: 12582960 },
  { fenetre: "it.120", chemin: "/multimodal-it120/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5842169, snapshot: "/neural/cortex-multimodal-it120.bin", snapshotOctets: 12582960 },
  { fenetre: "it.121", chemin: "/multimodal-it121/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5331893, snapshot: "/neural/cortex-multimodal-it121.bin", snapshotOctets: 12582960 },
  { fenetre: "it.122", chemin: "/multimodal-it122/", images: 20, audios: 8, videos: 0, assets: 28, octets: 4813593, snapshot: "/neural/cortex-multimodal-it122.bin", snapshotOctets: 12582960 },
  { fenetre: "it.123", chemin: "/multimodal-it123/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5748132, snapshot: "/neural/cortex-multimodal-it123.bin", snapshotOctets: 12582960 },
];

export const DERNIER_SNAPSHOT = { fichier: "/neural/cortex-multimodal-it123.bin", octets: 12582960 } as const;

export const PAIRES_CARTE_MEMOIRE: readonly { motif: string; reponse: string; theme: string }[] = [
  { motif: "Où sont stockés les assets multimodaux de gen3 ?", reponse: "Ma carte de mémoire enregistre 27 fenêtres d'assets réels, soit 846 fichiers (165.21 Mo), servis publiquement dans /multimodal-it90/, /multimodal-it94/, /multimodal-it95/, /multimodal-it96/, /multimodal-it97/, /multimodal-it98/, /multimodal-it99/, /multimodal-it101/, /multimodal-it104/, /multimodal-it105/, /multimodal-it106/, /multimodal-it107/, /multimodal-it108/, /multimodal-it109/, /multimodal-it110/, /multimodal-it111/, /multimodal-it112/, /multimodal-it113/, /multimodal-it115/, /multimodal-it116/, /multimodal-it117/, /multimodal-it118/, /multimodal-it119/, /multimodal-it120/, /multimodal-it121/, /multimodal-it122/, /multimodal-it123/. Les fenêtres récentes (it.95 → it.123) contiennent chacune 28 assets : 20 images COCO-2017 annotées + 8 audios de parole française FLEURS. Chaque asset a son identifiant kmNN_ câblé dans mon corpus : demande-moi « Que contient l'image km123_image_000 ? » et je réponds avec l'empreinte sha256 du fichier réel.", theme: "memoire-emplacement" },
  { motif: "Où se trouve la mémoire gravée de gen3 ?", reponse: "Ma mémoire gravée (cortex SNN, bandes 0 à 9) est exportée en 25 snapshots cumulatifs servis depuis /neural/ : de cortex-multimodal-it96.bin à cortex-multimodal-it123.bin (12.58 Mo chacun). Chaque itération grave 2 016 ondes sur la bande 9 multimodale depuis le snapshot précédent — le dernier en date est /neural/cortex-multimodal-it123.bin.", theme: "memoire-emplacement" },
  { motif: "Où sont servis les fichiers de la fenêtre it.123 ?", reponse: "La fenêtre it.123 réside dans public/multimodal-it123/ : 20 images (COCO-2017) et 8 audios (FLEURS fr_fr), 5.75 Mo mesurés sur le disque — servis à /multimodal-it123/images/ et /multimodal-it123/audio/. Le snapshot SNN associé est /neural/cortex-multimodal-it123.bin (12.58 Mo).", theme: "memoire-emplacement" },
  { motif: "Quelle est la taille de la mémoire multimodale de gen3 ?", reponse: "Mesuré sur le disque : 846 assets multimodaux réels pour 165.21 Mo au total, répartis en 27 fenêtres (de it.90 à it.123), plus 25 snapshots SNN de 12.58 Mo chacun — soit une mémoire gravée d'environ 314.57 Mo au total. Aucun chiffre inventé : ma carte de mémoire est régénérée depuis le disque à chaque itération.", theme: "memoire-emplacement" },
];
