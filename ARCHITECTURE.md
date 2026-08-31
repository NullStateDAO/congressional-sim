# Architecture

```text
                         +----------------------+
                         | DigitalOcean private |
                         | VPC                  |
                         +----------+-----------+
                                    |
              +---------------------+---------------------+
              |                     |                     |
       +------v------+       +------v------+       +------v------+
       | Worker 1    |       | Worker 2    |  ...  | Worker N    |
       | OpenRouter  |       | OpenRouter  |       | OpenRouter  |
       | account 1   |       | account 2   |       | account N   |
       +------+------+       +------+------+       +------+------+
              |                     |                     |
              +---------------------+---------------------+
                                    |
                           +--------v---------+
                           | Controller       |
                           | Redis / BullMQ   |
                           | PostgreSQL       |
                           | MinIO (S3)       |
                           +------------------+
```

## Responsibilities

- BullMQ/Redis owns runnable job state, locks, retry timing, and stalled-job recovery.
- PostgreSQL owns durable experiment metadata, result indexes, worker heartbeats, and completion status.
- S3 owns immutable reference bundles, complete call artifacts, failed-attempt evidence, and final manifests.
- Workers are stateless and interchangeable except for their OpenRouter account key.
- The supervisor observes PostgreSQL and writes the final manifest after complete convergence.

## Delivery Semantics

BullMQ is at least once. A worker may receive a job again after losing its lock or crashing after an external side effect. Deterministic IDs and attempt-specific object keys make duplicate delivery inspectable. PostgreSQL accepts the first successful completion and later deliveries return the stored result.

## Scaling Boundary

This layout scales horizontally while OpenRouter accounts and upstream providers have capacity. The default controller eventually becomes the bottleneck or availability risk. At that point, move each service to a managed offering without changing queue payloads or worker code.
