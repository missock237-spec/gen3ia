// scripts/charge/k6-chat-smoke.js — test de charge SMOKE « pré-déploiement »
// dimensionné pour le VPS de production 2 Go (Pilier 4 — excellence
// opérationnelle : un déploiement MAJEUR est précédé d'un test de charge).
//
// Malgré son nom (hérité de la mission « chat »), ce scénario ne cible
// VOLONTAIREMENT AUCUN endpoint de chat / IA : une requête de conversation
// déclenche un appel LLM (coût réel, latence en secondes, RAM sensible sur
// 2 Go). Le smoke mesure l'INFRASTRUCTURE de base — middleware, rendu
// d'accueil, sondes publiques — c'est-à-dire ce qui casse en premier quand
// un déploiement est dégradé. Le profil de charge progressif reste
// scripts/load/k6-stress.js (cf. docs/load-testing.md).
//
// Usage :
//   k6 run scripts/charge/k6-chat-smoke.js
//   BASE_URL=http://localhost:3000 k6 run scripts/charge/k6-chat-smoke.js
//   (exécution possible depuis GitHub : workflow MANUEL
//   .github/workflows/load-test.yml — jamais automatique)
//
// ⚠ ÉTHIQUE : ne cibler QUE gen3ia.online (notre propriété) ou un
// environnement local — JAMAIS un service tiers (cf. docs/load-testing.md §7).

import http from 'k6/http';
import { check, group, sleep } from 'k6';

// URL de base — surchargeable en local via la variable d'environnement
// BASE_URL (k6 l'expose dans __ENV), production par défaut.
export const BASE_URL = __ENV.BASE_URL || 'https://gen3ia.online';

export const options = {
  // Profil SMOKE VPS 2 Go : 10 utilisateurs virtuels pendant 60 secondes.
  // Chaque VU rejoue la boucle ci-dessous (3 requêtes + 1 s de pause),
  // soit ≈ 20-25 requêtes/s au total : une charge qui met en évidence une
  // régression évidente SANS risquer de saturer la machine (2 Go de RAM,
  // Node.js + PM2 + nginx cohabitent sur le même hôte).
  vus: 10,
  duration: '60s',

  thresholds: {
    // p(95) < 3 000 ms : 95 % des requêtes répondent en moins de 3 s.
    // La marge est volontairement large pour un VPS 2 Go : elle couvre le
    // rendu SSR de la page d'accueil (polices, middleware CSP, rendu
    // React), la poignée de main TLS depuis un runner GitHub et le calme
    // relatif d'une machine modeste. Au-delà de 3 s au 95e percentile, un
    // utilisateur réel perçoit une application cassée : le déploiement
    // doit être gelé et investigué (rollback .next.old côté VPS, cf.
    // docs/runbooks/incident-response.md) AVANT d'aller plus loin.
    http_req_duration: ['p(95)<3000'],

    // Taux d'échec < 1 % : http_req_failed agrège les erreurs réseau
    // (timeout, connexion refusée) ET les réponses 4xx/5xx. Un déploiement
    // sain est à 0 % ; la marge de 1 % couvre une micro-coupure réseau
    // ponctuelle, pas une dégradation réelle.
    http_req_failed: ['rate<0.01'],
  },
};

// Vérifie que la réponse est un JSON valide dont le champ `champ` vaut
// `attendu`. Protège contre les réponses HTML (page d'erreur nginx, erreurs
// 5xx « habillées ») qui casseraient silencieusement les moniteurs JSON :
// un corps non parsable en JSON invalide le check, pas le test entier.
function jsonEstValide(reponse, champ, attendu) {
  try {
    return reponse.json()[champ] === attendu;
  } catch {
    return false;
  }
}

// Fonction nommée (exigée par la règle ESLint import/no-anonymous-default-export).
export default function profilSmokeVps() {
  // 1. / — page d'accueil (rendu serveur Next.js) : le chemin le plus
  //    complet côté infra en une requête — middleware + CSP, rendu React,
  //    assets statiques référencés. C'est la première page que voient les
  //    visiteurs ; si elle s'effondre sous 10 VU, rien ne sert de tester
  //    plus loin.
  group('GET /', () => {
    const accueil = http.get(`${BASE_URL}/`);
    check(accueil, {
      'statut HTTP 200': (r) => r.status === 200,
      'rendu HTML (page d\'accueil)': (r) =>
        (r.headers['Content-Type'] || '').includes('text/html'),
    });
  });

  // 2. /api/health — heartbeat ultra-léger (aucune dépendance externe :
  //    pas de Firestore, pas de R2, pas d'auth ; Cache-Control: no-store) :
  //    la référence de latence minimale de la plateforme. Répondre hors
  //    délai ici signale un process Node saturé, pas une route lente.
  group('GET /api/health', () => {
    const sante = http.get(`${BASE_URL}/api/health`);
    check(sante, {
      'statut HTTP 200': (r) => r.status === 200,
      'JSON valide — status: "ok"': (r) => jsonEstValide(r, 'status', 'ok'),
    });
  });

  // 3. /api/deploy-info — empreinte du build servi, l'API publique la plus
  //    légère du dépôt (lecture d'un fichier de ~20 octets, aucun SDK, aucun
  //    accès base — cf. app/api/deploy-info/route.ts). Elle est sondée en
  //    continu par chaque onglet ouvert (DeployWatcher) : sa tenue sous
  //    charge prouve que le mécanisme de rechargement automatique des
  //    navigateurs ne dérive pas pendant un pic de trafic.
  group('GET /api/deploy-info', () => {
    const empreinte = http.get(`${BASE_URL}/api/deploy-info`);
    check(empreinte, {
      'statut HTTP 200': (r) => r.status === 200,
      'JSON valide — ok: true': (r) => jsonEstValide(r, 'ok', true),
      'JSON valide — deploymentId présent': (r) => {
        try {
          const corps = r.json();
          return typeof corps.deploymentId === 'string' && corps.deploymentId.length > 0;
        } catch {
          return false;
        }
      },
    });
  });

  // Pause d'une seconde entre chaque boucle : le smoke n'est pas un test de
  // saturation — il simule des visiteurs réels et laisse le VPS respirer
  // (GC Node.js, quotas nginx). Pour chercher les limites, utiliser
  // scripts/load/k6-stress.js (montée progressive + abortOnFail).
  sleep(1);
}
