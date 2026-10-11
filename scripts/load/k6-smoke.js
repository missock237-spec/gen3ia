// scripts/load/k6-smoke.js — test de charge SMOKE (Task 130).
//
// Objectif : vérifier en ~30 secondes que les surfaces publiques essentielles
// tiennent une charge légère sans régression (erreurs 5xx, latence hors
// norme). Ce profil ne cherche PAS les limites de la plateforme — c'est le
// rôle de k6-stress.js — mais à détecter un déploiement dégradé avant les
// utilisateurs réels.
//
// Usage (voir docs/load-testing.md) :
//   k6 run scripts/load/k6-smoke.js
//   BASE_URL=http://localhost:3000 k6 run scripts/load/k6-smoke.js
//
// ⚠ ÉTHIQUE : ne cibler QUE gen3ia.online (notre propriété) ou un
// environnement local — JAMAIS un service tiers.

import http from 'k6/http';
import { check, group } from 'k6';

// URL de base — surchargeable en local via la variable d'environnement
// BASE_URL (k6 l'expose dans __ENV), production par défaut.
export const BASE_URL = __ENV.BASE_URL || 'https://gen3ia.online';

export const options = {
  // Profil SMOKE : 5 utilisateurs virtuels (VU) pendant 30 secondes.
  // Chaque VU rejoue la boucle ci-dessous (3 requêtes) en continu.
  vus: 5,
  duration: '30s',

  thresholds: {
    // p(95) < 800 ms : 95 % des requêtes doivent répondre en moins de
    // 800 ms. /api/health est un heartbeat sans dépendance et /api/status
    // est protégé par un cache CDN 30 s — au-delà de 800 ms au 95e
    // percentile, un utilisateur perçoit une application lente et le
    // déploiement doit être investigué avant d'aller plus loin.
    http_req_duration: ['p(95)<800'],

    // Taux d'échec < 1 % : http_req_failed agrège les erreurs réseau
    // (timeout, connexion refusée) ET les réponses 4xx/5xx. Un déploiement
    // sain est à 0 % ; la marge de 1 % couvre une micro-coupure réseau
    // ponctuelle, pas une dégradation réelle.
    http_req_failed: ['rate<0.01'],
  },
};

// Vérifie que la réponse est un JSON valide dont le champ `champ` vaut
// `attendu`. Protège contre les réponses HTML (page d'erreur CDN,
// erreurs 5xx « habillées ») qui casseraient silencieusement les moniteurs
// JSON : un corps non parsable en JSON invalide le check, pas le test entier.
function jsonEstValide(reponse, champ, attendu) {
  try {
    return reponse.json()[champ] === attendu;
  } catch {
    return false;
  }
}

// Fonction nommée (exigée par la règle ESLint import/no-anonymous-default-export).
export default function profilSmoke() {
  // 1. /api/health — heartbeat ultra-léger (aucune dépendance externe,
  //    Cache-Control: no-store) : la référence de latence minimale.
  group('GET /api/health', () => {
    const sante = http.get(`${BASE_URL}/api/health`);
    check(sante, {
      'statut HTTP 200': (r) => r.status === 200,
      'JSON valide — status: "ok"': (r) => jsonEstValide(r, 'status', 'ok'),
    });
  });

  // 2. /api/status — statut public des services (auth, r2, ticks) pour les
  //    moniteurs d'uptime. Renvoie 503 dès qu'un service est dégradé : le
  //    check « 200 » fait donc aussi office de sonde de santé applicative.
  group('GET /api/status', () => {
    const statut = http.get(`${BASE_URL}/api/status`);
    check(statut, {
      'statut HTTP 200': (r) => r.status === 200,
      'JSON valide — status: "ok"': (r) => jsonEstValide(r, 'status', 'ok'),
      'JSON valide — services décrits': (r) => {
        try {
          return typeof r.json().services === 'object';
        } catch {
          return false;
        }
      },
    });
  });

  // 3. /login — page de connexion (rendu serveur Next.js, SSR) : seule
  //    page non-API du smoke, elle vérifie que le rendu HTML de base
  //    répond (CSP, middleware, polices, assets) sans erreur.
  group('GET /login', () => {
    const connexion = http.get(`${BASE_URL}/login`);
    check(connexion, {
      'statut HTTP 200': (r) => r.status === 200,
      'rendu HTML (page de connexion)': (r) =>
        (r.headers['Content-Type'] || '').includes('text/html'),
    });
  });
}
