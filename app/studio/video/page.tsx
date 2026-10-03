import type { Metadata } from "next";
import { VideoStudioHome } from "@/components/video/video-studio-home";

export const metadata: Metadata = {
  title: "Studio Vidéo — Agent de production IA",
  description: "GEN3IA VIDEO AGENT : scénario, storyboard, voix, montage et rendu de vidéos complètes pilotés par votre agent.",
};

export default function VideoStudioPage() {
  return <VideoStudioHome />;
}
