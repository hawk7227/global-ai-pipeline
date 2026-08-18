import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { fetchReleaseAuthorization, reportDelivery } from './control-plane'
import { computeCandidateId, candidateChangedFiles } from './workspace-guard'

/**
 * Git delivery stage.
 *
 * This file used to read its own result artifact, branch on the status the runner had
 * written there, and — unless that status was REPAIR_FAILED — create a branch, commit,
 * push, open a pull request, and PATCH live_repair_tasks directly over PostgREST with the
 * Supabase service role. The runner was both the author of its own release authorization
 * and the writer of its own delivery outcome.
 *
 * Now the only thing that authorizes delivery is the control plane's adjudication, fetched
 * below. The local artifact is context only: a runner-authored REPAIR_VERIFIED does not
 * release itself, HUMAN_CONFIRMATION_REQUIRED does not release, and REPAIR_FAILED does not
 * release. Delivery outcomes are reported back through the control plane, so repair state
 * and delivery state remain separate facts.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const taskId = required('LIVE_REPAIR_TASK_ID')
const resultPath = required('LIVE_REPAIR_RESULT_PATH')
const repository = required('GITHUB_REPOSITORY')
const githubToken = required('GITHUB_TOKEN')
const workspace = required('GITHUB_WORKSPACE')

// Context only. Never a decision input.
const localResult = JSON.parse(readFileSync(resultPath, 'utf-8')) as {
  canonicalStatus?: string
  diagnosis: string
  changedFiles: string[]
  verification: Array<{ gate: string; status: string; evidence: string }>
}

// ── Authorization ────────────────────────────────────────────────────────────
const authorization = await fetchReleaseAuthorization(taskId)

if (!authorization.authorized) {
  // A truthful stop: no branch, no commit, no push, no PR, and nothing reported as
  // delivered. This is the expected outcome while Actions write remains unapproved —
  // repair REPAIR_VERIFIED with delivery BLOCKED_PERMISSION_APPROVAL.
  console.log(JSON.stringify({
    taskId,
    released: false,
    repairState: authorization.repairState,
    finalStatus: authorization.finalStatus,
    deliveryState: authorization.deliveryState,
    reason: authorization.reason,
  }, null, 2))
  process.exit(0)
}

// ── Delivery ─────────────────────────────────────────────────────────────────
await reportDelivery(taskId, { deliveryState: 'DELIVERING', detail: 'Creating the repair branch and commit.' })

try {
  const actualFiles = candidateChangedFiles(workspace)
  if (actualFiles.length === 0) {
    await reportDelivery(taskId, { deliveryState: 'DELIVERY_FAILED', detail: 'The authorized repair contained no source changes to deliver.' })
    throw new Error('No source changes exist to finalize.')
  }

  // ── Candidate provenance recheck ───────────────────────────────────────────
  // The control plane adjudicated one specific candidate. Comparing only the changed-FILE
  // LIST would not detect content changing inside those same files after adjudication, so
  // the candidate identity is recomputed here from the actual working tree using the same
  // deterministic algorithm the runner used when the candidate was built.
  const checkpointSha = required('LIVE_REPAIR_CHECKPOINT_SHA')
  const actualCandidateId = computeCandidateId(workspace, checkpointSha)

  if (!authorization.candidateId) {
    await reportDelivery(taskId, {
      deliveryState: 'DELIVERY_FAILED',
      detail: 'The control plane returned no authorized candidate identity, so the working tree cannot be reconciled against what was adjudicated.',
    })
    throw new Error('No authorized candidate identity was returned.')
  }

  if (actualCandidateId !== authorization.candidateId) {
    await reportDelivery(taskId, {
      deliveryState: 'DELIVERY_FAILED',
      detail: `Candidate provenance mismatch. Adjudicated ${authorization.candidateId}, working tree is ${actualCandidateId}. The tree no longer contains the candidate that was verified.`,
    })
    throw new Error(`Candidate provenance mismatch: adjudicated ${authorization.candidateId}, actual ${actualCandidateId}.`)
  }

  // The canonical changed-file list is the application's, not the local artifact's. The
  // local result stays context only.
  const canonicalFiles = [...authorization.canonicalChangedFiles].map((entry) => entry.trim()).sort()
  if (canonicalFiles.length && JSON.stringify(actualFiles) !== JSON.stringify(canonicalFiles)) {
    await reportDelivery(taskId, {
      deliveryState: 'DELIVERY_FAILED',
      detail: `Git state does not match the canonical adjudicated changed-file list. Canonical: ${canonicalFiles.join(', ')}. Actual: ${actualFiles.join(', ')}`,
    })
    throw new Error('Working tree does not match the canonical adjudicated changed-file list.')
  }

  console.log(`Candidate provenance confirmed: ${actualCandidateId} matches the adjudicated candidate.`)

  const branch = `repair/${taskId}`
  execSync(`git checkout -b ${branch}`, { cwd: workspace, stdio: 'inherit' })
  execSync('git add --all', { cwd: workspace, stdio: 'inherit' })
  execSync(
    `git -c user.name="Live Repair Agent" -c user.email="agent@users.noreply.github.com" commit -m "fix(live-repair): ${taskId}"`,
    { cwd: workspace, stdio: 'inherit' },
  )
  const finalRevision = execSync('git rev-parse HEAD', { cwd: workspace, encoding: 'utf-8' }).trim()
  execSync(`git push origin HEAD:${branch}`, { cwd: workspace, stdio: 'inherit' })

  const [owner, repo] = repository.split('/')

  // Idempotent PR creation: a lost response must not produce a second pull request for the
  // same branch, so an existing open one is reused.
  const existingResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
    { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
  )
  const existing = existingResponse.ok ? (await existingResponse.json()) as Array<{ number: number; html_url: string }> : []

  let pr: { number: number; html_url: string }
  if (existing.length > 0) {
    pr = existing[0]
    console.log(`Reusing existing pull request #${pr.number} for ${branch}.`)
  } else {
    const prResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `Live repair: ${taskId}`,
        head: branch,
        base: 'main',
        body: [
          `Repair task: ${taskId}`,
          `Canonical status: ${authorization.finalStatus} (decided by the application control plane)`,
          `Delivery authorized: ${authorization.reason}`,
          '',
          'Diagnosis:',
          localResult.diagnosis,
          '',
          'Verification:',
          ...localResult.verification.map((entry) => `- ${entry.gate}: ${entry.status} — ${entry.evidence}`),
        ].join('\n'),
      }),
    })
    if (!prResponse.ok) {
      const detail = await prResponse.text()
      await reportDelivery(taskId, {
        deliveryState: 'DELIVERY_FAILED', branch, finalRevision,
        detail: `Pull request creation failed (${prResponse.status}): ${detail}`,
      })
      throw new Error(`Pull request creation failed (${prResponse.status}): ${detail}`)
    }
    pr = await prResponse.json() as { number: number; html_url: string }
  }

  await reportDelivery(taskId, {
    deliveryState: 'DELIVERED', branch, prNumber: pr.number, prUrl: pr.html_url, finalRevision,
    runCorrelationId: `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`,
    detail: 'Branch pushed and pull request open.',
  })

  console.log(JSON.stringify({ taskId, released: true, branch, finalRevision, pullRequest: pr.number, pullRequestUrl: pr.html_url }, null, 2))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    await reportDelivery(taskId, { deliveryState: 'DELIVERY_FAILED', detail: message })
  } catch (reportError) {
    console.error('Delivery failure could not be reported:', reportError instanceof Error ? reportError.message : String(reportError))
  }
  console.error('Live repair delivery failed:', message)
  process.exitCode = 1
}
