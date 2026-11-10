/**
 * CARTE DE MÉMOIRE GEN3 (générée par scripts/genere-carte-memoire.ts —
 * 2026-11-10T09:31:15.546Z — depuis le DISQUE, vérité terrain).
 *
 * Demande propriétaire : « assure-toi qu'il a bien mémorisé où [les datasets]
 * se trouvent dans sa mémoire ». Cette carte est la mémoire d'emplacement :
 * 45 fenêtres d'assets réels (1347 fichiers, 218.93 Mo)
 * + 43 snapshots SNN cumulatifs (dernier : cortex-multimodal-it143.bin, 12.58 Mo).
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
  { fenetre: "it.124", chemin: "/multimodal-it124/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6448972, snapshot: "/neural/cortex-multimodal-it124.bin", snapshotOctets: 12582960 },
  { fenetre: "it.125", chemin: "/multimodal-it125/", images: 20, audios: 8, videos: 0, assets: 28, octets: 5219664, snapshot: "/neural/cortex-multimodal-it125.bin", snapshotOctets: 12582960 },
  { fenetre: "it.126", chemin: "/multimodal-it126/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6462146, snapshot: "/neural/cortex-multimodal-it126.bin", snapshotOctets: 12582960 },
  { fenetre: "it.127", chemin: "/multimodal-it127/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6014047, snapshot: "/neural/cortex-multimodal-it127.bin", snapshotOctets: 12582960 },
  { fenetre: "it.128", chemin: "/multimodal-it128/", images: 20, audios: 8, videos: 0, assets: 28, octets: 6510823, snapshot: "/neural/cortex-multimodal-it128.bin", snapshotOctets: 12582960 },
  { fenetre: "it.129", chemin: "/multimodal-it129/", images: 20, audios: 5, videos: 0, assets: 25, octets: 4509938, snapshot: "/neural/cortex-multimodal-it129.bin", snapshotOctets: 12582960 },
  { fenetre: "it.130", chemin: "/multimodal-it130/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1505624, snapshot: "/neural/cortex-multimodal-it130.bin", snapshotOctets: 12582960 },
  { fenetre: "it.131", chemin: "/multimodal-it131/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1714027, snapshot: "/neural/cortex-multimodal-it131.bin", snapshotOctets: 12582960 },
  { fenetre: "it.132", chemin: "/multimodal-it132/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1639360, snapshot: "/neural/cortex-multimodal-it132.bin", snapshotOctets: 12582960 },
  { fenetre: "it.133", chemin: "/multimodal-it133/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1537965, snapshot: "/neural/cortex-multimodal-it133.bin", snapshotOctets: 12582960 },
  { fenetre: "it.134", chemin: "/multimodal-it134/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1511111, snapshot: "/neural/cortex-multimodal-it134.bin", snapshotOctets: 12582960 },
  { fenetre: "it.135", chemin: "/multimodal-it135/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1678244, snapshot: "/neural/cortex-multimodal-it135.bin", snapshotOctets: 12582960 },
  { fenetre: "it.136", chemin: "/multimodal-it136/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1401195, snapshot: "/neural/cortex-multimodal-it136.bin", snapshotOctets: 12582960 },
  { fenetre: "it.137", chemin: "/multimodal-it137/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1584128, snapshot: "/neural/cortex-multimodal-it137.bin", snapshotOctets: 12582960 },
  { fenetre: "it.138", chemin: "/multimodal-it138/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1516387, snapshot: "/neural/cortex-multimodal-it138.bin", snapshotOctets: 12582960 },
  { fenetre: "it.141", chemin: "/multimodal-it141/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1503708, snapshot: "/neural/cortex-multimodal-it141.bin", snapshotOctets: 12582960 },
  { fenetre: "it.142", chemin: "/multimodal-it142/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1520127, snapshot: "/neural/cortex-multimodal-it142.bin", snapshotOctets: 12582960 },
  { fenetre: "it.143", chemin: "/multimodal-it143/", images: 20, audios: 8, videos: 0, assets: 28, octets: 1436832, snapshot: "/neural/cortex-multimodal-it143.bin", snapshotOctets: 12582960 },
];

export const DERNIER_SNAPSHOT = { fichier: "/neural/cortex-multimodal-it143.bin", octets: 12582960 } as const;

export const PAIRES_CARTE_MEMOIRE: readonly { motif: string; reponse: string; theme: string }[] = [
  { motif: "Où sont stockés les assets multimodaux de gen3 ?", reponse: "Ma carte de mémoire enregistre 45 fenêtres d'assets réels, soit 1347 fichiers (218.93 Mo), servis publiquement dans /multimodal-it90/, /multimodal-it94/, /multimodal-it95/, /multimodal-it96/, /multimodal-it97/, /multimodal-it98/, /multimodal-it99/, /multimodal-it101/, /multimodal-it104/, /multimodal-it105/, /multimodal-it106/, /multimodal-it107/, /multimodal-it108/, /multimodal-it109/, /multimodal-it110/, /multimodal-it111/, /multimodal-it112/, /multimodal-it113/, /multimodal-it115/, /multimodal-it116/, /multimodal-it117/, /multimodal-it118/, /multimodal-it119/, /multimodal-it120/, /multimodal-it121/, /multimodal-it122/, /multimodal-it123/, /multimodal-it124/, /multimodal-it125/, /multimodal-it126/, /multimodal-it127/, /multimodal-it128/, /multimodal-it129/, /multimodal-it130/, /multimodal-it131/, /multimodal-it132/, /multimodal-it133/, /multimodal-it134/, /multimodal-it135/, /multimodal-it136/, /multimodal-it137/, /multimodal-it138/, /multimodal-it141/, /multimodal-it142/, /multimodal-it143/. Les fenêtres récentes (it.95 → it.143) délivrent à chaque itération 20 images COCO-2017 annotées + 8 audios de parole française à transcriptions officielles (Google FLEURS fr_fr/validation jusqu'à son épuisement en it.129 — fenêtre partielle de 5 clips — puis Meta Multilingual LibriSpeech french/dev depuis it.130). Chaque asset a son identifiant kmNN_ câblé dans mon corpus : demande-moi « Que contient l'image km143_image_001 ? » et je réponds avec l'empreinte sha256 du fichier réel.", theme: "memoire-emplacement" },
  { motif: "Où se trouve la mémoire gravée de gen3 ?", reponse: "Ma mémoire gravée (cortex SNN, bandes 0 à 9) est exportée en 43 snapshots cumulatifs servis depuis /neural/ : de cortex-multimodal-it96.bin à cortex-multimodal-it143.bin (12.58 Mo chacun). Chaque itération grave 2 016 ondes sur la bande 9 multimodale depuis le snapshot précédent — le dernier en date est /neural/cortex-multimodal-it143.bin.", theme: "memoire-emplacement" },
  { motif: "Où sont servis les fichiers de la fenêtre it.143 ?", reponse: "La fenêtre it.143 réside dans public/multimodal-it143/ : 20 images (COCO-2017) et 8 audios (parole française à transcriptions officielles), 1.44 Mo mesurés sur le disque — servis à /multimodal-it143/images/ et /multimodal-it143/audio/. Le snapshot SNN associé est /neural/cortex-multimodal-it143.bin (12.58 Mo).", theme: "memoire-emplacement" },
  { motif: "Quelle est la taille de la mémoire multimodale de gen3 ?", reponse: "Mesuré sur le disque : 1347 assets multimodaux réels pour 218.93 Mo au total, répartis en 45 fenêtres (de it.90 à it.143), plus 43 snapshots SNN de 12.58 Mo chacun — soit une mémoire gravée d'environ 541.07 Mo au total. Aucun chiffre inventé : ma carte de mémoire est régénérée depuis le disque à chaque itération.", theme: "memoire-emplacement" },
];
