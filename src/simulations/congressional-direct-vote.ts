import { z } from 'zod';

import { parseReferenceJson } from '../reference.js';
import type { SimulationDefinition } from './types.js';

const IssueSchema = z.object({
  issue_id: z.string().min(1),
  title: z.string().min(1),
  congress: z.number().int(),
  path: z.enum(['bicameral', 'senate_only']),
  majority_position: z.enum(['pass', 'block']),
  national_support: z.number().min(0).max(1),
  real_outcome: z.enum(['passed', 'not_passed']),
  real_concordant: z.boolean(),
  paper_row_ref: z.string().min(1),
  question_text: z.string().min(1),
  real_house_outcome: z
    .enum(['passed', 'not_passed', 'not_applicable'])
    .nullable()
    .optional(),
  real_senate_outcome: z
    .enum(['passed', 'not_passed', 'not_applicable'])
    .nullable()
    .optional(),
});

const RosterSchema = z.object({
  member_id: z.string().min(1),
  congress: z.number().int(),
  chamber: z.enum(['house', 'senate']),
  state: z.string().min(1),
  district: z.string().nullable().optional(),
  party: z.string().min(1),
  leadership_role: z.string().nullable().optional(),
  first_elected: z.number().int(),
  last_margin: z.number().nullable().optional(),
  pvi: z.string().nullable().optional(),
  full_name: z.string().min(1),
});

const PersonaSchema = z.object({
  persona_id: z.string().min(1),
  member_id: z.string().min(1),
  congress: z.number().int(),
  persona_text: z.string().min(1),
  promise_source: z.string().nullable().optional(),
  content_hash: z.string().nullable().optional(),
});

const VoteSchema = z.object({
  vote: z.preprocess(
    (value) => String(value).toLowerCase(),
    z.enum(['yea', 'nay']),
  ),
  rationale: z.string().min(1).max(1800),
});

export type DirectVoteIssue = z.infer<typeof IssueSchema>;
export type DirectVoteRoster = z.infer<typeof RosterSchema>;
export type DirectVotePersona = z.infer<typeof PersonaSchema>;
export type DirectVoteDecision = z.infer<typeof VoteSchema>;

export type DirectVoteTask = {
  taskId: string;
  issueId: string;
  chamber: 'house' | 'senate';
  memberId: string;
};

export type DirectVoteBundle = {
  issues: DirectVoteIssue[];
  rosters: DirectVoteRoster[];
  personas: DirectVotePersona[];
  tasks: DirectVoteTask[];
  issueById: Map<string, DirectVoteIssue>;
  taskById: Map<string, DirectVoteTask>;
  issueByTaskId: Map<string, DirectVoteIssue>;
  rosterByTaskId: Map<string, DirectVoteRoster>;
  personaByMemberCongress: Map<string, DirectVotePersona>;
};

const bundleCache = new WeakMap<Record<string, Uint8Array>, DirectVoteBundle>();

export const directVoteResponseSchema = {
  name: 'congressional_direct_vote',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['vote', 'rationale'],
    properties: {
      vote: { type: 'string', enum: ['yea', 'nay'] },
      rationale: { type: 'string', maxLength: 1800 },
    },
  },
};

function parseJsonl<T>(
  files: Record<string, Uint8Array>,
  name: string,
  schema: z.ZodType<T>,
): T[] {
  const bytes = files[name];
  if (!bytes) throw new Error(`Reference bundle is missing ${name}`);
  return Buffer.from(bytes)
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => schema.parse(JSON.parse(line)));
}

function memberCongressKey(congress: number, memberId: string): string {
  return `${congress}:${memberId}`;
}

function congressChamberKey(congress: number, chamber: 'house' | 'senate'): string {
  return `${congress}:${chamber}`;
}

