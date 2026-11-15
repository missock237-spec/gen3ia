// scripts/load/k6-stress.js — test de charge STRESS progressif (Task 130).
//
// Objectif : révéler le comportement de la plateforme SOUS charge croissante
// — montée en charge (5 → 50 VU), plateau à 50 VU, puis descente pour
// observer la récupération. Ce profil cherche volontairement les points de
// dégradation (latence qui explose, erreurs 5xx, saturations) AVANT que les
// utilisateurs réels ne les rencontrent.
//
// Usage (voir docs/load-testing.md — À LIRE AVANT DE LANCER CONTRE LA
// PRODUCTION : fenêtre communiquée, supervision /api/status active) :
//   k6 run scripts/load/k6-stress.js
//   BASE_URL=http://localhost:3000 k6 run scripts/load/k6-stress.js
//
// ⚠ ÉTHIQUE : ne cibler QUE gen3ia.online (notre propriété) ou un
// environnement local — JAMAIS un service tiers. Ce n'est PAS un test DoS :
// la montée est progressive et bornée, le test s'arrête seul si la cible
// montre des signes de souffrance (cf. abortOnFail ci-dessous).

import http from 'k6/http';
import { check, group } from 'k6';

// URL de base — surchargeable en local via la variable d'environnement
// BASE_URL (k6 l'expose dans __ENV), production par défaut.
export const BASE_URL = __ENV.BASE_URL || 'https://gen3ia.online';

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      // Départ à 5 VU (niveau « fumée ») pour valider la ligne de base
      // avant d'augmenter la pression.
      startVUs: 5,
      stages: [
        // Montée progressive 5 → 50 VU en 5 minutes : assez lente pour
        // observer OÙ la latence commence à croître (coude de saturation),
        // pas un pic brutal qui ne ressemble à aucun trafic réel.
        { duration: '5m', target: 50 },
        // Plateau 5 minutes à 50 VU : c'est ici que se révèlent les
        // faiblesses qui n'apparaissent pas sur un pic court — fuites,
        // exhaustion de quotas, dégradation de GC, files d'attente qui
        // s'allongent, fonctions serveur à froid (Cold Starts).
        { duration: '5m', target: 50 },
        // Descente 50 → 0 VU en 3 minutes : vérifie la RÉCUPÉRATION —
        // la latence doit revenir à la ligne de base ; sinon, des
        // ressources restent saturées (files, caches pleins, instances
        // qui ne redescendent pas).
        { duration: '3m', target: 0 },
      ],
    },
  },

  thresholds: {
    // p(95) < 2000 ms : sous charge maximale (50 VU), 95 % des requêtes
    // doivent rester sous 2 s. Seuil volontairement plus large que le smoke
    // (800 ms) : la latence croît mécaniquement avec la charge ; 2 s au
    // p95 en stress est le dernier seuil acceptable avant l'abandon
    // d'utilisateurs réels (au-delà, taux de rebond documenté > 50 %).
    http_req_duration: [{ threshold: 'p(95)<2000' }],

    // Taux d'échec < 2 % : http_req_failed agrège les erreurs réseau et
    // les réponses 4xx/5xx. La marge (vs 1 % en smoke) admet quelques
    // timeouts isolés sous charge ; au-delà de 2 %, la plateforme est en
    // souffrance. `abortOnFail: true` = garde-fou de production : le test
    // S'ARRÊTE immédiatement — continuer à charger une cible qui échoue
    // ne relèverait plus du test de charge mais d'une attaque DoS.
    http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true }],
  },
};

// Vérifie que la réponse est un JSON valide dont le champ `champ` vaut
// `attendu` — protège contre les réponses HTML (page d'erreur CDN,
// erreurs 5xx « habillées ») qui fausseraient les checks sans le signaler.
function jsonEstValide(reponse, champ, attendu) {
  try {
    return reponse.json()[champ] === attendu;
  } catch {
    return false;
  }
}

// Fonction nommée (exigée par la règle ESLint import/no-anonymous-default-export).
export default function profilStress() {
  // Endpoints visés par le stress : UNIQUEMENT les deux sondes publiques
  // conçues pour être interrogées en continu par les moniteurs (/api/health
  // sans dépendance, /api/status protégé par un cache CDN 30 s). Les
  // routes métier (conversations, agents, facturation) sont exclues du
  // stress : elles déclenchent des coûts (Firebase, R2, LLM) et ne sont
  // pas conçues pour absorber du trafic synthétique massif.
  group('GET /api/health', () => {
    const sante = http.get(`${BASE_URL}/api/health`);
    check(sante, {
      'statut HTTP 200': (r) => r.status === 200,
      'JSON valide — status: "ok"': (r) => jsonEstValide(r, 'status', 'ok'),
    });
  });

  group('GET /api/status', () => {
    const statut = http.get(`${BASE_URL}/api/status`);
    check(statut, {
      'statut HTTP 200': (r) => r.status === 200,
      'JSON valide — status: "ok"': (r) => jsonEstValide(r, 'status', 'ok'),
    });
  });
}
