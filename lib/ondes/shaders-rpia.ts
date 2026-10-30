/**
 * Compute shaders WebGPU de l'ENTRAÎNEMENT PAR RÉSONANCE (RPIA) —
 * portage fidèle des trois sources utilisateur :
 *
 *  1. SHADER_ENTRAINEMENT_RPIA  ← waveTrainer.wgsl : chaque thread
 *     entraîne UN nœud d'onde vers la cible (règle constructive/
 *     destructive, ajustement amplitude/phase/amortissement).
 *  2. SHADER_SYNTHESE_ACOUSTIQUE ← node.amplitude.pdf : oscillateurs
 *     audibles 20 – 20 000 Hz guidés par l'onde cible (voix, sons).
 *  3. SHADER_RENDU_SPATIOTEMPOREL ← node.amplitude (1).pdf : nœuds 3D
 *     (x, y, t) dont la persistance de phase lie les trames successives
 *     (fluidité du mouvement vidéo).
 *
 * Chaque shader possÈDE SON MIROIR CPU exact (specification exécutable
 * testée) : entrainement-rpia.ts, synthese-acoustique.ts et
 * rendu-spatiotemporel.ts. Mêmes formules, mêmes clamps, mêmes ordres
 * de grandeur — le GPU n'accélère que, il ne change pas la physique.
 */

export const SHADER_ENTRAINEMENT_RPIA = /* wgsl */ `
struct NoeudOnde {
  amplitude : f32,
  frequence : f32,
  phase : f32,
  amortissement : f32,
};

struct ParametresEntrainement {
  tauxApprentissage : f32,
  interfCible : f32,
  tempsGlobal : f32,
  pad0 : f32,
};

@group(0) @binding(0) var<storage, read_write> noeuds : array<NoeudOnde>;
@group(0) @binding(1) var<storage, read> ondeCible : array<f32>;
@group(0) @binding(2) var<uniform> parametres : ParametresEntrainement;

@compute @workgroup_size(256)
fn principal(@builtin(global_invocation_id) id : vec3<u32>) {
  let idx = id.x;
  if (idx >= arrayLength(&noeuds)) { return; }
  var noeud = noeuds[idx];
  let cible = ondeCible[idx];

  // 1. Propagation de l'onde avant (Forward Wave Pass).
  let ondeAvant = noeud.amplitude * cos(noeud.frequence * parametres.tempsGlobal + noeud.phase);

  // 2. Zone d'interférence (onde produite vs cible).
  let interference = ondeAvant - cible;

  // 3. Règle d'apprentissage par résonance (RPIA) : synchronisation de
  //    phase et ajustement d'amortissement en temps réel.
  if (abs(interference) < 0.05) {
    // Interférence constructive : renforcement de la résonance.
    noeud.phase = noeud.phase + parametres.tauxApprentissage * (1.0 - cos(noeud.phase));
    noeud.amortissement = max(0.001, noeud.amortissement - 0.002);
  } else {
    // Interférence destructive : déphasage adaptatif (anti-bruit).
    noeud.phase = noeud.phase - parametres.tauxApprentissage * sin(interference);
    noeud.amortissement = min(0.5, noeud.amortissement + 0.005);
  }

  // Ajustement dynamique de l'amplitude selon l'énergie de l'onde.
  noeud.amplitude = clamp(noeud.amplitude - (parametres.tauxApprentissage * interference * 0.1), 0.0, 2.0);

  // Sauvegarde de l'état du nœud.
  noeuds[idx] = noeud;
}
`;

export const SHADER_SYNTHESE_ACOUSTIQUE = /* wgsl */ `
struct NoeudAcoustique {
  amplitude : f32,
  frequence : f32, // Fréquence acoustique (20 Hz à 20 000 Hz)
  phase : f32,
  amortissement : f32,
};

struct ParametresAudio {
  tempsEchantillon : f32, // Temps global dans le flux audio (secondes)
  frequenceEchantillonnage : f32, // Ex : 44100.0 Hz
  guidage : f32, // Force de guidage par rapport à la cible sonore
  pad0 : f32,
};

@group(0) @binding(0) var<storage, read_write> noeuds : array<NoeudAcoustique>;
@group(0) @binding(1) var<storage, read> ondeAudioCible : array<f32>;
@group(0) @binding(2) var<uniform> parametres : ParametresAudio;

@compute @workgroup_size(256)
fn principal(@builtin(global_invocation_id) id : vec3<u32>) {
  let idx = id.x;
  var noeud = noeuds[idx];
  let cible = ondeAudioCible[idx];

  // 1. Onde acoustique sinusoïdale modulée par le temps et la phase.
  let ondeAcoustique = noeud.amplitude * sin(2.0 * 3.14159 * noeud.frequence * parametres.tempsEchantillon + noeud.phase);

  // 2. Interférence avec l'onde cible (erreur de timbre / fréquence).
  let interference = ondeAcoustique - cible;

  // 3. Règle d'apprentissage par résonance acoustique (RPIA) :
  //    la phase cale le timing, la fréquence épouse le timbre.
  noeud.phase = noeud.phase - parametres.guidage * interference * 0.1;
  noeud.frequence = clamp(noeud.frequence - (interference * 5.0), 20.0, 20000.0);

  // Contrôle de l'amortissement pour éviter la saturation (clipping).
  noeud.amortissement = clamp(noeud.amortissement + (abs(interference) * 0.001), 0.001, 0.1);

  noeuds[idx] = noeud;
}
`;

