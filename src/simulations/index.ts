import { congressionalDirectVoteSimulation } from './congressional-direct-vote.js';
import { helloWorldSimulation } from './hello-world.js';
import type { SimulationDefinition } from './types.js';

const definitions = new Map<string, SimulationDefinition>([
  [congressionalDirectVoteSimulation.type, congressionalDirectVoteSimulation],
  [helloWorldSimulation.type, helloWorldSimulation],
]);

export function getSimulation(type: string): SimulationDefinition {
  const definition = definitions.get(type);
  if (!definition) {
    throw new Error(
      `Unknown simulation type ${type}. Registered: ${[...definitions.keys()].join(', ')}`,
    );
  }
  return definition;
}

export function simulationTypes(): string[] {
  return [...definitions.keys()].sort();
}
