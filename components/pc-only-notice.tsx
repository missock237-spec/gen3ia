import Link from "next/link";

/**
 * Écran affiché quand l'agent Live est ouvert depuis un appareil non supporté
 * (mobile ou tablette). Le partage d'écran natif du navigateur et l'agent
 * Live sont conçus pour un vrai ordinateur (Windows/Linux/macOS).
 */
export function PcOnlyNotice({ deviceType }: { deviceType?: string }) {
  const appareil =
    deviceType === "mobile"
      ? "téléphone"
      : deviceType === "tablet"
        ? "tablette"
        : "appareil actuel";

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--g3-bg)] p-6 text-neutral-900">
      <div className="anim-scale-in w-full max-w-lg rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-100 text-xs font-bold uppercase tracking-widest text-amber-700">
          PC
        </div>
        <h1 className="mt-6 font-serif text-2xl font-semibold">Agent Live — PC uniquement</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-500">
          Cette fonctionnalité n’est pas disponible depuis votre {appareil}.
          L’agent Live observe l’écran via le partage d’écran natif du
          navigateur : il nécessite un ordinateur sous Windows, Linux ou macOS.
        </p>
        <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left text-sm text-neutral-500">
          <li className="rounded-xl border border-[rgba(23,23,20,0.08)] bg-neutral-50 px-4 py-2.5">
            Aucun téléchargement n’est nécessaire : sur PC, ouvrez simplement
            gen3ia.online/live dans votre navigateur.
          </li>
          <li className="rounded-xl border border-[rgba(23,23,20,0.08)] bg-neutral-50 px-4 py-2.5">
            Sur Android / iPhone : utilisez le site web ou l’application
            installable depuis votre navigateur.
          </li>
        </ul>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/studio" className="g3-btn g3-btn-ghost rounded-full">
            Retour au Studio
          </Link>
        </div>
      </div>
    </div>
  );
}
