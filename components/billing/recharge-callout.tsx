"use client";

import Link from "next/link";

/**
 * Invite de recharge (Task 153) : affichée quand une exécution d'agent IA
 * est bloquée pour solde insuffisant (402 PAYMENT_REQUIRED). Le portillon de
 * facturation ayant déjà calculé le coût de la requête, le message indique
 * ce qui est requis et propose d'alimenter le portefeuille (/billing).
 */

export function RechargeCallout({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        display: "grid",
        gap: 10,
        padding: "14px 16px",
        borderRadius: 14,
        border: "1px solid rgba(91,43,224,0.35)",
        background: "#F4EEFF",
        color: "#5633E8",
        fontSize: 14,
        lineHeight: 1.55,
      }}
    >
      <strong style={{ fontSize: 15 }}>Crédit insuffisant</strong>
      <span>{message}</span>
      <Link
        href="/billing"
        className="g3-recharge-cta"
        style={{
          justifySelf: "start",
          display: "inline-block",
          padding: "9px 16px",
          borderRadius: 999,
          background: "#5633E8",
          color: "#fff",
          fontWeight: 700,
          textDecoration: "none",
          fontSize: 13.5,
        }}
      >
        Recharger mon portefeuille
      </Link>
    </div>
  );
}
