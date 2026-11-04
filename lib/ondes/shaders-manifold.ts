/**
 * SHADERS MANIFOLD — micro-décodeurs WebGPU de la Phase 2 (génération
 * multimodale locale à ultra-faible consommation).
 *
 * Chaque modalité a son décodeur dédié, un compute shader LÉGER qui lit
 * le tenseur d'onde commun (lib/ondes/manifold.ts) et le reconvertit en
 * signal de sortie — SANS réseau de diffusion, SANS espace latent lourd :
 *  · IMAGE  — synthèse harmonique + ondelettes procédurales : chaque
 *    harmonique du tenseur est une ondelette porteuse (bande de
 *    fréquence + orientation) ; les normales et l'éclairage dérivent du
 *    gradient local (rendu procédural temps réel) ;
 *  · AUDIO  — oscillateurs sinusoïdaux pilotés par phase : la
 *    fondamentale module la hauteur (F0), les amplitudes modulent
 *    l'enveloppe spectrale (timbre) ;
 *  · VIDÉO  — propagation spatiotemporelle par dérive de phase : la
 *    trame T+1 est la trame T échantillonnée à travers la MATRICE DE
 *    DÉPHASAGE vectorielle du tenseur (flux optique par phase), plus une
 *    résurrection d'énergie harmonique qui empêche l'affadissement.
 *
 * CONTRAT DES MIROIRS CPU : chaque shader a son jumeau exact dans
 * `micro-decodeurs.ts` (même physique, mêmes formules, déterminisme
 * bit à bit) — WebGPU accélère, le CPU spécifie. Les tests exécutent
 * les miroirs (WebGPU indisponible en environnement de test).
 */

/* ------------------------------------------------------------------ */
/* Décodeur IMAGE — wavelets procédurales + éclairage                  */
/* ------------------------------------------------------------------ */

export const SHADER_DECODE_IMAGE_WAVELET = /* wgsl */ `
// Micro-décodeur image — synthèse d'harmoniques → ondelettes → pixels.
// Chaque invocation calcule UN pixel : somme des harmoniques actives du
// tenseur (activation sparse : seuil d'amplitude uniforme), puis
// éclairage procédural (normale par différences finies, lambertien).

struct ParamsImage {
  largeur: u32,
  hauteur: u32,
  nbNoeuds: u32,
  fondamentale: f32,
  seuilSparse: f32,
  echelleEspace: f32,
  gainLumiere: f32,
};

@group(0) @binding(0) var<uniform> params: ParamsImage;
@group(0) @binding(1) var<storage, read> tenseur: array<u32>; // (amplitude<<16)|phase
@group(0) @binding(2) var rendu: texture_storage_2d<rgba8unorm, write>;

fn phaseDuCran(cran: u32) -> f32 {
  return (f32(cran) / 65535.0) * 6.283185307179586;
}

fn amplitudeDuCran(cran: u32) -> f32 {
  return f32(cran) / 65535.0;
}

@compute @workgroup_size(8, 8)
fn decoderImage(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.largeur || gid.y >= params.hauteur) { return; }
  let u = f32(gid.x) / f32(params.largeur);
  let v = f32(gid.y) / f32(params.hauteur);
  var valeur = 0.0;
  for (var i: u32 = 0u; i < params.nbNoeuds; i = i + 1u) {
    let paquet = tenseur[i];
    let amplitude = amplitudeDuCran(paquet & 0xffffu);
    if (amplitude < params.seuilSparse) { continue; } // calcul sparse
    let phase = phaseDuCran(paquet >> 16u);
    // Direction de l'ondelette : déterministe (nombre d'or, i).
    let phi = f32(i) * 2.399963229728653;
    let freq = params.fondamentale * (1.0 + f32(i) / f32(params.nbNoeuds)) * params.echelleEspace;
    let fx = cos(phi) * freq;
    let fy = sin(phi) * freq;
    valeur = valeur + amplitude * sin(6.283185307179586 * (fx * u + fy * v) + phase);
  }
  // Ondelette de détail Haar : la cellule 2×2 enrichit la texture.
  valeur = valeur * 0.8 + 0.2 * sin(u * 251.0 + v * 127.0) * 0.25;
  let lum = clamp(0.5 + 0.5 * valeur, 0.0, 1.0);
  // Éclairage procédural : gradient ANALYTIQUE du champ (dérivée exacte
  // des harmoniques — même formule dans le miroir CPU), normale, lambertien.
  var gxx = 0.0;
  var gyy = 0.0;
  for (var i: u32 = 0u; i < params.nbNoeuds; i = i + 1u) {
    let paquet = tenseur[i];
    let amplitude = amplitudeDuCran(paquet & 0xffffu);
    if (amplitude < params.seuilSparse) { continue; }
    let phase = phaseDuCran(paquet >> 16u);
    let phi = f32(i) * 2.399963229728653;
    let freq = params.fondamentale * (1.0 + f32(i) / f32(params.nbNoeuds)) * params.echelleEspace;
    let fx = cos(phi) * freq;
    let fy = sin(phi) * freq;
    let arg = 6.283185307179586 * (fx * u + fy * v) + phase;
    gxx = gxx + amplitude * 6.283185307179586 * fx * cos(arg);
    gyy = gyy + amplitude * 6.283185307179586 * fy * cos(arg);
  }
  let normale = normalize(vec3f(-gxx, -gyy, 1.0));
  let lambert = max(dot(normalize(vec3f(0.4, 0.5, 0.77)), normale), 0.0);
  let clair = lum * (0.55 + params.gainLumiere * lambert);
  textureStore(rendu, vec2<i32>(gid.xy), vec4f(clair, clair, clair, 1.0));
}
`;

