import type { Metadata } from "next";
import Link from "next/link";

import { VitrineHeader } from "@/components/home/vitrine-header";
import { SITE_URL } from "@/lib/geo/content";
import { ASSETS_MULTIMODAL_IT90 } from "@/lib/neural/generation/multimodal-it90";

/**
 * ÉCHANTILLONS MULTIMODAUX RÉELS (it.90) — page vitrine des assets
 * professionnels intégrés au cerveau : images COCO-2017 (annotations
 * officielles), parole française Google FLEURS (transcriptions officielles),
 * vidéos UCF101 et clips TTS à voix naturelle. Tout est mesuré (octets,
 * empreinte) et servi depuis ce déploiement — rien de fabriqué.
 */

export const metadata: Metadata = {
  title: "Échantillons multimodaux réels",
  description:
    "Les assets multimodaux professionnels intégrés au cerveau de Gen3ia : images COCO-2017 annotées, parole française FLEURS, vidéos UCF101, voix naturelles TTS — octets et empreintes mesurés.",
  alternates: { canonical: "/multimodal" },
  openGraph: {
    type: "website",
    url: `${SITE_URL}/multimodal`,
    siteName: "Gen3ia",
    title: "Gen3ia — Échantillons multimodaux réels",
    description:
      "Images COCO-2017, parole FLEURS, vidéos UCF101, voix TTS : les assets réels intégrés au cerveau de Gen3ia.",
    locale: "fr_FR",
  },
};

const IMAGES = ASSETS_MULTIMODAL_IT90.filter((a) => a.modality === "image");
const AUDIOS = ASSETS_MULTIMODAL_IT90.filter((a) => a.modality === "audio");
const TTS = ASSETS_MULTIMODAL_IT90.filter((a) => a.modality === "audio-généré");
const VIDEOS = ASSETS_MULTIMODAL_IT90.filter((a) => a.modality === "video");

const TOTAL_MO = ASSETS_MULTIMODAL_IT90.reduce((s, a) => s + a.bytes, 0) / 1e6;

type Asset = (typeof ASSETS_MULTIMODAL_IT90)[number];

function Cartouche({ a }: { a: Asset }) {
  return (
    <p className="mt-1 text-[11px] leading-4 text-[var(--g3-faint)]">
      {a.dataset} · {a.bytes.toLocaleString("fr-FR")} o · empreinte {a.sha256}
    </p>
  );
}

