"use client";

import { useEffect, useState } from "react";
import { type User } from "firebase/auth";
import { watchAuth } from "@/lib/firebase/client";

import { IdeWorkspace } from "@/components/developer/ide/ide-workspace";
import { StudioHeader } from "@/components/studio/studio-header";

/**
 * Workshop IDE unifié (/studio/console) — remplace les deux panneaux
 * indépendants (terminal + visualiseur) par un espace de travail intégré :
 *  - barre d'onglets persistante : Terminal, Code, Logs, Aperçu, Tests ;
 *  - explorateur de fichiers (recherche, favoris, versions) ;
 *  - éditeur Monaco (minimap, onglets, annotations d'erreurs) ;
 *  - panneau droit redimensionnable (exécution, logs, tests, aperçu) ;
 *  - terminal alimenté EXCLUSIVEMENT par les agents (observation
 *    utilisateur en lecture seule, arrêt de session, arrêt d'urgence).
 *
 * Réservé aux propriétaires d'agent de code (garde serveur côté API).
 */
export default function StudioConsolePage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => watchAuth((current) => {
    setUser(current);
    setReady(true);
  }), []);

  return (
    <main className="g3-studio-page">
      <StudioHeader
        eyebrow="STUDIO · WORKSHOP IDE"
        title="Workshop IDE"
        description="Workspace de développement unifié : terminal des agents, éditeur de code, logs structurés, aperçu en direct des applications créées et résultats de tests — avec arrêt de session et arrêt d'urgence."
      />
      {ready && user ? (
        <IdeWorkspace />
      ) : ready ? (
        <p className="g3-console-empty">Connectez-vous avec un compte possédant un agent de code pour utiliser le Workshop IDE.</p>
      ) : null}
    </main>
  );
}
