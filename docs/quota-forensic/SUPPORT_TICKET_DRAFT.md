# Turso support ticket — DRAFT v3 (Rem sends; never send from a session)

Status: DRAFT v3, Aug 8 2026 ~3:25 AM ET. Rewritten after the forensic resolved: the
billing DATA checks out exactly (our burn was real — an app bug we've fixed), so this
is no longer an impeachment. It reports reproducible REPORTING/OPS defects observed
while investigating, plus two questions. Optional to send; nothing here blocks us.

---

**Subject:** Usage-reporting anomalies observed on org `remtbkv` during an instance
migration (pulse outage, storage_bytes=0, transient bytes_synced decrease)

**Body:**

Hi — while running a detailed usage forensic on my org (`remtbkv`, single database
`lazy-boy`, aws-us-east-1) I hit several platform-side reporting anomalies worth
reporting. My app's burn itself reconciled exactly against the windowed usage API
(great instrument, by the way), so these are observability issues, not billing
disputes:

1. **Usage aggregation outage.** Aug 8 2026, ~1:37–2:23 AM ET:
   `GET /v1/organizations/remtbkv/usage` and the per-database windowed endpoint hung
   >90 s per request, then returned
   `{"error":"error getting pulse usage for organization 51721ab6-…: received
   response with status code 502"}` before recovering. Other org endpoints answered
   in <0.5 s throughout. This coincided with an instance change on my database (the
   live instances endpoint began returning a new uuid `fa59eb0e…` that appears in no
   usage response).
2. **org-level `storage_bytes: 0`** in the usage response while the same response's
   per-instance objects carry real values (~9.7 MB each). Still reproducible as of
   this writing.
3. **A cumulative counter transiently decreased.** `bytes_synced` read 2.42 GB
   repeatedly Aug 6–7, dipped to 2.28 GB (Aug 8 1:06 AM ET), then recovered to
   2.45 GB — consistent with an aggregation transiently dropping one instance's
   contribution during the migration window.
4. **Quota enforcement lag.** Reads blocked at ~514M rows read, 14M past the 500M
   line — ~5 h of my burn rate. Expected/documented?

Questions:
- My database was instance-migrated twice this month (`3d5671ac` → `55ae7a03`,
  Aug 6; `55ae7a03` → `fa59eb0e`, Aug 8 — the second during the pulse outage). Is
  that expected churn, and is the new instance's ~25.9 MB of `bytes_synced` (which I
  read as the migration's own data transfer) intentionally billed to the customer's
  syncs quota?
- Is there a documented posting-cadence/SLA for the usage API? (Empirically I
  measured ≤30 s for my own writes, which was better than I feared.)

Timestamped API captures for all of the above are available on request.
