import { redirect } from "next/navigation";

/**
 * /dashboard — page d'accueil légère (architecture à 3 espaces).
 * Le centre de gravité de l'espace utilisateur est désormais /studio
 * (Missions). Cette route est conservée pour la compatibilité des liens
 * existants (e-mails, raccourcis, anciens marque-pages) et redirige
 * immédiatement vers l'espace de travail.
 */
export default function DashboardPage() {
  redirect("/studio");
}
