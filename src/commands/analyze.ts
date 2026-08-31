import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  analyzeDirectVotes,
  directVoteResultsMarkdown,
  type ManifestJob,
} from '../analysis/direct-vote.js';
import { numberArg, parseArgs, stringArg } from '../lib/args.js';
import { stableJson } from '../lib/hash.js';
import {
  directVoteIssues,
  directVoteTasks,
} from '../simulations/congressional-direct-vote.js';

const args = parseArgs();
const manifestPath = path.resolve(stringArg(args, 'manifest'));
const referenceDir = path.resolve(
  stringArg(args, 'reference-dir', 'reference/congressional-direct-vote/v1'),
);
const outputDir = path.resolve(stringArg(args, 'output', 'out/analysis'));
const issueFilter = typeof args.issue === 'string' ? args.issue : null;
const allowMissingVotes =
  args['allow-missing'] === undefined ? 0 : numberArg(args, 'allow-missing', 0);

const referenceFiles = Object.fromEntries(
  await Promise.all(
    ['issues.json', 'rosters.jsonl', 'personas.jsonl'].map(
      async (file) => [file, await readFile(path.join(referenceDir, file))] as const,
    ),
  ),
);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  jobs?: ManifestJob[];
};
if (!Array.isArray(manifest.jobs)) {
  throw new Error(`Manifest ${manifestPath} does not contain a jobs array`);
}

const issues = directVoteIssues(referenceFiles).filter(
  (issue) => !issueFilter || issue.issue_id === issueFilter,
);
if (issueFilter && issues.length === 0) {
  throw new Error(`Reference does not contain issue ${issueFilter}`);
}
const issueIds = new Set(issues.map((issue) => issue.issue_id));
const tasks = directVoteTasks(referenceFiles).filter((task) =>
  issueIds.has(task.issueId),
);

const jobs = issueFilter
  ? manifest.jobs.filter((job) =>
      String(job.task_id ?? job.taskId ?? '').startsWith(`${issueFilter}:`),
    )
  : manifest.jobs;

const results = analyzeDirectVotes(
  {
    issues,
    tasks,
    jobs,
  },
  { allowMissingVotes },
);
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'results.json'), `${stableJson(results)}\n`);
await writeFile(path.join(outputDir, 'RESULTS.md'), directVoteResultsMarkdown(results));
console.log(
  JSON.stringify(
    {
      outputDir,
      agentConcordant: results.agentConcordant,
      congressConcordant: results.congressConcordant,
      alwaysPassConcordant: results.alwaysPassConcordant,
      alwaysBlockConcordant: results.alwaysBlockConcordant,
    },
    null,
    2,
  ),
);
