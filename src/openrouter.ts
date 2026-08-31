import { z } from 'zod';

import type { AppConfig } from './config.js';
import { deterministicId } from './lib/hash.js';

const OpenRouterResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullable() }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type ModelCall = {
  model: string;
  system: string;
  user: string;
  seed: number;
  maxTokens?: number;
  responseSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
};

export type ModelResult = {
  raw: unknown;
  content: string;
  model: string;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
};

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class ModelClient {
  private readonly slots: Semaphore;

  constructor(private readonly config: AppConfig) {
    this.slots = new Semaphore(config.OPENROUTER_CONCURRENCY);
  }

  call(input: ModelCall): Promise<ModelResult> {
    return this.slots.run(() =>
      this.config.SIMULATION_TRANSPORT === 'mock'
        ? this.mock(input)
        : this.openRouter(input),
    );
  }

  private async mock(input: ModelCall): Promise<ModelResult> {
    const started = Date.now();
    const digest = deterministicId(input);
    const positive = Number.parseInt(digest.slice(0, 2), 16) % 2 === 1;
    const properties = (
      input.responseSchema?.schema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    const content = properties?.vote
      ? JSON.stringify({
          vote: positive ? 'yea' : 'nay',
          rationale: `The mock member voted ${positive ? 'yea' : 'nay'} after weighing the supplied persona against the proposition.`,
        })
      : JSON.stringify({
          choice: positive ? 'support' : 'oppose',
          confidence: 0.65,
          rationale: `The mock agent chose ${positive ? 'support' : 'oppose'} after weighing its profile against the scenario tradeoffs.`,
        });
    await new Promise((resolve) => setTimeout(resolve, 15));
    return {
      raw: {
        id: `mock-${digest.slice(0, 12)}`,
        model: 'mock/deterministic',
        provider: 'local',
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      content,
      model: 'mock/deterministic',
      provider: 'local',
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: Date.now() - started,
    };
  }

  private async openRouter(input: ModelCall): Promise<ModelResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.OPENROUTER_TIMEOUT_MS,
    );
    try {
      const body: Record<string, unknown> = {
        model: input.model,
        seed: input.seed,
        temperature: 0.2,
        max_tokens: input.maxTokens ?? 512,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'simulation_decision',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              ...(input.responseSchema?.schema ?? {
                type: 'object',
                additionalProperties: false,
                required: ['choice', 'confidence', 'rationale'],
                properties: {
                  choice: { type: 'string', enum: ['support', 'oppose'] },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  rationale: { type: 'string', maxLength: 1200 },
                },
              }),
            },
          },
        },
      };
      if (input.responseSchema) {
        (body.response_format as { json_schema: { name: string } }).json_schema.name =
          input.responseSchema.name;
      }
      if (this.config.OPENROUTER_PROVIDER) {
        body.provider = {
          only: [this.config.OPENROUTER_PROVIDER],
          allow_fallbacks: false,
        };
      }
      const response = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `OpenRouter ${response.status} ${response.statusText}: ${text.slice(0, 2000)}`,
        );
      }
      const raw = JSON.parse(text) as unknown;
      const parsed = OpenRouterResponseSchema.parse(raw);
      const content = parsed.choices[0]?.message.content;
      if (!content) throw new Error('OpenRouter returned no message content');
      return {
        raw,
        content,
        model: parsed.model ?? input.model,
        provider: parsed.provider ?? null,
        promptTokens: parsed.usage?.prompt_tokens ?? null,
        completionTokens: parsed.usage?.completion_tokens ?? null,
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
