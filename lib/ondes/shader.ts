/**
 * Compute shader WebGPU du moteur W-DNN — exécuté sur le GPU de
 * l'utilisateur. Chaque thread calcule l'état d'un oscillateur de la
 * grille (amplitude + phase de Kuramoto) à partir de ses voisins :
 * le GPU ne calcule ni pixels ni matrices, il propage une onde.
 *
 * Physique (MIRROIR exact de `champ.ts`, l'implémentation CPU) :
 *   · équation d'onde discrète avec amortissement neuronal ;
 *   · couplage de phase de Kuramoto 4-connexe (K·dt·Σ sin(θⱼ−θᵢ)) ;
 *   · gain cohérent : les zones synchronisées amplifient l'onde ;
 *   · injection d'impulsions gaussiennes (max 16 par pas).
 *
 * Triple bufferisation côté hôte : amp_actuel / amp_passe / amp_suivant
 * sont re-liés en cycle par 3 bind groups (aucune copie GPU→GPU par pas).
 */

export const SHADER_ONDES = /* wgsl */ `
struct Params {
  largeur : u32,
  hauteur : u32,
  nbImpulsions : u32,
  pas : u32,
  c2 : f32,
  amortissement : f32,
  couplage : f32,
  dt : f32,
  gain : f32,
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};

@group(0) @binding(0) var<storage, read> amp_actuel : array<f32>;
@group(0) @binding(1) var<storage, read> amp_passe : array<f32>;
@group(0) @binding(2) var<storage, read_write> amp_suivant : array<f32>;
@group(0) @binding(3) var<storage, read_write> phase : array<f32>;
@group(0) @binding(4) var<storage, read> freq : array<f32>;
@group(0) @binding(5) var<uniform> params : Params;
// Une impulsion = vec4 (x, y, amplitude, fréquence). 16 max par pas.
@group(0) @binding(6) var<uniform> impulsions : array<vec4<f32>, 16>;

const RAYON_INJECTION : f32 = 2.5;

@compute @workgroup_size(8, 8)
fn principal(@builtin(global_invocation_id) gid : vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  let w = params.largeur;
  let h = params.hauteur;
  if (x >= w || y >= h) {
    return;
  }
  let i = y * w + x;

  // Bords absorbants : l'onde meurt au bord, la phase continue de vivre.
  if (x == 0u || x == w - 1u || y == 0u || y == h - 1u) {
    amp_suivant[i] = 0.0;
    phase[i] = phase[i] + freq[i] * params.dt;
    return;
  }

  let centre = amp_actuel[i];
  let passe = amp_passe[i];
  let gauche = amp_actuel[i - 1u];
  let droite = amp_actuel[i + 1u];
  let haut = amp_actuel[i - w];
  let bas = amp_actuel[i + w];

  // 1) Propagation d'onde discrète (d'Alembert) + amortissement.
  var valeur = (2.0 * centre - passe + params.c2 * (gauche + droite + haut + bas - 4.0 * centre)) * params.amortissement;

  // 2) Couplage de phase de Kuramoto (voisinage 4-connexe).
  let ph = phase[i];
  let sync = sin(phase[i - 1u] - ph) + sin(phase[i + 1u] - ph) + sin(phase[i - w] - ph) + sin(phase[i + w] - ph);
  phase[i] = ph + freq[i] * params.dt + params.couplage * params.dt * sync;

  // 3) Gain cohérent : la synchronisation locale amplifie l'onde —
  //    la résonance émerge de la synchronisation.
  valeur = valeur + params.gain * (sync * 0.25) * centre;

  // 4) Injection d'impulsions (gaussiennes + attraction de phase).
  for (var k : u32 = 0u; k < params.nbImpulsions; k = k + 1u) {
    let imp = impulsions[k];
    let dx = f32(x) - imp.x;
    let dy = f32(y) - imp.y;
    let d2 = dx * dx + dy * dy;
    if (d2 < RAYON_INJECTION * RAYON_INJECTION) {
      valeur = valeur + imp.z * exp(-d2 / 1.4);
      phase[i] = phase[i] + 0.5 * sin(imp.w * f32(params.pas) - ph);
    }
  }

  amp_suivant[i] = valeur;
}
`;