export default function MultimodalPage() {
  return (
    <div className="g3-noise flex min-h-full flex-col bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <VitrineHeader />
      <div className="flex-1">
        <section className="sky-hero relative overflow-hidden">
          <div className="aurora" aria-hidden="true" />
          <div className="aurora-glow" aria-hidden="true" />
          <div className="relative mx-auto max-w-4xl px-4 pb-14 pt-20 sm:px-6 sm:pt-24">
            <nav aria-label="Fil d'Ariane" className="mb-8 text-xs text-[var(--g3-faint)]">
              <Link href="/" className="transition hover:text-[var(--g3-primary-strong)]">Accueil</Link>
              <span className="mx-2" aria-hidden>/</span>
              <Link href="/capacites" className="transition hover:text-[var(--g3-primary-strong)]">Capacités</Link>
              <span className="mx-2" aria-hidden>/</span>
              <span className="text-[var(--g3-muted)]">Multimodal réel</span>
            </nav>
            <p className="g3-eyebrow">MULTIMODAL — IT.90</p>
            <h1 className="mt-4 font-[family-name:var(--font-display)] text-4xl font-bold tracking-tight sm:text-6xl">
              Échantillons <span className="gradient-text">multimodaux réels</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--g3-text-secondary)]">
              {ASSETS_MULTIMODAL_IT90.length} assets professionnels intégrés au cerveau de Gen3ia —
              {(TOTAL_MO).toFixed(2).replace(".", ",")} Mo mesurés. Chaque fichier est réel (datasets
              Hugging Face publics ou génération TTS locale), identifié par ses octets et son
              empreinte, et le chat en connaît la légende exacte : demandez-lui « Que contient
              l&apos;image kext90_image_014 ? ».
            </p>
          </div>
        </section>

        {/* ---------- Images COCO-2017 ---------- */}
        <section aria-label="Images COCO-2017" className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
          <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
            Images réelles — COCO-2017 (annotations officielles)
          </h2>
          <p className="mt-2 text-sm leading-7 text-[var(--g3-muted)]">
            20 images photoréalistes du dataset de référence COCO-2017 (split validation). Les
            légendes sont reconstruites depuis les annotations d&apos;objets réelles du dataset —
            aucun label inventé.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {IMAGES.map((a) => (
              <figure
                key={a.id}
                className="overflow-hidden rounded-2xl border border-[var(--g3-primary-soft)] bg-[var(--g3-surface)]/80 backdrop-blur"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.file}
                  alt={`Image réelle COCO-2017 — ${a.legende}`}
                  className="h-36 w-full object-cover"
                  loading="lazy"
                />
                <figcaption className="p-3">
                  <p className="text-[11px] font-semibold text-[var(--g3-primary-strong)]">{a.id}</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">{a.legende}</p>
                  <Cartouche a={a} />
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {/* ---------- Parole française FLEURS ---------- */}
        <section aria-label="Parole française FLEURS" className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
          <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
            Parole française naturelle — Google FLEURS (transcriptions officielles)
          </h2>
          <p className="mt-2 text-sm leading-7 text-[var(--g3-muted)]">
            8 clips réels de parole française (split validation, fr_fr) avec leurs transcriptions
            officielles — la base d&apos;entraînement à la compréhension vocale.
          </p>
          <div className="mt-5 space-y-3">
            {AUDIOS.map((a) => (
              <div
                key={a.id}
                className="rounded-2xl border border-[var(--g3-primary-soft)] bg-[var(--g3-surface)]/80 p-4 backdrop-blur"
              >
                <p className="text-[11px] font-semibold text-[var(--g3-primary-strong)]">{a.id}</p>
                <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">« {a.legende} »</p>
                <audio controls preload="none" src={a.file} className="mt-2 w-full" />
                <Cartouche a={a} />
              </div>
            ))}
          </div>
        </section>

        {/* ---------- Vidéos UCF101 ---------- */}
        <section aria-label="Vidéos UCF101" className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
          <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
            Vidéos réelles — UCF101 (convertis MP4 H.264)
          </h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {VIDEOS.map((a) => (
              <div
                key={a.id}
                className="rounded-2xl border border-[var(--g3-primary-soft)] bg-[var(--g3-surface)]/80 p-4 backdrop-blur"
              >
                <p className="text-[11px] font-semibold text-[var(--g3-primary-strong)]">{a.id}</p>
                <video controls preload="none" src={a.file} className="mt-2 w-full rounded-xl" />
                <p className="mt-2 text-xs leading-5 text-[var(--g3-muted)]">{a.legende}</p>
                <Cartouche a={a} />
              </div>
            ))}
          </div>
        </section>

        {/* ---------- Voix TTS générées ---------- */}
        <section aria-label="Voix naturelles générées" className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
          <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
            Voix naturelles générées (TTS local)
          </h2>
          <p className="mt-2 text-sm leading-7 text-[var(--g3-muted)]">
            4 clips générés à voix naturelle sur des contenus du cerveau (couleurs, propriétés,
            mélanges) — le canal de génération vocale de Gen3ia.
          </p>
          <div className="mt-5 space-y-3">
            {TTS.map((a) => (
              <div
                key={a.id}
                className="rounded-2xl border border-[var(--g3-primary-soft)] bg-[var(--g3-surface)]/80 p-4 backdrop-blur"
              >
                <p className="text-[11px] font-semibold text-[var(--g3-primary-strong)]">{a.id}</p>
                <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">{a.legende}</p>
                <audio controls preload="none" src={a.file} className="mt-2 w-full" />
                <Cartouche a={a} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