/* ------------------------------------------------------------------ */
/* Décodeur AUDIO — oscillateurs pilotés par phase                     */
/* ------------------------------------------------------------------ */

export const BLOC_ECHANTILLONS_MANIFOLD = 1024;

export const SHADER_DECODE_AUDIO_PHASE = /* wgsl */ `
// Micro-décodeur audio — banque d'oscillateurs sinusoïdaux pilotés par
// phase. Chaque invocation calcule UN échantillon : somme des
// oscillateurs actifs du tenseur (sparse), hauteur portée par la
// fondamentale (F0 → registre audible), timbre par l'enveloppe
// harmonique (amplitudes décroissantes).

struct ParamsAudio {
  nbEchantillons: u32,
  nbNoeuds: u32,
  fondamentale: f32,
  freqEchantillonnage: f32,
  f0Audible: f32,
  etendueOctaves: f32,
  seuilSparse: f32,
};

@group(0) @binding(0) var<uniform> params: ParamsAudio;
@group(0) @binding(1) var<storage, read> tenseur: array<u32>; // (amplitude<<16)|phase
@group(0) @binding(2) var<storage, read_write> pcm: array<f32>;

@compute @workgroup_size(256)
fn decoderAudio(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= params.nbEchantillons) { return; }
  let t = f32(s) / params.freqEchantillonnage;
  var somme = 0.0;
  var energie = 0.0;
  for (var i: u32 = 0u; i < params.nbNoeuds; i = i + 1u) {
    let paquet = tenseur[i];
    let amplitude = f32(paquet & 0xffffu) / 65535.0;
    if (amplitude < params.seuilSparse) { continue; } // calcul sparse
    let phase = (f32(paquet >> 16u) / 65535.0) * 6.283185307179586;
    // Hauteur : F0 du tenseur module le registre, réparti sur les octaves.
    let position = f32(i) / f32(params.nbNoeuds);
    let freq = params.f0Audible * pow(2.0, params.etendueOctaves * position) * (params.fondamentale / 0.08);
    somme = somme + amplitude * sin(6.283185307179586 * freq * t + phase);
    energie = energie + amplitude;
  }
  // Normalisation par l'énergie active (anti-saturation, comme le mix RPIA).
  let gain = select(0.0, 2.0 / max(energie, 1.0), energie > 0.0);
  pcm[s] = clamp(somme * gain, -1.0, 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Décodeur VIDÉO — dérive de phase (flux optique)                     */
/* ------------------------------------------------------------------ */

export const SHADER_DECODE_VIDEO_DERIVE = /* wgsl */ `
// Micro-décodeur vidéo — propagation spatiotemporelle par dérive de
// phase. La trame T+1 est la trame T échantillonnée (bilineáire) à
// travers le champ de déphasage vectoriel (dx, dy) = A·(cos θ, sin θ)
// dérivé du tenseur, plus une résurrection d'énergie qui réinjecte les
// harmoniques actives (anti-affadissement de l'advection).

