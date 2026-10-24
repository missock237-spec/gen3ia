/**
 * gen3ia — NŒUD NAVIGATEUR DE L'ESSAIM (service worker MV3).
 *
 * RÈGLE ABSOLUE (lib/essaim-agents/orchestrateur.ts) : tout passe par le
 * cortex Gen3. Ce service worker :
 *  1. porte la configuration (instance gen3ia + clé g3a_ + projet) ;
 *  2. récupère le manifeste de nœud (GET /api/v1/essaim/manifeste) — la
 *     plateforme définit ce que le navigateur peut réclamer ;
 *  3. exécute LOCALEMENT les tâches de ses spécialités navigateur
 *     (veille / tri / calcul) et remonte chaque compte rendu au cortex
 *     via POST /api/v1/chat (jamais d'agent qui « parle » librement) ;
 *  4. n'envoie JAMAIS le contenu d'une page sans action explicite
 *     (message envoyé ou tâche demandée) — confidentialité stricte.
 */

const CLE_CONFIG = "config";

let configCache = null;

async function lireConfig() {
  if (configCache) return configCache;
  const store = await chrome.storage.local.get(CLE_CONFIG);
  configCache = store[CLE_CONFIG] ?? null;
  return configCache;
}

async function ecrireConfig(config) {
  configCache = config;
  await chrome.storage.local.set({ [CLE_CONFIG]: config });
}

/** Appel authentifié vers l'instance gen3ia configurée — UNIQUE destination. */
async function appelGen3(chemin, options = {}) {
  const config = await lireConfig();
  if (!config?.baseUrl || !config?.apiKey) {
    throw new Error("Extension non configurée : renseignez l'instance, la clé g3a_ et l'ID de projet.");
  }
  const reponse = await fetch(`${config.baseUrl.replace(/\/+$/, "")}${chemin}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      "x-gen3ia-project-id": config.projectId || "sans-projet",
      ...(options.headers ?? {}),
    },
  });
  const corps = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    throw new Error(corps.error || `Erreur gen3ia (${reponse.status}).`);
  }
  return corps;
}

/* ------------------------------------------------------------------ */
/* Messages du sidepanel / popup                                       */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "config:get":
          sendResponse({ ok: true, config: await lireConfig() });
          return;
        case "config:set":
          await ecrireConfig(message.config);
          sendResponse({ ok: true });
          return;
        case "manifeste:get": {
          const manifeste = await appelGen3("/api/v1/essaim/manifeste");
          sendResponse({ ok: true, manifeste });
          return;
        }
        case "chat:envoyer": {
          // Le contexte de page n'est joint QUE si l'utilisateur l'a demandé
          // (message.inclurePage === true) — confidentialité stricte.
          const messages = [...(message.historique ?? [])];
          if (message.inclurePage && message.tabId) {
            const contexte = await extraireContextePage(message.tabId);
            if (contexte) {
              messages.push({
                role: "user",
                content: `[Contexte de la page « ${contexte.titre} » fourni explicitement par l'utilisateur]\n${contexte.extrait}`,
              });
            }
          }
          messages.push({ role: "user", content: message.texte });
          const reponse = await appelGen3("/api/v1/chat", {
            method: "POST",
            body: JSON.stringify({ messages }),
          });
          sendResponse({
            ok: true,
            reponse: reponse.answer,
            facturation: reponse.billing,
            rpia: reponse.rpia,
          });
          return;
        }
        case "tache:specialite": {
          // Tâche de spécialité navigateur : exécution LOCALE puis compte
          // rendu au cortex (règle absolue de l'essaim).
          const resultat = await executerTacheLocale(message.specialite, message.tabId);
          const compteRendu = await appelGen3("/api/v1/chat", {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: `[Compte rendu du nœud navigateur — spécialité ${message.specialite}]\n${resultat.synthese}`,
                },
              ],
            }),
          });
          sendResponse({ ok: true, local: resultat, cortex: compteRendu.answer });
          return;
        }
        default:
          sendResponse({ ok: false, erreur: "Message inconnu." });
      }
    } catch (erreur) {
      sendResponse({ ok: false, erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    }
  })();
  return true; // réponse asynchrone
});

/* ------------------------------------------------------------------ */
/* Extraction de contexte — SUR DEMANDE uniquement (activeTab)         */
/* ------------------------------------------------------------------ */

async function extraireContextePage(tabId) {
  try {
    const [resultat] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const titre = document.title || "sans titre";
        const selection = window.getSelection()?.toString() ?? "";
        const corps = selection.length > 40
          ? selection
          : (document.querySelector("main") ?? document.body)?.innerText ?? "";
        return { titre, extrait: corps.replace(/\s+/g, " ").slice(0, 4000) };
      },
    });
    return resultat?.result ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Tâches locales des spécialités navigateur (100 % dans le navigateur)*/
/* ------------------------------------------------------------------ */

async function executerTacheLocale(specialite, tabId) {
  const [resultat] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (spe) => {
      const texte = (document.querySelector("main") ?? document.body)?.innerText ?? "";
      if (spe === "calcul") {
        const nombres = (texte.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((n) => parseFloat(n.replace(",", ".")));
        const somme = nombres.reduce((a, b) => a + b, 0);
        const moyenne = nombres.length ? somme / nombres.length : 0;
        return { specialite: spe, synthese: `${nombres.length} nombres extraits — somme locale ${somme}, moyenne locale ${Math.round(moyenne * 100) / 100}.` };
      }
      if (spe === "tri") {
        const lignes = texte.split("\n").map((l) => l.trim()).filter((l) => l.length > 12).slice(0, 50);
        const groupes = {};
        for (const ligne of lignes) {
          const cle = ligne.slice(0, 1).toUpperCase();
          groupes[cle] = (groupes[cle] ?? 0) + 1;
        }
        return { specialite: spe, synthese: `${lignes.length} lignes significatives triées localement en ${Object.keys(groupes).length} groupes initiaux.` };
      }
      // veille : instantané compact signé (comparaison au prochain appel)
      const empreinte = Array.from(texte.slice(0, 20000)).reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 999983, 7);
      const cle = `veille:${location.host}`;
      chrome.storage.session?.set?.({ [cle]: empreinte });
      return { specialite: spe, synthese: `Instantané de veille calculé localement pour ${location.host} (empreinte ${empreinte}).` };
    },
    args: [specialite],
  });
  return resultat?.result ?? { specialite, synthese: "Extraction locale impossible sur cet onglet." };
}

/* Ouverture du sidepanel au clic de l'icône (si le navigateur le permet). */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});
