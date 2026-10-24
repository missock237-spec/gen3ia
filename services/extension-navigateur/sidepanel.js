const $ = (id) => document.getElementById(id);
const fil = $("fil");
const historique = [];

function ajouter(classe, texte) {
  const bulle = document.createElement("div");
  bulle.className = `bulle ${classe}`;
  bulle.textContent = texte;
  fil.appendChild(bulle);
  fil.scrollTop = fil.scrollHeight;
}

async function ongletActif() {
  const [onglet] = await chrome.tabs.query({ active: true, currentWindow: true });
  return ontabValide(onglet) ? onglet : null;
}

function ontabValide(onglet) {
  return onglet?.id && /^https?:/i.test(onglet.url ?? "");
}

$("envoyer").addEventListener("click", envoyer);
$("texte").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); envoyer(); }
});

async function envoyer() {
  const texte = $("texte").value.trim();
  const specialite = $("specialite").value;
  if (!texte && !specialite) return;
  $("envoyer").disabled = true;
  try {
    const onglet = await ongletActif();

    if (specialite) {
      // Tâche d'essaim : exécution LOCALE puis compte rendu au cortex.
      ajouter("systeme", `Tâche d'essaim « ${specialite} » — exécution locale…`);
      const reponse = await chrome.runtime.sendMessage({
        type: "tache:specialite", specialite, tabId: onglet?.id,
      });
      if (!reponse?.ok) throw new Error(reponse?.erreur ?? "Tâche échouée.");
      ajouter("systeme", `Local : ${reponse.local.synthese}`);
      ajouter("gen3", reponse.cortex);
      historique.push({ role: "assistant", content: reponse.cortex });
      return;
    }

    ajouter("utilisateur", texte);
    historique.push({ role: "user", content: texte });
    const inclure = $("inclurePage").checked;
    const reponse = await chrome.runtime.sendMessage({
      type: "chat:envoyer",
      texte,
      historique: historique.slice(-12),
      inclurePage: inclure && onglet,
      tabId: onglet?.id,
    });
    if (!reponse?.ok) throw new Error(reponse?.erreur ?? "Appel échoué.");
    ajouter("gen3", reponse.reponse);
    historique.push({ role: "assistant", content: reponse.reponse });
    const facturation = reponse.facturation;
    $("debit").textContent = facturation?.billingEnabled
      ? `Débité au réel : ${facturation.debitedMinor / 100} ${facturation.currency} (${facturation.measuredTokens?.inputTokens ?? 0} → ${facturation.measuredTokens?.outputTokens ?? 0} tokens).`
      : "Mode libre : aucun débit (facturation non armée).";
  } catch (erreur) {
    ajouter("systeme", `Erreur : ${erreur?.message ?? erreur}`);
  } finally {
    $("texte").value = "";
    $("envoyer").disabled = false;
  }
}
