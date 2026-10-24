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
  pasDeTemps : f32,
  pad0 : f32,
};

@group(0) @binding(0) var<storage, read_write> noeuds : array<NoeudOnde>;
@group(0) @binding(1) var<storage, read> ondeCible : array<f32>;
@group(0) @binding(2) var<uniform> parametres : ParametresEntrainement;

@compute @workgroup_size(256)
fn principal(@builtin(global_invocation_id) id : vec3<u32>) {
  let idx = id.x;
  var noeud = noeuds[idx];
  let cible = ondeCible[idx];

  // 1. Propagation de l'onde avant (Forward Wave Pass).
  let ondeAvant = noeud.amplitude * cos(noeud.frequence * parametres.pasDeTemps + noeud.phase);

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
