import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import { stableJson } from '../lib/hash.js';
import { parseArgs, stringArg } from '../lib/args.js';

const args = parseArgs();
const sourceUrl = stringArg(
  args,
  'source-database-url',
  process.env.CONGRESSIONAL_SIM_DATABASE_URL ?? process.env.SOURCE_DATABASE_URL,
);
const outDir = path.resolve(
  stringArg(args, 'out', 'reference/congressional-direct-vote/v1'),
);

const client = new pg.Client({ connectionString: sourceUrl });
await client.connect();

try {
  const issues = (
    await client.query(`
      select
        issue_id, title, congress, path, majority_position, national_support,
        real_outcome, real_concordant, paper_row_ref, question_text,
        real_house_outcome, real_senate_outcome
      from issues
      where not is_clean_slice
      order by issue_id
    `)
  ).rows.map((row) => ({
    issue_id: row.issue_id,
    title: row.title,
    congress: Number(row.congress),
    path: row.path,
    majority_position: row.majority_position,
    national_support: Number(row.national_support),
    real_outcome: row.real_outcome,
    real_concordant: row.real_concordant,
    paper_row_ref: row.paper_row_ref,
    question_text: row.question_text,
    real_house_outcome: row.real_house_outcome,
    real_senate_outcome: row.real_senate_outcome,
  }));
  const congresses = [...new Set(issues.map((issue) => issue.congress))].sort(
    (a, b) => a - b,
  );
  const rosters = (
    await client.query(
      `
        select
          member_id, congress, chamber, state, district, party,
          leadership_role, first_elected, last_margin, pvi, full_name
        from rosters
        where congress = any($1::int[])
        order by congress, chamber, state, district nulls first, member_id
      `,
      [congresses],
    )
  ).rows.map((row) => ({
    member_id: row.member_id,
    congress: Number(row.congress),
    chamber: row.chamber,
    state: row.state,
    district: row.district,
    party: row.party,
    leadership_role: row.leadership_role,
    first_elected: Number(row.first_elected),
    last_margin: row.last_margin === null ? null : Number(row.last_margin),
    pvi: row.pvi,
    full_name: row.full_name,
  }));
  const personas = (
    await client.query(
      `
        select
          p.persona_id, p.member_id, p.congress, p.persona_text,
          p.promise_source, p.content_hash
        from personas p
        join rosters r on r.member_id = p.member_id and r.congress = p.congress
        where p.congress = any($1::int[])
        order by p.congress, p.member_id
      `,
      [congresses],
    )
  ).rows.map((row) => ({
    persona_id: row.persona_id,
    member_id: row.member_id,
    congress: Number(row.congress),
    persona_text: row.persona_text,
    promise_source: row.promise_source,
    content_hash: row.content_hash,
  }));

  const provenance = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'congressional-sim postgres tables',
    issueFilter: 'not is_clean_slice',
    notes: [
      'This reference bundle intentionally uses paper-derived question_text as the only policy proposition supplied to model prompts.',
      'Public support, majority position, and real outcome are retained for deterministic analysis and are not promptable fields.',
    ],
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'issues.json'),
    `${stableJson(issues)}\n`,
  );
  await writeFile(
    path.join(outDir, 'rosters.jsonl'),
    `${rosters.map((row) => stableJson(row)).join('\n')}\n`,
  );
  await writeFile(
    path.join(outDir, 'personas.jsonl'),
    `${personas.map((row) => stableJson(row)).join('\n')}\n`,
  );
  await writeFile(
    path.join(outDir, 'provenance.json'),
    `${stableJson(provenance)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        outDir,
        issues: issues.length,
        rosters: rosters.length,
        personas: personas.length,
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
