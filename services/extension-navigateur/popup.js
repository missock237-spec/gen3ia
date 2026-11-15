const $ = (id) => document.getElementById(id);

chrome.runtime.sendMessage({ type: "config:get" }).then((reponse) => {
  const config = reponse?.config;
  if (config) {
    $("instance").value = config.baseUrl ?? "";
    $("cle").value = config.apiKey ?? "";
    $("projet").value = config.projectId ?? "";
  }
});

$("enregistrer").addEventListener("click", async () => {
  const bouton = $("enregistrer");
  bouton.disabled = true;
  $("etat").className = "etat";
  $("etat").textContent = "Enregistrement…";
  try {
    await chrome.runtime.sendMessage({
      type: "config:set",
      config: {
        baseUrl: $("instance").value.trim() || "https://gen3ia.online",
        apiKey: $("cle").value.trim(),
        projectId: $("projet").value.trim(),
      },
    });
    $("etat").textContent = "Configuration enregistrée. Ouvrez le panneau latéral.";
  } catch (erreur) {
    $("etat").className = "etat erreur";
    $("etat").textContent = erreur?.message ?? "Échec de l'enregistrement.";
  } finally {
    bouton.disabled = false;
  }
});
