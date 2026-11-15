import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/team/feature-access', () => ({ requireTeamFeatureAccess: vi.fn().mockResolvedValue(undefined) }));

import { anticipateTeamFailures } from './failure-anticipation';

describe('team failure anticipation', () => {
  const base = { userId: 'user-1', teamId: 'team-1' };

  it('flags high-risk execution characteristics', async () => {
    const result = await anticipateTeamFailures({
      ...base,
      steps: [{ id: 'publish', type: 'tool', timeoutMs: 120000, maxRetries: 4, sideEffect: true, requiresApproval: true, toolName: 'ads.publish' }],
    });
    expect(result.predictions.length).toBe(1);
    expect(result.predictions[0].severity).toBe('critical');
    expect(result.predictions[0].score).toBe(80);
    expect(result.blocked).toBe(true);
  });

  it('does not mark a healthy simple step as critical', async () => {
    const result = await anticipateTeamFailures({
      ...base,
      steps: [{ id: 'read', type: 'llm', timeoutMs: 30000, maxRetries: 1, sideEffect: false, requiresApproval: false, toolName: 'file.read' }],
    });
    expect(result.predictions[0].severity).not.toBe('critical');
    expect(result.blocked).toBe(false);
  });
});
