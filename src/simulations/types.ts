import type { ModelCall, ModelClient, ModelResult } from '../openrouter.js';

export type SimulationTask = { taskId: string } & Record<string, unknown>;

export type CapturedModelCall = {
  request: ModelCall;
  response: ModelResult;
};

export type SimulationExecution = {
  result: Record<string, unknown>;
  calls: CapturedModelCall[];
};

export type SimulationDefinition = {
  type: string;
  tasks: (files: Record<string, Uint8Array>) => SimulationTask[];
  execute: (input: {
    files: Record<string, Uint8Array>;
    task: SimulationTask;
    seed: number;
    model: string;
    modelClient: ModelClient;
  }) => Promise<SimulationExecution>;
};