export const SHADER_RENDU_SPATIOTEMPOREL = /* wgsl */ `
struct NoeudOnde3D {
  amplitude : f32,
  frequence : f32,
  phase : f32,
  amortissement : f32,
  posX : f32,
  posY : f32,
};

struct ParametresVideo {
  temps : f32, // Temps global de la vidéo (t)
  largeur : u32, // Résolution largeur (ex : 1280)
  hauteur : u32, // Résolution hauteur (ex : 720)
  guidage : f32, // Force de guidage de la requête
};

@group(0) @binding(0) var<storage, read_write> noeuds : array<NoeudOnde3D>;
@group(0) @binding(1) var<storage, read> ondeMouvementCible : array<f32>;
@group(0) @binding(2) var<uniform> parametres : ParametresVideo;

@compute @workgroup_size(256)
fn principal(@builtin(global_invocation_id) id : vec3<u32>) {
  let idx = id.x;
  var noeud = noeuds[idx];
  let cible = ondeMouvementCible[idx];

  // 1. Onde spatiotemporelle : position (x, y) intégrée au temps (t).
  let ondeSpatio = noeud.amplitude * cos(noeud.frequence * parametres.temps + noeud.phase + (noeud.posX * 0.01) + (noeud.posY * 0.01));

  // 2. Interférence avec la cible de mouvement.
  let interference = ondeSpatio - cible;

  // 3. Règle d'apprentissage par résonance orientée vidéo
  //    (persistance de phase) : la phase lie les trames successives
  //    — fluidité du mouvement entre images voisines.
  noeud.phase = noeud.phase + parametres.guidage * interference * 0.05;

  // Modulation de l'amortissement : stabiliser les arrière-plans,
  // animer les sujets.
  noeud.amortissement = clamp(noeud.amortissement + (interference * 0.001), 0.001, 0.2);

  // Mise à jour de l'amplitude selon l'énergie cinétique de l'onde.
  noeud.amplitude = clamp(noeud.amplitude - (interference * 0.02), 0.0, 2.0);

  noeuds[idx] = noeud;
}
`;

// ---------------------------------------------------------------------------
// PROJECTION « NŒUDS → TRAME » (portage corrigé de Gen3VideoEngine.ts) :
// la source copiait le tampon de nœuds (N×24 octets) vers une trame de
// largeur×hauteur×4 octets — tailles INÉGALES, copyBufferToBuffer impossible.
// La projection réelle est un éclatement gaussien (même physique que le
// miroir CPU rendu-spatiotemporel.ts), en DEUX passes :
//  1. RASTERISATION : chaque nœud accumule sa valeur dans une fenêtre
//     gaussienne — accumulation ENTIÈRE (atomic<i32>/<u32>, valeur×poids
//     en virgule fixe 2^-16) : l'addition entière est associative, le
//     résultat est DÉTERMINISTE quel que soit l'ordre des threads ;
//  2. FINALISATION : par pixel, normalisation → gris [0, 255] → RGBA.
// ---------------------------------------------------------------------------

