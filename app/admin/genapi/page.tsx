import type { ClientGenAPI, EntreeJournalGenAPI, StatutGenAPI } from "@/lib/genapi/types";
import { listerClients, statutGenAPI } from "@/lib/genapi/clients";
import { listerJournalGenAPI } from "@/lib/genapi/provisionnement";

import { GenAPIConsole } from "./genapi-console";

export const dynamic = "force-dynamic";

/**
 * /admin/genapi — console genAPI (Agent OS gRPC), server component.
 *
 * La barrière serveur reste dans app/admin/layout.tsx (canAdmin) : cette page
 * ne re-rend que si l'utilisateur est administrateur. Elle lit DIRECTEMENT le
 * socle lib/genapi (aucun fetch interne, aucune latence en cascade) et passe
 * l'état initial à la console cliente, qui gère ensuite les actions
 * (provisionner, révoquer, télécharger) via les routes /api/admin/genapi.
 *
 * Panne du socle → état vide + bandeau honnête « genAPI indisponible : … »,
 * jamais de fausse donnée ni de crash de rendu.
 */
export default async function AdminGenAPIPage() {
  let statut: StatutGenAPI | null = null;
  let clients: ClientGenAPI[] = [];
  let journal: EntreeJournalGenAPI[] = [];
  let erreurInitiale = "";

  try {
    [statut, clients, journal] = await Promise.all([
      statutGenAPI(),
      listerClients(),
      listerJournalGenAPI(20),
    ]);
  } catch (error) {
    statut = null;
    clients = [];
    journal = [];
    erreurInitiale = `genAPI indisponible : ${
      error instanceof Error ? error.message : "panne inconnue du socle."
    }`;
  }

  return (
    <GenAPIConsole
      statutInitial={statut}
      clientsInitiaux={clients}
      journalInitial={journal}
      erreurInitiale={erreurInitiale}
    />
  );
}
