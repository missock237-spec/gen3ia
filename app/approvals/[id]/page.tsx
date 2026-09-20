"use client";

import { useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

export default function RemoteApprovalPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = useState<"idle" | "loading" | "approved" | "rejected" | "error">("idle");
  const [message, setMessage] = useState("");

  async function decide(decision: "approve" | "reject") {
    setStatus("loading");
    setMessage("");
    try {
      const response = await fetch("/api/integrations/messaging/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, decision }),
      });
      const body = (await response.json()) as { error?: string; status?: string };
      if (!response.ok) {
        setStatus("error");
        setMessage(body.error ?? "Action impossible.");
        return;
      }
      setStatus(decision === "approve" ? "approved" : "rejected");
      setMessage(decision === "approve" ? "Action approuvée : l'exécution va démarrer." : "Action refusée : elle ne sera pas exécutée.");
    } catch {
      setStatus("error");
      setMessage("Erreur réseau. Vérifiez votre connexion et réessayez.");
    }
  }

  const busy = status === "loading";

  return (
    <div className="flex min-h-full items-center justify-center bg-[#f6f4ef] px-4 text-neutral-900">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">GEN3IA · Approbation d&apos;action</p>
        <h1 className="mt-2 text-xl font-semibold">Une action sensible attend votre décision</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Approuvez ou refusez l&apos;action demandée par votre agent. Le lien expire automatiquement après le délai imparti.
        </p>

        {status === "approved" || status === "rejected" ? (
          <div className="mt-6 rounded-xl border border-neutral-200 bg-[#f6f4ef] px-4 py-3 text-sm">{message}</div>
        ) : (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy}
              onClick={() => decide("approve")}
              className="flex-1 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-700 disabled:opacity-50"
            >
              ✅ Approuver
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => decide("reject")}
              className="flex-1 rounded-xl border border-neutral-300 px-4 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-100 disabled:opacity-50"
            >
              ❌ Refuser
            </button>
          </div>
        )}

        {status === "error" && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div>
        )}

        <p className="mt-6 text-xs text-neutral-400">Identifiant de l&apos;action : {params.id?.slice(0, 12) ?? "?"}…</p>
      </div>
    </div>
  );
}
