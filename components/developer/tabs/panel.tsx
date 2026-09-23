"use client";

import { EmptyState } from "@/components/shells/states";

/**
 * Primitives de mise en page de l'espace développeur — extraites de
 * l'ancien monolithe pour être partagées par les 7 onglets.
 */

export function Panel({ title, subtitle, children, actions }: { title: string; subtitle?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{title}</h2>
          {subtitle && <p className="mt-1 text-xs text-neutral-500">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

export function Card({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-5">
      <div className="text-xs text-neutral-500">{title}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {hint && <div className="mt-1 text-xs text-neutral-400">{hint}</div>}
    </div>
  );
}

export function TabEmpty({ text }: { text: string }) {
  return <EmptyState title={text} />;
}

export function Rule({ n, t }: { n: string; t: string }) {
  return (
    <div className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-100 text-xs font-bold">{n}</span>
      <span className="text-xs leading-5 text-neutral-600">{t}</span>
    </div>
  );
}
