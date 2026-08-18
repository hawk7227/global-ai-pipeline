# Corrected delta — 4 fixes, then deploy

Apply on top of the previously delivered `application-patch` and `runner-patch`.
Statuses unchanged: `NOT YET PROVEN SAFE` · `RESOURCE_EFFICIENCY_PARTIALLY_PROVEN`.
Milestone remains `CODE_INTEGRATED`.

## 1. candidateId now hashes untracked file CONTENTS

`computeCandidateId()` previously hashed the checkpoint SHA, the tracked diff, and the
untracked FILENAME LIST. Two candidates creating `new-file.ts` with different contents
therefore shared an identity.

Now hashes normalized path + size + SHA-256 of bytes, sorted deterministically. Uses
`-z` NUL separation so filenames containing spaces or newlines cannot split into phantom
entries. Symlinks record the link target, not the file they point at.

Proven against real git repositories (`live-repair/tests/candidate-identity.test.ts`,
10/10 passing):

```
content A -> cand:c4300306d7d5ba449676a8ae016a6d65e89ef8fc
content B -> cand:36550954403272f02cae89b45abd44696e5faa65
```

Same exact candidate reproduces the same id; a tracked edit, a rename, or an added
untracked file all change it.

## 2. Delivery state machine + independent verification

`POST .../release` now enforces `READY → DELIVERING → DELIVERED|DELIVERY_FAILED`.
A direct `READY → DELIVERED` is refused with 409.

`DELIVERED` additionally requires branch, finalRevision, prNumber and runCorrelationId,
and the application independently re-reads the branch head, commit SHA and pull request
through its OWN GitHub App installation. A claim that cannot be confirmed is recorded as
`DELIVERY_FAILED` — never promoted. Possession of `AGENT_RUNTIME_KEY` is no longer
sufficient to manufacture a delivery fact.

## 3. Pre-release candidate revalidation

`GET .../release` now returns `candidateId`, `startingRevision` and
`canonicalChangedFiles`.

`finalize.ts` recomputes candidate identity from the actual working tree with the same
deterministic function and requires `actualCandidateId === authorization.candidateId`
before any branch, commit, push or PR. Mismatch → `DELIVERY_FAILED` with candidate
provenance mismatch, no Git operation. The changed-file comparison now uses the
application's canonical list; the local artifact is context only.

Requires `LIVE_REPAIR_CHECKPOINT_SHA`, which `cloud-agent.ts` now publishes to
`GITHUB_ENV` at checkpoint creation so both computations share a checkpoint.

## 4. Runtime revision pinned

A new workflow step resolves `main` to one immutable SHA via `git ls-remote`, and every
runtime file is fetched from that SHA. The resolved value is exported as
`LIVE_REPAIR_RUNNER_REVISION` — this is also the deployment identity for run evidence.

## 5. Connectivity smoke test

`GET /api/live-repair/runner-ping` — authenticated, reads no task, changes no state.
`cloud-agent.ts` calls it before loading the task, so a key mismatch fails immediately and
unambiguously. The key is never echoed or logged; a 401 is the whole answer.

## 6. Still open, unchanged

`SUPABASE_SERVICE_ROLE_KEY → direct authoritative DB mutation` remains OPEN. The system is
not safe while that credential can write Live Repair state outside the adjudication
functions. Deferred to after the controlled run, as agreed.

## New environment requirement

`LIVE_REPAIR_CHECKPOINT_SHA` is produced at runtime by `cloud-agent.ts`. Nothing to
configure — but the delivery step must run in the same job so `GITHUB_ENV` carries it.
Verify this in the controlled run: if `finalize.ts` reports the variable missing, the
delivery step is running in a separate job.

## Verification

- Application `tsc`: 2403 (baseline 2414), zero new errors
- Application build: clean, both new routes registered
- Runner `tsc`: zero non-baseline errors
- Application suites: 19 + 49 + 67 + 37 = 172 passing
- Candidate identity: 10 passing against real git repos
