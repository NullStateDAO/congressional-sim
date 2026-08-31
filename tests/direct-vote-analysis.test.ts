import { describe, expect, it } from 'vitest';

import { analyzeDirectVotes } from '../src/analysis/direct-vote.js';
import type { DirectVoteIssue, DirectVoteTask } from '../src/simulations/congressional-direct-vote.js';

const baseIssue = {
  congress: 118,
  national_support: 0.6,
  real_outcome: 'passed',
  real_concordant: true,
  paper_row_ref: 'fixture',
  question_text: 'Fixture proposition.',
} satisfies Omit<
  DirectVoteIssue,
  'issue_id' | 'title' | 'path' | 'majority_position'
>;

describe('direct-vote analysis', () => {
  it('requires both chambers for bicameral passage', () => {
    const issues: DirectVoteIssue[] = [
      {
        ...baseIssue,
        issue_id: 'bicameral',
        title: 'Bicameral',
        path: 'bicameral',
        majority_position: 'pass',
      },
    ];
    const tasks: DirectVoteTask[] = [
      task('bicameral', 'house', 'h1'),
      task('bicameral', 'house', 'h2'),
      task('bicameral', 'house', 'h3'),
      task('bicameral', 'senate', 's1'),
      task('bicameral', 'senate', 's2'),
      task('bicameral', 'senate', 's3'),
    ];
    const results = analyzeDirectVotes({
      issues,
      tasks,
      jobs: [
        job(tasks[0]!, 'yea'),
        job(tasks[1]!, 'yea'),
        job(tasks[2]!, 'nay'),
        job(tasks[3]!, 'yea'),
        job(tasks[4]!, 'nay'),
        job(tasks[5]!, 'nay'),
      ],
    });
    expect(results.outcomes[0]!.house?.passed).toBe(true);
    expect(results.outcomes[0]!.senate.passed).toBe(false);
    expect(results.outcomes[0]!.agentPassed).toBe(false);
    expect(results.agentConcordant).toBe(0);
  });

  it('uses only the Senate for senate-only issues', () => {
    const issues: DirectVoteIssue[] = [
      {
        ...baseIssue,
        issue_id: 'nomination',
        title: 'Nomination',
        path: 'senate_only',
        majority_position: 'block',
      },
    ];
    const tasks = [
      task('nomination', 'senate', 's1'),
      task('nomination', 'senate', 's2'),
      task('nomination', 'senate', 's3'),
    ];
    const results = analyzeDirectVotes({
      issues,
      tasks,
      jobs: [job(tasks[0]!, 'nay'), job(tasks[1]!, 'nay'), job(tasks[2]!, 'yea')],
    });
    expect(results.outcomes[0]!.house).toBeNull();
    expect(results.outcomes[0]!.agentPassed).toBe(false);
    expect(results.agentConcordant).toBe(1);
  });

  it('tolerates missing votes only when the outcome is invariant', () => {
    const issues: DirectVoteIssue[] = [
      {
        ...baseIssue,
        issue_id: 'censored',
        title: 'Censored',
        path: 'senate_only',
        majority_position: 'block',
      },
    ];
    const tasks = [
      task('censored', 'senate', 's1'),
      task('censored', 'senate', 's2'),
      task('censored', 'senate', 's3'),
      task('censored', 'senate', 's4'),
      task('censored', 'senate', 's5'),
    ];
    const jobs = [
      job(tasks[0]!, 'nay'),
      job(tasks[1]!, 'nay'),
      job(tasks[2]!, 'nay'),
      job(tasks[3]!, 'nay'),
      { task_id: tasks[4]!.taskId, status: 'failed', result: null },
    ];
    expect(() => analyzeDirectVotes({ issues, tasks, jobs })).toThrow(
      /incomplete job/,
    );
    const results = analyzeDirectVotes(
      { issues, tasks, jobs },
      { allowMissingVotes: 1 },
    );
    expect(results.missingVotes).toBe(1);
    expect(results.outcomes[0]!.senate.missing).toBe(1);
    expect(results.outcomes[0]!.senate.passed).toBe(false);
  });

  it('rejects missing votes that could flip a chamber outcome', () => {
    const issues: DirectVoteIssue[] = [
      {
        ...baseIssue,
        issue_id: 'knife-edge',
        title: 'Knife Edge',
        path: 'senate_only',
        majority_position: 'block',
      },
    ];
    const tasks = [
      task('knife-edge', 'senate', 's1'),
      task('knife-edge', 'senate', 's2'),
      task('knife-edge', 'senate', 's3'),
    ];
    const jobs = [
      job(tasks[0]!, 'yea'),
      job(tasks[1]!, 'nay'),
      { task_id: tasks[2]!.taskId, status: 'failed', result: null },
    ];
    expect(() =>
      analyzeDirectVotes({ issues, tasks, jobs }, { allowMissingVotes: 1 }),
    ).toThrow(/ambiguous/);
  });

  it('treats ties as failures', () => {
    const issues: DirectVoteIssue[] = [
      {
        ...baseIssue,
        issue_id: 'tie',
        title: 'Tie',
        path: 'senate_only',
        majority_position: 'block',
      },
    ];
    const tasks = [task('tie', 'senate', 's1'), task('tie', 'senate', 's2')];
    const results = analyzeDirectVotes({
      issues,
      tasks,
      jobs: [job(tasks[0]!, 'yea'), job(tasks[1]!, 'nay')],
    });
    expect(results.outcomes[0]!.senate.passed).toBe(false);
    expect(results.agentConcordant).toBe(1);
  });
});

function task(
  issueId: string,
  chamber: 'house' | 'senate',
  memberId: string,
): DirectVoteTask {
  return {
    taskId: `${issueId}:${chamber}:${memberId}`,
    issueId,
    chamber,
    memberId,
  };
}

function job(task: DirectVoteTask, vote: 'yea' | 'nay') {
  return {
    task_id: task.taskId,
    result: {
      vote,
      issueId: task.issueId,
      chamber: task.chamber,
      memberId: task.memberId,
    },
  };
}
