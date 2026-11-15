/**
 * Solveurs numériques du Monde — les outils que la physique appelle.
 *
 * Chaque solveur est pur, déterministe, testé contre des solutions
 * analytiques connues. Le Monde n'« invente » jamais un résultat : il
 * intègre, itère, converge — et rapporte ses diagnostics (erreur,
 * conservation, stabilité) pour que l'IA puisse répondre avec un
 * niveau de confiance honnête.
 */

/** Second membre d'un système différentiel : dY/dt = f(t, Y). */
export type SecondMembre = (t: number, y: number[]) => number[];

/** Pas d'intégration Runge-Kutta 4 sur tout le vecteur d'état. */
export function pasRk4(
  f: SecondMembre,
  t: number,
  y: number[],
  h: number,
): number[] {
  const n = y.length;
  const k1 = f(t, y);
  const y2 = new Array<number>(n);
  const y3 = new Array<number>(n);
  const y4 = new Array<number>(n);
  for (let i = 0; i < n; i++) y2[i] = y[i] + (h / 2) * k1[i];
  const k2 = f(t + h / 2, y2);
  for (let i = 0; i < n; i++) y3[i] = y[i] + (h / 2) * k2[i];
  const k3 = f(t + h / 2, y3);
  for (let i = 0; i < n; i++) y4[i] = y[i] + h * k3[i];
  const k4 = f(t + h, y4);
  const suivant = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    suivant[i] = y[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
  return suivant;
}

export interface SerieTemporelle {
  /** Temps de chaque échantillon. */
  t: number[];
  /** Valeur de chaque composante à chaque temps (série[k] = composante k). */
  series: number[][];
  /** Nombre de pas réellement effectués. */
  pas: number;
}

/** Intègre un système d'équations différentielles par RK4. */
export function integrerRk4(
  f: SecondMembre,
  y0: number[],
  tDebut: number,
  tFin: number,
  pas: number,
  echantillons = 256,
): SerieTemporelle {
  const total = Math.max(1, Math.round((tFin - tDebut) / pas));
  const periode = Math.max(1, Math.floor(total / echantillons));
  const t: number[] = [tDebut];
  const series: number[][] = [y0.slice()];
  let y = y0.slice();
  let temps = tDebut;
  let effectues = 0;
  for (let k = 0; k < total; k++) {
    y = pasRk4(f, temps, y, pas);
    temps += pas;
    effectues += 1;
    if (k % periode === 0 || k === total - 1) {
      t.push(temps);
      series.push(y.slice());
      if (t.length >= 4096) break;
    }
  }
  return { t, series, pas: effectues };
}

/** Recherche de racine par dichotomie (robuste, convergence garantie). */
export function dichotomie(
  f: (x: number) => number,
  a: number,
  b: number,
  tolerance = 1e-10,
  maxIterations = 200,
): number | null {
  let fa = f(a);
  let fb = f(b);
  if (fa * fb > 0) return null;
  if (fa === 0) return a;
  if (fb === 0) return b;
  for (let i = 0; i < maxIterations; i++) {
    const milieu = a + (b - a) / 2;
    const fm = f(milieu);
    if (Math.abs(fm) < tolerance || (b - a) / 2 < tolerance) return milieu;
    if (fa * fm < 0) {
      b = milieu;
      fb = fm;
    } else {
      a = milieu;
      fa = fm;
    }
  }
  return a + (b - a) / 2;
}

/** Recherche de racine par Newton-Raphson avec dérivée numérique (repli dichotomie). */
export function newtonRacine(
  f: (x: number) => number,
  x0: number,
  tolerance = 1e-10,
  maxIterations = 60,
): number | null {
  let x = x0;
  for (let i = 0; i < maxIterations; i++) {
    const fx = f(x);
    if (!Number.isFinite(fx)) return null;
    if (Math.abs(fx) < tolerance) return x;
    const h = Math.max(1e-8, Math.abs(x) * 1e-7);
    const derivee = (f(x + h) - f(x - h)) / (2 * h);
    if (!Number.isFinite(derivee) || Math.abs(derivee) < 1e-14) return null;
    const suivant = x - fx / derivee;
    if (!Number.isFinite(suivant)) return null;
    if (Math.abs(suivant - x) < tolerance) return suivant;
    x = suivant;
  }
  // Convergence lente : repli dichotomique autour du dernier intervalle.
  return dichotomie(f, x - 10, x + 10, tolerance);
}

/** Minimisation 1D par descente du pas d'or (section dorée). */
export function minimiser1D(
  f: (x: number) => number,
  a: number,
  b: number,
  tolerance = 1e-9,
): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  let gauche = a;
  let droite = b;
  let c = droite - phi * (droite - gauche);
  let d = gauche + phi * (droite - gauche);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 200 && Math.abs(droite - gauche) > tolerance; i++) {
    if (fc < fd) {
      droite = d;
      d = c;
      fd = fc;
      c = droite - phi * (droite - gauche);
      fc = f(c);
    } else {
      gauche = c;
      c = d;
      fc = fd;
      d = gauche + phi * (droite - gauche);
      fd = f(d);
    }
  }
  return (gauche + droite) / 2;
}