struct ParamsVideo {
  largeur: u32,
  hauteur: u32,
  nbNoeuds: u32,
  coteGrille: u32,
  amplitudeDerive: f32,
  gainResurrection: f32,
  seuilSparse: f32,
};

@group(0) @binding(0) var<uniform> params: ParamsVideo;
@group(0) @binding(1) var<storage, read> tenseur: array<u32>; // (amplitude<<16)|phase
@group(0) @binding(2) var trameT: texture_2d<f32>;
@group(0) @binding(3) var trameT1: texture_storage_2d<rgba8unorm, write>;

fn echantillonnerTrame(uv: vec2f) -> vec4f {
  let dims = vec2f(f32(params.largeur), f32(params.hauteur));
  let pos = clamp(uv * dims, vec2f(0.0), dims - vec2f(1.0));
  let base = floor(pos);
  let frac = pos - base;
  let x0 = u32(base.x); let y0 = u32(base.y);
  let x1 = min(x0 + 1u, params.largeur - 1u);
  let y1 = min(y0 + 1u, params.hauteur - 1u);
  let c00 = textureLoad(trameT, vec2<u32>(x0, y0), 0);
  let c10 = textureLoad(trameT, vec2<u32>(x1, y0), 0);
  let c01 = textureLoad(trameT, vec2<u32>(x0, y1), 0);
  let c11 = textureLoad(trameT, vec2<u32>(x1, y1), 0);
  return mix(mix(c00, c10, frac.x), mix(c01, c11, frac.x), frac.y);
}

@compute @workgroup_size(8, 8)
fn deriverTrame(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.largeur || gid.y >= params.hauteur) { return; }
  let u = f32(gid.x) / f32(params.largeur);
  let v = f32(gid.y) / f32(params.hauteur);
  // Champ de dérive : échantillonnage bilinéaire de la grille du tenseur.
  let g = f32(params.coteGrille - 1u);
  let gu = u * g;
  let gv = v * g;
  let g0 = vec2<u32>(u32(gu), u32(gv));
  let g1 = min(g0 + vec2<u32>(1u, 1u), vec2<u32>(params.coteGrille - 1u));
  let frac = vec2f(gu - f32(g0.x), gv - f32(g0.y));

  let p00 = tenseur[g0.y * params.coteGrille + g0.x];
  let p10 = tenseur[g0.y * params.coteGrille + g1.x];
  let p01 = tenseur[g1.y * params.coteGrille + g0.x];
  let p11 = tenseur[g1.y * params.coteGrille + g1.x];
  let a00 = vec2f(f32(p00 & 0xffffu) / 65535.0, f32(p00 >> 16u) / 65535.0 * 6.283185307179586);
  let a10 = vec2f(f32(p10 & 0xffffu) / 65535.0, f32(p10 >> 16u) / 65535.0 * 6.283185307179586);
  let a01 = vec2f(f32(p01 & 0xffffu) / 65535.0, f32(p01 >> 16u) / 65535.0 * 6.283185307179586);
  let a11 = vec2f(f32(p11 & 0xffffu) / 65535.0, f32(p11 >> 16u) / 65535.0 * 6.283185307179586);
  let interp = mix(mix(a00, a10, frac.x), mix(a01, a11, frac.x), frac.y);
  let derive = vec2f(cos(interp.y), sin(interp.y)) * interp.x * params.amplitudeDerive;

  let uvDerive = vec2f(u, v) + derive / vec2f(f32(params.largeur), f32(params.hauteur));
  var couleur = echantillonnerTrame(uvDerive);
  // Résurrection d'énergie : les harmoniques actives ré-illuminent.
  couleur = clamp(couleur + params.gainResurrection * vec4f(interp.xxx), vec4f(0.0), vec4f(1.0));
  textureStore(trameT1, vec2<i32>(gid.xy), vec4f(couleur.rgb, 1.0));
}
`;
