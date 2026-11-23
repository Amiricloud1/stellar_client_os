# Background job payload compatibility

Campaign export jobs use an additive, versioned payload envelope:

- New jobs write `payloadVersion: 1` and a `{ campaignId, format }` payload.
- The legacy top-level `campaignId` and `format` fields remain present so an
  older worker can continue processing a job created during a rolling deploy.
- A new worker treats a job without `payloadVersion` as the legacy v1 shape.
- Unknown versions are rejected before changing job status or attempts. The
  job remains queued for a compatible worker or for rollback; do not delete or
  rewrite pending jobs during deployment rollback.

## Deployment drain

Before shutting down a worker, stop scheduling new work and take a fixed
snapshot of its queued job IDs. Pass that snapshot to `drainExportJobs()` so
each job's bounded work units complete before shutdown. Jobs created after the
snapshot are intentionally left queued for the next worker. If a job has a
payload version the current worker does not understand, draining fails
explicitly and leaves that job intact.

Keep the v1 envelope and legacy fields readable for at least one full deploy
and rollback window before introducing a new payload version. A future version
must have an explicit reader and migration plan before producers emit it.
