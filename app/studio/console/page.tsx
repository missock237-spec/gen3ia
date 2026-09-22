"use client";

import { useEffect, useState } from "react";
import { type User } from "firebase/auth";
import { watchAuth } from "@/lib/firebase/client";

import { ConsoleWorkshop } from "@/components/developer/console-workshop";
import { StudioHeader } from "@/components/studio/studio-header";

/**
 * Console de l'agent de code (/studio/console) :
 *  - Terminal (sandbox isolé si déployé, sinon dry-run simulé, mode annoncé) ;
 *  - Simulation de code (VM V8 restreinte / analyse statique).
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
        eyebrow="STUDIO · CODE"
        title="Console de code"
        description="Terminal de l'agent de code et système de simulation. Le mode réel (sandbox Docker ou simulation intégrée) est annoncé sur chaque exécution."
      />
      {ready && user ? (
        <ConsoleWorkshop />
      ) : ready ? (
        <p className="g3-console-empty">Connectez-vous avec un compte possédant un agent de code pour utiliser la console.</p>
      ) : null}
    </main>
  );
}
