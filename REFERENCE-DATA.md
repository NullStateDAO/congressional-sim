# Reference Data Contract

Reference data is part of the experimental protocol. It should be reproducible, reviewable, immutable after publication, and independently verifiable by every worker.

## Source Layout

```text
reference/<dataset-or-simulation>/<semantic-version>/
  README.md
  provenance.json
  records.jsonl
  supporting-table.csv
```

Small simulations can use a few JSON files, as hello-world does. Large simulations should use partitioned JSONL or Parquet and keep a small index describing which partitions each task needs.

Recommended `provenance.json` fields:

```json
{
  "schemaVersion": 1,
  "dataset": "example",
  "version": "v1",
  "createdAt": "2026-08-22T00:00:00Z",
  "sources": [
    {
      "url": "https://example.com/source",
      "retrievedAt": "2026-08-20T00:00:00Z",
      "license": "CC-BY-4.0"
    }
  ],
  "transform": "scripts/build-reference.ts",
  "notes": "Null values mean unavailable, not zero."
}
```

## Publication

`reference:publish` recursively uploads source files and creates a deterministic manifest. Objects are addressed by SHA-256 content hashes. The manifest records each relative path, object key, media type, size, and hash.

The manifest itself is also content-addressed. Jobs contain both its S3 key and expected hash. Workers reject modified, missing, or mismatched files before making model calls.

## Versioning

Create a new version when any of these change:

- Field meaning, units, normalization, or null semantics.
- Source population or collection method.
- Task identity or task-expansion rules.
- Material corrections to records.
- Prompt-relevant text or provenance.

Formatting-only changes technically produce a new hash. Canonical generation scripts are therefore preferable to hand-edited generated files.

## Job Payloads

Queue payloads should remain small. Store stable task IDs, seed, model, simulation type, and reference-manifest identity in BullMQ. Do not copy large reference records into Redis jobs.

Workers should load reference bundles by manifest hash, cache them locally, and derive the exact task from its stable ID. This avoids Redis memory pressure and guarantees that every Droplet sees identical inputs.

## Public And Private Data

Never publish credentials, personal secrets, provider tokens, or restricted source material. Keep public and private experiments in separate buckets or prefixes with explicit access policies. A public artifact manifest should include only data that can be redistributed under its source licenses.
