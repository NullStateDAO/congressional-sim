import { describe, expect, it } from 'vitest';

import {
  helloPrompt,
  helloTasks,
  parseHelloDecision,
} from '../src/simulations/hello-world.js';

const files = {
  'agents.json': Buffer.from(
    JSON.stringify([
      {
        id: 'a',
        name: 'Agent A',
        priorities: ['reliability'],
        disposition: 'Careful.',
      },
    ]),
  ),
  'scenarios.json': Buffer.from(
    JSON.stringify([
      {
        id: 's',
        title: 'Pilot',
        proposal: 'Run a pilot.',
        tradeoffs: ['learning', 'cost'],
      },
    ]),
  ),
};

describe('hello-world simulation', () => {
  it('expands reference records into deterministic tasks and grounded prompts', () => {
    expect(helloTasks(files)).toEqual([
      { taskId: 'a-s', agentId: 'a', scenarioId: 's' },
    ]);
    const prompt = helloPrompt(files, helloTasks(files)[0]!);
    expect(prompt.user).toContain('reliability');
    expect(prompt.user).toContain('Run a pilot.');
  });

  it('accepts plain or fenced JSON decisions', () => {
    const value = {
      choice: 'support',
      confidence: 0.8,
      rationale: 'The bounded pilot creates useful evidence.',
    };
    expect(parseHelloDecision(JSON.stringify(value))).toEqual(value);
    expect(parseHelloDecision(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``)).toEqual(
      value,
    );
  });
});
