import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseArgs, stringArg } from '../lib/args.js';
import {
  directVoteIssues,
  directVotePersonas,
  directVotePrompt,
  directVoteRosters,
  directVoteTasks,
} from '../simulations/congressional-direct-vote.js';

const args = parseArgs();
const dir = path.resolve(stringArg(args, 'dir', 'reference/congressional-direct-vote/v1'));

const files = Object.fromEntries(
  await Promise.all(
    ['issues.json', 'rosters.jsonl', 'personas.jsonl', 'provenance.json'].map(
      async (file) => [file, await readFile(path.join(dir, file))] as const,
    ),
  ),
);

const issues = directVoteIssues(files);
const rosters = directVoteRosters(files);
const personas = directVotePersonas(files);
const tasks = directVoteTasks(files);

expect(issues.length === 103, `expected 103 issues, found ${issues.length}`);
expect(
  new Set(issues.map((issue) => issue.issue_id)).size === 103,
  'issue IDs must be unique',
);
expect(
  issues.filter((issue) => issue.real_concordant).length === 57,
  'expected 57 real-Congress concordant issues',
);
expect(
  issues.filter((issue) => issue.majority_position === 'pass').length === 74,
  'expected 74 public-supported issues',
);
expect(
  issues.filter((issue) => issue.majority_position === 'block').length === 29,
  'expected 29 public-opposed issues',
);

const rosterKey = new Set(
  rosters.map((member) => `${member.congress}:${member.chamber}:${member.member_id}`),
);
expect(rosterKey.size === rosters.length, 'roster member IDs must be unique per chamber');

const personaKey = new Set(
  personas.map((persona) => `${persona.congress}:${persona.member_id}`),
);
expect(personaKey.size === personas.length, 'personas must be unique per member/congress');

for (const issue of issues) {
  const chambers = issue.path === 'senate_only' ? ['senate'] : ['house', 'senate'];
  for (const chamber of chambers) {
    const members = rosters.filter(
      (member) => member.congress === issue.congress && member.chamber === chamber,
    );
    expect(
      members.length > 0,
      `${issue.issue_id} has no ${chamber} roster for Congress ${issue.congress}`,
    );
    for (const member of members) {
      expect(
        personaKey.has(`${member.congress}:${member.member_id}`),
        `${issue.issue_id} missing persona for ${member.member_id}`,
      );
    }
  }
}

const representativeTasks = issues.map((issue) => {
  const task = tasks.find((candidate) => candidate.issueId === issue.issue_id);
  expect(Boolean(task), `${issue.issue_id} has no expanded tasks`);
  return task!;
});

for (const task of representativeTasks) {
  const issue = issues.find((candidate) => candidate.issue_id === task.issueId)!;
  const prompt = directVotePrompt(files, task);
  expect(
    prompt.user.includes(issue.question_text),
    `${task.taskId} prompt does not contain question_text verbatim`,
  );
  expect(
    !prompt.user.includes(String(issue.national_support)),
    `${task.taskId} prompt leaks national_support`,
  );
  expect(
    !prompt.user.includes('real_outcome'),
    `${task.taskId} prompt leaks real_outcome field name`,
  );
  expect(
    !prompt.user.includes('majority_position'),
    `${task.taskId} prompt leaks majority_position field name`,
  );
}

const forbiddenRegressionText: Record<string, string[]> = {
  'dream-act': ['opioid', 'medicaid package'],
  'school-gun-safety': ['facility naming'],
  'schip-2007': ['small-business tax package'],
  'normalize-cuba': ['zika'],
  'ban-late-abortion-2006': ['national heritage areas'],
};

for (const [issueId, forbidden] of Object.entries(forbiddenRegressionText)) {
  const task = tasks.find((candidate) => candidate.issueId === issueId);
  expect(Boolean(task), `missing regression issue ${issueId}`);
  const prompt = directVotePrompt(files, task!).user.toLowerCase();
  for (const snippet of forbidden) {
    expect(
      !prompt.includes(snippet),
      `${issueId} prompt contains prior wrong-policy text: ${snippet}`,
    );
  }
}

const byChamber = tasks.reduce<Record<string, number>>((counts, task) => {
  counts[task.chamber] = (counts[task.chamber] ?? 0) + 1;
  return counts;
}, {});

console.log(
  JSON.stringify(
    {
      status: 'ok',
      issues: issues.length,
      rosters: rosters.length,
      personas: personas.length,
      tasks: tasks.length,
      publicSupported: 74,
      publicOpposed: 29,
      congressConcordant: 57,
      byChamber,
    },
    null,
    2,
  ),
);

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
