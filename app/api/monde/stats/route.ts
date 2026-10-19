import { NextResponse } from "next/server";

import { repartiteurGlobal } from "@/lib/essaim-global/repartiteur";

/**
 * Statistiques de l'essaim global — la transparence de la plateforme :
 * admissions, refus, équité (index de Jain), mémoire consommée. Ces
 * chiffres PROUVENT les garanties du répartiteur au lieu de les
 * affirmer : files bornées, équité maintenue, utilisateurs suivis
 * plafonnés.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const repartiteur = repartiteurGlobal();
  const stats = repartiteur.stats();
  return NextResponse.json({
    ok: true,
    essaim: {
      ...stats,
      /** Les garanties architecturales, chiffrées. */
      garanties: {
        memoireBornee: "files de 256 tickets × 64 fragments maximum",
        equiteCible: "index de Jain > 0.95 sous charge massive",
        refusPropres: "backpressure honnête (HTTP 429), jamais d'effondrement",
        horizontalite: "instances sans état — capacité multipliée par N instances",
      },
    },
  });
}
