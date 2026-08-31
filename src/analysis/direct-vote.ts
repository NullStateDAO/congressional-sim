import type {
  DirectVoteIssue,
  DirectVoteTask,
} from '../simulations/congressional-direct-vote.js';

export type ManifestJob = {
  task_id?: string;
  taskId?: string;
  status?: string;
  result?: {
    vote?: unknown;
    issueId?: unknown;
    chamber?: unknown;
    memberId?: unknown;
  } | null;
};

export type ChamberTally = {
  expected: number;
  present: number;
  missing: number;
  yea: number;
  nay: number;
  passed: boolean;
};

export type IssueOutcome = {
  issueId: string;
  title: string;
  majorityPosition: 'pass' | 'block';
  realOutcome: 'passed' | 'not_passed';
  realConcordant: boolean;
  agentPassed: boolean;
  agentConcordant: boolean;
  house: ChamberTally | null;
  senate: ChamberTally;
};

export type DirectVoteResults = {
  schemaVersion: 1;
  issues: number;
  missingVotes: number;
  agentConcordant: number;
  congressConcordant: number;
  alwaysPassConcordant: number;
  alwaysBlockConcordant: number;
  publicSupported: {
    total: number;
    agentCorrect: number;
  };
  publicOpposed: {
    total: number;
    agentCorrect: number;
  };
  outcomes: IssueOutcome[];
};

export function analyzeDirectVotes(
  input: {
    issues: DirectVoteIssue[];
    tasks: DirectVoteTask[];
    jobs: ManifestJob[];
  },
  options: { allowMissingVotes?: number } = {},
): DirectVoteResults {
  const { issues, tasks, jobs } = input;
  const allowMissingVotes = options.allowMissingVotes ?? 0;
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const expected = expectedCounts(tasks);
  const tally = new Map<
    string,
    { yea: number; nay: number; present: number; missing: number }
  >();

  let missingVotes = 0;
  for (const job of jobs) {
    const taskId = job.task_id ?? job.taskId;
    if (!taskId) throw new Error('Manifest job is missing task_id');
    const task = taskById.get(taskId);
    if (!task) throw new Error(`Manifest contains unknown task ${taskId}`);
    const key = issueChamberKey(task.issueId, task.chamber);
    const row = tally.get(key) ?? { yea: 0, nay: 0, present: 0, missing: 0 };
    tally.set(key, row);
    const vote = String(job.result?.vote ?? '').toLowerCase();
    if (vote !== 'yea' && vote !== 'nay') {
      if (job.status !== undefined && job.status !== 'complete') {
        missingVotes += 1;
        if (missingVotes > allowMissingVotes) {
          throw new Error(
            `Manifest has more than ${allowMissingVotes} incomplete job(s); ` +
              `pass a larger --allow-missing to tolerate them`,
          );
        }
        row.missing += 1;
        continue;
      }
      throw new Error(`Task ${taskId} has invalid or missing vote`);
    }
    row.present += 1;
    if (vote === 'yea') row.yea += 1;
    else row.nay += 1;
  }

  const outcomes = issues.map((issue) => {
    const senate = chamberTally(issue.issue_id, 'senate', expected, tally);
    const house =
      issue.path === 'bicameral'
        ? chamberTally(issue.issue_id, 'house', expected, tally)
        : null;
    const agentPassed =
      issue.path === 'bicameral' ? Boolean(house?.passed && senate.passed) : senate.passed;
    const agentConcordant =
      issue.majority_position === 'pass' ? agentPassed : !agentPassed;
    return {
      issueId: issue.issue_id,
      title: issue.title,
      majorityPosition: issue.majority_position,
      realOutcome: issue.real_outcome,
      realConcordant: issue.real_concordant,
      agentPassed,
      agentConcordant,
      house,
      senate,
    };
  });

  const agentConcordant = outcomes.filter((outcome) => outcome.agentConcordant).length;
  const congressConcordant = issues.filter((issue) => issue.real_concordant).length;
  const alwaysPassConcordant = issues.filter(
    (issue) => issue.majority_position === 'pass',
  ).length;
  const alwaysBlockConcordant = issues.length - alwaysPassConcordant;
  const publicSupportedOutcomes = outcomes.filter(
    (outcome) => outcome.majorityPosition === 'pass',
  );
  const publicOpposedOutcomes = outcomes.filter(
    (outcome) => outcome.majorityPosition === 'block',
  );

  return {
    schemaVersion: 1,
    issues: issues.length,
    missingVotes,
    agentConcordant,
    congressConcordant,
    alwaysPassConcordant,
    alwaysBlockConcordant,
    publicSupported: {
      total: publicSupportedOutcomes.length,
      agentCorrect: publicSupportedOutcomes.filter((outcome) => outcome.agentPassed)
        .length,
    },
    publicOpposed: {
      total: publicOpposedOutcomes.length,
      agentCorrect: publicOpposedOutcomes.filter((outcome) => !outcome.agentPassed)
        .length,
    },
    outcomes,
  };
}

