import type { Metadata } from "next";
import { VideoProjectWorkspace } from "@/components/video/video-project-workspace";

export const metadata: Metadata = {
  title: "Production vidéo — Studio",
  description: "Atelier de production vidéo Gen3ia : scénario, storyboard, voix, timeline, rendu et versions.",
};

type Params = { params: Promise<{ projectId: string }> };

export default async function VideoProjectPage({ params }: Params) {
  const { projectId } = await params;
  return <VideoProjectWorkspace projectId={projectId} />;
}
