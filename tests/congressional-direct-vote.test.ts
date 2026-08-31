import { describe, expect, it } from 'vitest';

import {
  directVotePrompt,
  directVoteTasks,
  parseDirectVoteDecision,
} from '../src/simulations/congressional-direct-vote.js';

const files = {
  'issues.json': Buffer.from(
    JSON.stringify([
      {
        issue_id: 'test-issue',
        title: 'Test Issue',
        congress: 118,
        path: 'bicameral',
        majority_position: 'pass',
        national_support: 0.74,
        real_outcome: 'not_passed',
        real_concordant: false,
        paper_row_ref: 'fixture row',
        question_text: 'Adopt a narrowly described fixture proposition.',
        real_house_outcome: 'passed',
        real_senate_outcome: 'not_passed',
      },
    ]),
  ),
  'rosters.jsonl': Buffer.from(
    [
      JSON.stringify({
        member_id: 'H001',
        congress: 118,
        chamber: 'house',
        state: 'CA',
        district: '12',
        party: 'Democrat',
        leadership_role: null,
        first_elected: 2018,
        last_margin: 12.5,
        pvi: 'D+20',
        full_name: 'House Member',
      }),
      JSON.stringify({
        member_id: 'S001',
        congress: 118,
        chamber: 'senate',
        state: 'CA',
        district: null,
        party: 'Democrat',
        leadership_role: null,
        first_elected: 2016,
        last_margin: 20,
        pvi: null,
        full_name: 'Senate Member',
      }),
    ].join('\n'),
  ),
  'personas.jsonl': Buffer.from(
    [
      JSON.stringify({
        persona_id: 'H001-118',
        member_id: 'H001',
        congress: 118,
        persona_text: 'Prioritizes consumer protection and district jobs.',
        promise_source: 'campaignview',
        content_hash: 'sha256:fixture',
      }),
      JSON.stringify({
        persona_id: 'S001-118',
        member_id: 'S001',
        congress: 118,
        persona_text: 'Prioritizes statewide growth and institutional stability.',
        promise_source: 'campaignview',
        content_hash: 'sha256:fixture',
      }),
    ].join('\n'),
  ),
};

describe('congressional direct-vote simulation', () => {
  it('expands one bicameral issue into one task per chamber member', () => {
    expect(directVoteTasks(files)).toEqual([
      {
        taskId: 'test-issue:house:H001',
        issueId: 'test-issue',
        chamber: 'house',
        memberId: 'H001',
      },
      {
        taskId: 'test-issue:senate:S001',
        issueId: 'test-issue',
        chamber: 'senate',
        memberId: 'S001',
      },
    ]);
  });

  it('prompts with the proposition but not answer-key fields', () => {
    const prompt = directVotePrompt(files, directVoteTasks(files)[0]!);
    expect(prompt.user).toContain('Adopt a narrowly described fixture proposition.');
    expect(prompt.user).toContain('Prioritizes consumer protection');
    expect(prompt.user).not.toContain('0.74');
    expect(prompt.user).not.toContain('not_passed');
    expect(prompt.user).not.toContain('majority_position');
  });

  it('accepts fenced JSON and normalizes vote case', () => {
    expect(
      parseDirectVoteDecision(
        '```json\n{"vote":"YEA","rationale":"This is a complete rationale."}\n```',
      ),
    ).toEqual({
      vote: 'yea',
      rationale: 'This is a complete rationale.',
    });
  });
});