export function directVoteResultsMarkdown(results: DirectVoteResults): string {
  const signal =
    results.agentConcordant > results.congressConcordant &&
    results.agentConcordant > results.alwaysPassConcordant
      ? 'Positive signal'
      : results.agentConcordant > results.congressConcordant
        ? 'Weak/uninteresting signal'
        : 'Negative signal';
  return [
    '# Congressional Direct-Vote Results',
    '',
    `Result rule: ${signal}.`,
    ...(results.missingVotes > 0
      ? [
          '',
          `Missing votes: ${results.missingVotes} incomplete job(s) tolerated; ` +
            'every affected chamber outcome is invariant to how they would have voted.',
        ]
      : []),
    '',
    '| Strategy | Concordant |',
    '| --- | ---: |',
    `| Agent legislature | ${results.agentConcordant}/${results.issues} |`,
    `| Real Congress | ${results.congressConcordant}/${results.issues} |`,
    `| Always pass | ${results.alwaysPassConcordant}/${results.issues} |`,
    `| Always block | ${results.alwaysBlockConcordant}/${results.issues} |`,
    '',
    '| Public-majority subset | Agent correct |',
    '| --- | ---: |',
    `| Public-supported propositions | ${results.publicSupported.agentCorrect}/${results.publicSupported.total} |`,
    `| Public-opposed propositions | ${results.publicOpposed.agentCorrect}/${results.publicOpposed.total} |`,
    '',
  ].join('\n');
}

function expectedCounts(tasks: DirectVoteTask[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const key = issueChamberKey(task.issueId, task.chamber);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function chamberTally(
  issueId: string,
  chamber: 'house' | 'senate',
  expected: Map<string, number>,
  tally: Map<string, { yea: number; nay: number; present: number; missing: number }>,
): ChamberTally {
  const key = issueChamberKey(issueId, chamber);
  const expectedCount = expected.get(key) ?? 0;
  const row = tally.get(key) ?? { yea: 0, nay: 0, present: 0, missing: 0 };
  if (expectedCount === 0) {
    throw new Error(`${issueId} has no expected ${chamber} voters`);
  }
  if (row.present + row.missing !== expectedCount) {
    throw new Error(
      `${issueId} ${chamber} has ${row.present}/${expectedCount} completed votes`,
    );
  }
  const passedIfMissingNay = row.yea > expectedCount / 2;
  const passedIfMissingYea = row.yea + row.missing > expectedCount / 2;
  if (passedIfMissingNay !== passedIfMissingYea) {
    throw new Error(
      `${issueId} ${chamber} outcome is ambiguous: ${row.missing} missing ` +
        `vote(s) could flip a ${row.yea}-${row.nay} tally of ${expectedCount}`,
    );
  }
  return {
    expected: expectedCount,
    present: row.present,
    missing: row.missing,
    yea: row.yea,
    nay: row.nay,
    passed: passedIfMissingNay,
  };
}

function issueChamberKey(issueId: string, chamber: 'house' | 'senate'): string {
  return `${issueId}:${chamber}`;
}
