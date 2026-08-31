import { z } from 'zod';

import { parseReferenceJson } from '../reference.js';
import type { SimulationDefinition } from './types.js';

const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  priorities: z.array(z.string().min(1)).min(1),
  disposition: z.string().min(1),
});

const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  proposal: z.string().min(1),
  tradeoffs: z.array(z.string().min(1)).min(1),
});

const DecisionSchema = z.object({
  choice: z.enum(['support', 'oppose']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(1200),
});

export type HelloTask = {
  taskId: string;
  agentId: string;
  scenarioId: string;
};

export type HelloDecision = z.infer<typeof DecisionSchema>;

export function helloTasks(
  files: Record<string, Uint8Array>,
): HelloTask[] {
  const agents = z
    .array(AgentSchema)
    .parse(parseReferenceJson(files, 'agents.json'));
  const scenarios = z
    .array(ScenarioSchema)
    .parse(parseReferenceJson(files, 'scenarios.json'));
  return agents.flatMap((agent) =>
    scenarios.map((scenario) => ({
      taskId: `${agent.id}-${scenario.id}`,
      agentId: agent.id,
      scenarioId: scenario.id,
    })),
  );
}

export function helloPrompt(
  files: Record<string, Uint8Array>,
  task: HelloTask,
): { system: string; user: string } {
  const agents = z
    .array(AgentSchema)
    .parse(parseReferenceJson(files, 'agents.json'));
  const scenarios = z
    .array(ScenarioSchema)
    .parse(parseReferenceJson(files, 'scenarios.json'));
  const agent = agents.find((candidate) => candidate.id === task.agentId);
  const scenario = scenarios.find(
    (candidate) => candidate.id === task.scenarioId,
  );
  if (!agent || !scenario) throw new Error(`Unknown hello-world task ${task.taskId}`);
  return {
    system:
      'You simulate one decision-maker. Stay faithful to the supplied profile. Return JSON only, with choice, confidence, and a concise rationale grounded in the profile and scenario.',
    user: [
      `Agent: ${agent.name}`,
      `Priorities: ${agent.priorities.join('; ')}`,
      `Disposition: ${agent.disposition}`,
      `Proposal: ${scenario.title} - ${scenario.proposal}`,
      `Tradeoffs: ${scenario.tradeoffs.join('; ')}`,
      'Choose support or oppose. Explain the decisive tradeoff in 2-4 complete sentences. Return valid JSON.',
    ].join('\n'),
  };
}

export function parseHelloDecision(content: string): HelloDecision {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return DecisionSchema.parse(JSON.parse(cleaned));
}

export const helloWorldSimulation: SimulationDefinition = {
  type: 'hello-world',
  tasks: helloTasks,
  async execute({ files, task, seed, model, modelClient }) {
    const helloTask = helloTasks(files).find(
      (candidate) => candidate.taskId === task.taskId,
    );
    if (!helloTask) throw new Error(`Reference does not contain task ${task.taskId}`);
    const prompt = helloPrompt(files, helloTask);
    const request = {
      model,
      system: prompt.system,
      user: prompt.user,
      seed,
    };
    const response = await modelClient.call(request);
    return {
      result: parseHelloDecision(response.content),
      calls: [{ request, response }],
    };
  },
};