export function directVoteBundle(
  files: Record<string, Uint8Array>,
): DirectVoteBundle {
  const cached = bundleCache.get(files);
  if (cached) return cached;

  const issues = z.array(IssueSchema).parse(parseReferenceJson(files, 'issues.json'));
  const rosters = parseJsonl(files, 'rosters.jsonl', RosterSchema);
  const personas = parseJsonl(files, 'personas.jsonl', PersonaSchema);
  const issueById = new Map(issues.map((issue) => [issue.issue_id, issue]));
  const personaByMemberCongress = new Map(
    personas.map((persona) => [
      memberCongressKey(persona.congress, persona.member_id),
      persona,
    ]),
  );
  const rostersByCongressChamber = new Map<string, DirectVoteRoster[]>();
  for (const roster of rosters) {
    const key = congressChamberKey(roster.congress, roster.chamber);
    const existing = rostersByCongressChamber.get(key) ?? [];
    existing.push(roster);
    rostersByCongressChamber.set(key, existing);
  }

  const tasks: DirectVoteTask[] = [];
  const taskById = new Map<string, DirectVoteTask>();
  const issueByTaskId = new Map<string, DirectVoteIssue>();
  const rosterByTaskId = new Map<string, DirectVoteRoster>();
  for (const issue of issues) {
    const chambers: Array<'house' | 'senate'> =
      issue.path === 'senate_only' ? ['senate'] : ['house', 'senate'];
    for (const chamber of chambers) {
      const chamberRosters =
        rostersByCongressChamber.get(congressChamberKey(issue.congress, chamber)) ??
        [];
      for (const member of chamberRosters) {
        const task = {
          taskId: `${issue.issue_id}:${chamber}:${member.member_id}`,
          issueId: issue.issue_id,
          chamber,
          memberId: member.member_id,
        };
        tasks.push(task);
        taskById.set(task.taskId, task);
        issueByTaskId.set(task.taskId, issue);
        rosterByTaskId.set(task.taskId, member);
      }
    }
  }

  const bundle = {
    issues,
    rosters,
    personas,
    tasks,
    issueById,
    taskById,
    issueByTaskId,
    rosterByTaskId,
    personaByMemberCongress,
  };
  bundleCache.set(files, bundle);
  return bundle;
}

export function directVoteIssues(
  files: Record<string, Uint8Array>,
): DirectVoteIssue[] {
  return directVoteBundle(files).issues;
}

export function directVoteRosters(
  files: Record<string, Uint8Array>,
): DirectVoteRoster[] {
  return directVoteBundle(files).rosters;
}

export function directVotePersonas(
  files: Record<string, Uint8Array>,
): DirectVotePersona[] {
  return directVoteBundle(files).personas;
}

export function directVoteTasks(
  files: Record<string, Uint8Array>,
): DirectVoteTask[] {
  return directVoteBundle(files).tasks;
}

export function directVotePrompt(
  files: Record<string, Uint8Array>,
  task: DirectVoteTask,
): { system: string; user: string } {
  const bundle = directVoteBundle(files);
  const issue =
    bundle.issueByTaskId.get(task.taskId) ?? bundle.issueById.get(task.issueId);
  const roster = bundle.rosterByTaskId.get(task.taskId);
  const persona = issue
    ? bundle.personaByMemberCongress.get(
        memberCongressKey(issue.congress, task.memberId),
      )
    : undefined;
  if (!issue || !roster || !persona) {
    throw new Error(`Unknown congressional direct-vote task ${task.taskId}`);
  }

  return {
    system: [
      'You simulate one historical member of Congress casting one direct policy vote.',
      'Stay faithful to the supplied persona and constituency.',
      'Return JSON only with vote and rationale.',
      'Do not discuss scheduling, cloture, filibusters, presidential action, competing bills, or predictions of other members.',
      'Do not mention polling results, historical roll calls, or the real congressional outcome.',
    ].join(' '),
    user: [
      '[member]',
      `member_id: ${roster.member_id}`,
      `name: ${roster.full_name}`,
      `chamber: ${roster.chamber}`,
      `state: ${roster.state}`,
      `district: ${roster.district ?? 'statewide'}`,
      `party: ${roster.party}`,
      '',
      '[persona]',
      persona.persona_text.trim(),
      '',
      '[proposition]',
      'Vote YEA if you support adopting the proposition below.',
      'Vote NAY if you oppose it or prefer the status quo.',
      '',
      issue.question_text,
      '',
      '[response]',
      'Return JSON only. Use vote "yea" or "nay". Make the rationale 2-4 complete sentences, preferably under 120 words, grounded in the supplied persona and proposition.',
    ].join('\n'),
  };
}

export function parseDirectVoteDecision(content: string): DirectVoteDecision {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return VoteSchema.parse(JSON.parse(cleaned));
}

export const congressionalDirectVoteSimulation: SimulationDefinition = {
  type: 'congressional-direct-vote',
  tasks: directVoteTasks,
  async execute({ files, task, seed, model, modelClient }) {
    const directTask = directVoteBundle(files).taskById.get(task.taskId);
    if (!directTask) {
      throw new Error(`Reference does not contain task ${task.taskId}`);
    }
    const prompt = directVotePrompt(files, directTask);
    const request = {
      model,
      system: prompt.system,
      user: prompt.user,
      seed,
      maxTokens:
        model === 'z-ai/glm-5.3-flash'
          ? 16384
          : model === 'stealth/ox-alpha'
            ? 2048
            : 768,
      responseSchema: directVoteResponseSchema,
    };
    const response = await modelClient.call(request);
    return {
      result: {
        ...parseDirectVoteDecision(response.content),
        issueId: directTask.issueId,
        chamber: directTask.chamber,
        memberId: directTask.memberId,
      },
      calls: [{ request, response }],
    };
  },
};