export const SHADER_RASTERISATION_VIDEO = /* wgsl */ `
struct NoeudOnde3D {
  amplitude : f32,
  frequence : f32,
  phase : f32,
  amortissement : f32,
  posX : f32,
  posY : f32,
};

struct ParametresRaster {
  temps : f32,
  largeur : u32,
  hauteur : u32,
  pad0 : f32,
};

@group(0) @binding(0) var<storage, read> noeuds : array<NoeudOnde3D>;
@group(0) @binding(1) var<uniform> parametres : ParametresRaster;
@group(0) @binding(2) var<storage, read_write> accumulateur : array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> poidsPixels : array<atomic<u32>>;

@compute @workgroup_size(256)
fn principal(@builtin(global_invocation_id) id : vec3<u32>) {
  let idx = id.x;
  if (idx >= arrayLength(&noeuds)) { return; }
  let noeud = noeuds[idx];
  let w = f32(parametres.largeur);
  let h = f32(parametres.hauteur);
  let nb = f32(arrayLength(&noeuds));

  // Rayon identique au miroir CPU : couvre l'image quel que soit N.
  let rayon = max(3.0, sqrt((w * h) / nb) * 1.5);
  let rayon2 = rayon * rayon;

  // Valeur du nœud : onde spatiotemporelle (formule du miroir).
  let valeur = noeud.amplitude * cos(noeud.frequence * parametres.temps + noeud.phase + noeud.posX * 0.01 + noeud.posY * 0.01);

  let x0 = max(0, i32(floor(noeud.posX - rayon)));
  let x1 = min(parametres.largeur - 1, u32(ceil(noeud.posX + rayon)));
  let y0 = max(0, i32(floor(noeud.posY - rayon)));
  let y1 = min(parametres.hauteur - 1, u32(ceil(noeud.posY + rayon)));

  for (var y = y0; y <= i32(y1); y++) {
    for (var x = x0; x <= i32(x1); x++) {
      let dx = f32(x) - noeud.posX;
      let dy = f32(y) - noeud.posY;
      let d2 = dx * dx + dy * dy;
      if (d2 < rayon2) {
        let poids = exp(-d2 / (rayon2 * 0.4));
        let p = u32(y) * parametres.largeur + u32(x);
        // Virgule fixe 2^-16 : l'ajout ATOMIQUE ENTIER reste déterministe.
        atomicAdd(&accumulateur[p], i32(round(valeur * poids * 65536.0)));
        atomicAdd(&poidsPixels[p], u32(round(poids * 65536.0)));
      }
    }
  }
}
`;

export const SHADER_FINALISATION_VIDEO = /* wgsl */ `
struct ParametresFinal {
  largeur : u32,
  hauteur : u32,
  pad0 : f32,
  pad1 : f32,
};

@group(0) @binding(0) var<storage, read> accumulateur : array<i32>;
@group(0) @binding(1) var<storage, read> poidsPixels : array<u32>;
@group(0) @binding(2) var<uniform> parametres : ParametresFinal;
@group(0) @binding(3) var<storage, read_write> trame : array<u32>;

@compute @workgroup_size(256)
fn principal(@builtin(global_invocation_id) id : vec3<u32>) {
  let p = id.x;
  if (p >= parametres.largeur * parametres.hauteur) { return; }
  let poids = f32(poidsPixels[p]);
  var gris : u32 = 128u; // poids nul → gris neutre (miroir : valeur 0)
  if (poids > 0.0) {
    let valeur = f32(accumulateur[p]) / poids;
    // Même formule que le miroir : [-1, 1] → [0, 1] → [0, 255].
    let normalisee = clamp(valeur * 0.5 + 0.5, 0.0, 1.0);
    gris = u32(round(normalisee * 255.0));
  }
  let rgba = (255u << 24) | (gris << 16) | (gris << 8) | gris;
  trame[p] = rgba;
}
`;

// ---------------------------------------------------------------------------
// MIX AUDIO « NŒUDS → PCM » (portage corrigé de Gen3AudioEngine.ts) : la
// source remplissait le PCM avec le placeholder `sin(t × 440)` (son propre
// commentaire demandait « Remplacement par le mix des nœuds GPU »). Ici le
// mix RÉEL des oscillateurs est calculé sur GPU : un thread PAR échantillon,
// somme bornée et normalisée — même formule que synthese-acoustique.ts.
// ---------------------------------------------------------------------------

export const SHADER_MIX_AUDIO = /* wgsl */ `
struct NoeudAcoustique {
  amplitude : f32,
  frequence : f32,
  phase : f32,
  amortissement : f32,
};

struct ParametresMix {
  tempsDebutBloc : f32,
  frequenceEchantillonnage : f32,
  indexSortie : u32,
  nbEchantillonsBloc : u32,
};

@group(0) @binding(0) var<storage, read> noeuds : array<NoeudAcoustique>;
@group(0) @binding(1) var<uniform> parametres : ParametresMix;
@group(0) @binding(2) var<storage, read_write> pcm : array<f32>;

@compute @workgroup_size(256)
fn principal(@builtin(global_invocation_id) id : vec3<u32>) {
  let s = id.x;
  if (s >= parametres.nbEchantillonsBloc) { return; }
  let t = parametres.tempsDebutBloc + f32(s) / parametres.frequenceEchantillonnage;
  let normalisation = 1.0 / f32(arrayLength(&noeuds));
  var somme : f32 = 0.0;
  for (var i = 0u; i < arrayLength(&noeuds); i++) {
    let noeud = noeuds[i];
    // L'amortissement contrôle la contribution (anti-saturation, miroir).
    let contribution = noeud.amplitude * (1.0 - min(1.0, noeud.amortissement * 8.0));
    somme += contribution * sin(2.0 * 3.14159 * noeud.frequence * t + noeud.phase);
  }
  pcm[parametres.indexSortie + s] = clamp(somme * normalisation * 2.0, -1.0, 1.0);
}
`;