/** Discretise un champ 2D : applique l'opérateur laplacien 5 points. */
export function laplacien2D(
  champ: Float64Array,
  largeur: number,
  hauteur: number,
  sortie: Float64Array,
): void {
  for (let j = 0; j < hauteur; j++) {
    for (let i = 0; i < largeur; i++) {
      const idx = j * largeur + i;
      if (i === 0 || j === 0 || i === largeur - 1 || j === hauteur - 1) {
        sortie[idx] = 0;
        continue;
      }
      sortie[idx] =
        champ[idx - 1] + champ[idx + 1] + champ[idx - largeur] + champ[idx + largeur] - 4 * champ[idx];
    }
  }
}

/** Résout un système tridiagonal par l'algorithme de Thomas (O(n)). */
export function tridiagonal(
  sous: number[],
  diagonale: number[],
  sur: number[],
  second: number[],
): number[] {
  const n = diagonale.length;
  const c = sur.slice();
  const d = second.slice();
  const cp = new Array<number>(n);
  const dp = new Array<number>(n);
  cp[0] = c[0] / diagonale[0];
  dp[0] = d[0] / diagonale[0];
  for (let i = 1; i < n; i++) {
    const m = diagonale[i] - sous[i] * cp[i - 1];
    cp[i] = i < n - 1 ? c[i] / m : 0;
    dp[i] = (d[i] - sous[i] * dp[i - 1]) / m;
  }
  const x = new Array<number>(n);
  x[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
  return x;
}

/** Transformée de Fourier discrète (Cooley-Tukey si puissance de 2, sinon naïve). */
export function dft(signal: number[]): { re: number[]; im: number[] } {
  const n = signal.length;
  if (n === 0) return { re: [], im: [] };
  if ((n & (n - 1)) === 0) return fftRadix2(signal);

  const re = new Array<number>(n).fill(0);
  const im = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let j = 0; j < n; j++) {
      const angle = (-2 * Math.PI * k * j) / n;
      sr += signal[j] * Math.cos(angle);
      si += signal[j] * Math.sin(angle);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

/** FFT itérative radix-2 (entrée de longueur puissance de 2). */
function fftRadix2(signal: number[]): { re: number[]; im: number[] } {
  const n = signal.length;
  const re = signal.slice();
  const im = new Array<number>(n).fill(0);
  // Permutation bit-reverse.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let longueur = 2; longueur <= n; longueur <<= 1) {
    const angle = (-2 * Math.PI) / longueur;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let debut = 0; debut < n; debut += longueur) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < longueur / 2; k++) {
        const uRe = re[debut + k];
        const uIm = im[debut + k];
        const idx = debut + k + longueur / 2;
        const vRe = re[idx] * curRe - im[idx] * curIm;
        const vIm = re[idx] * curIm + im[idx] * curRe;
        re[idx] = uRe - vRe;
        im[idx] = uIm - vIm;
        re[debut + k] = uRe + vRe;
        im[debut + k] = uIm + vIm;
        const suivant = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = suivant;
      }
    }
  }
  return { re, im };
}

/** Intégration par Monte-Carlo : moyenne d'échantillons uniformes. */
export function monteCarloIntegrale(
  f: (x: number) => number,
  a: number,
  b: number,
  echantillons = 200_000,
  graine = 42,
): { valeur: number; incertitude: number } {
  // Générateur xorshift déterministe — reproductible pour les tests.
  let etat = graine || 1;
  const suivant = () => {
    etat ^= etat << 13;
    etat ^= etat >>> 17;
    etat ^= etat << 5;
    return (etat >>> 0) / 4294967296;
  };
  let somme = 0;
  let sommeCarres = 0;
  for (let i = 0; i < echantillons; i++) {
    const x = a + (b - a) * suivant();
    const v = f(x);
    somme += v;
    sommeCarres += v * v;
  }
  const moyenne = somme / echantillons;
  const variance = Math.max(0, sommeCarres / echantillons - moyenne * moyenne);
  return {
    valeur: moyenne * (b - a),
    incertitude: (b - a) * Math.sqrt(variance / echantillons),
  };
}

/** Dérivée numérique centrale (ordre 2). */
export function deriveeNumerique(f: (x: number) => number, x: number, h = 1e-6): number {
  return (f(x + h) - f(x - h)) / (2 * h);
}

/** Détection de pic : renvoie l'indice et la valeur du maximum absolu. */
export function picMaximum(valeurs: ArrayLike<number>): { index: number; valeur: number } {
  let index = 0;
  let valeur = 0;
  for (let i = 0; i < valeurs.length; i++) {
    const v = Math.abs(valeurs[i]);
    if (v > valeur) {
      valeur = v;
      index = i;
    }
  }
  return { index, valeur };
}
