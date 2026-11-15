import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/team/feature-access', () => ({ requireTeamFeatureAccess: vi.fn().mockResolvedValue(undefined) }));

import { reduceTeamCognitiveLoad } from './team-cognitive-load';

describe('team cognitive load reduction', () => {
  const base = { userId: 'user-1', teamId: 'team-1' };

  it('deduplicates and prioritizes team context', async () => {
    const result = await reduceTeamCognitiveLoad({
      ...base,
      workspace: {
        objective: 'Préparer le lancement',
        memories: [
          { id: '1', text: 'Budget limité', importance: 0.9 },
          { id: '2', text: 'Budget limité', importance: 0.7 },
          { id: '3', text: 'Lancement vendredi', importance: 0.8 },
        ],
        recentMessages: [{ role: 'user', content: 'Lancement vendredi' }],
        decisions: ['Lancement vendredi'],
        constraints: ['Budget limité'],
      },
    });
    expect(result.prioritizedContext).toContain('CONTRAINTE: Budget limité');
    expect(result.prioritizedContext.filter((v) => v.toLowerCase().includes('budget limité')).length).toBe(1);
  });

  it('keeps the selected memory set bounded', async () => {
    const memories = Array.from({ length: 200 }, (_, i) => ({ id: String(i), text: `Mémoire ${i}`, importance: (i % 10) / 10 }));
    const result = await reduceTeamCognitiveLoad({ ...base, workspace: { objective: 'test', memories, recentMessages: [], decisions: [], constraints: [] } });
    expect(result.omittedMemoryIds.length).toBe(182);
    expect(result.prioritizedContext.length).toBeLessThanOrEqual(32);
  });
});
