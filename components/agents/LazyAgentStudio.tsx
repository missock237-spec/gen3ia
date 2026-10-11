import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';

// Chargement différé pour composants lourds
const AgentChat = dynamic(() => import('./AgentChat'), {
  loading: () => <ChatSkeleton />,
  ssr: false, // Pas de SSR pour composants interactifs lourds
});

const LiveAgentPanel = dynamic(() => import('./LiveAgentPanel'), {
  loading: () => <PanelSkeleton />,
});

const MemoryGraph = dynamic(() => import('./MemoryGraph'), {
  loading: () => <GraphSkeleton />,
});

export function LazyAgentStudio({ agentId }: { agentId: string }) {
  return (
    <div className="space-y-4">
      <Suspense fallback={<StudioSkeleton />}>
        <AgentChat agentId={agentId} />
      </Suspense>
      
      <details className="group">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Voir l'agent live
        </summary>
        <LiveAgentPanel agentId={agentId} />
      </details>
      
      <details className="group">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Graph de mémoire
        </summary>
        <MemoryGraph agentId={agentId} />
      </details>
    </div>
  );
}

// Skeleton components pour meilleure UX
function ChatSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-10 bg-muted rounded-lg" />
      <div className="h-20 bg-muted rounded-lg" />
      <div className="h-10 w-2/3 bg-muted rounded-lg" />
    </div>
  );
}
