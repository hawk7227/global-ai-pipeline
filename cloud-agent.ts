import { Agent, run, tool } from '@openai/agents'
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from 'fs'
import { resolve, join, relative, sep } from 'path'
import { z } from 'zod'
import { fetchProtectionSurface, pingControlPlane, reportTransition, submitReceipt, submitResult, type ProtectionSurface } from './live-repair/control-plane'
import { guardWorkspaceWrite, commandCanMutateSource, computeCandidateId, candidateDiff } from './live-repair/workspace-guard'

const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd()
const taskId = requiredEnv('LIVE_REPAIR_TASK_ID')
const appDataUrl = requiredEnv('APP_DATA_URL').replace(/\/$/, '')
const appDataServiceKey = requiredEnv('APP_DATA_SERVICE_KEY')
const resultPath = requiredEnv('LIVE_REPAIR_RESULT_PATH')
const configuredAttempts = Number(requiredEnv('LIVE_REPAIR_MAX_ATTEMPTS'))
if (!Number.isInteger(configuredAttempts) || configuredAttempts < 1) throw new Error('LIVE_REPAIR_MAX_ATTEMPTS must be a positive integer.')

interface RepairTask {
  schemaVersion: '1.0'
  taskId: string
  createdAt: string
  repository: { owner: string; name: string }
  revision: string
  route: string
  userRequest: string
  scope: { authorized: string[]; prohibited: string[] }
  requiredProof: string[]
  evidence: unknown
}

type RepairState =
  | 'RECEIVED' | 'EVIDENCE_VALIDATED' | 'REVISION_ESTABLISHED' | 'LOCATING_SOURCE' | 'DEFECT_REPRODUCED'
  | 'DIAGNOSED' | 'CHECKPOINT_CREATED' | 'PATCHING' | 'STATIC_CHECK' | 'TESTING' | 'BUILDING'
  | 'BEHAVIOR_VERIFY' | 'REGRESSION_VERIFY' | 'ROLLING_BACK' | 'HUMAN_CONFIRMATION_REQUIRED' | 'SUCCEEDED' | 'FAILED'

type VerificationStatus = 'PASS' | 'FAIL' | 'UNAVAILABLE'
type FinalStatus = 'REPAIR_VERIFIED' | 'REPAIR_FAILED' | 'HUMAN_CONFIRMATION_REQUIRED'

interface FinalResult {
  schemaVersion: '1.0'
  taskId: string
  status: FinalStatus
  repository: string
  startingRevision: string
  finalRevision: string | null
  diagnosis: string
  changedFiles: string[]
  verification: Array<{ gate: string; status: VerificationStatus; evidence: string }>
  rollback: { needed: boolean; completed: boolean }
  failureCode: string | null
  humanConfirmationReason: string | null
}

interface BudgetTracker { attempts: number; maxAttempts: number }
const activeBudget: BudgetTracker = { attempts: 0, maxAttempts: configuredAttempts }
let currentState: RepairState = 'LOCATING_SOURCE'
let diagnosis = ''
let checkpointSha: string | null = null
let terminalResult: FinalResult | null = null
let candidateId: string | null = null
let protectionSurface: ProtectionSurface | null = null
const mutationRationales: Array<{ path: string; requirement: string; necessary: boolean }> = []
const baselineChecks: Array<{ name: string; status: 'PASS' | 'FAIL' | 'SKIPPED' | 'DISABLED'; detail?: string | null }> = []
const candidateChecks: Array<{ name: string; status: 'PASS' | 'FAIL' | 'SKIPPED' | 'DISABLED'; detail?: string | null }> = []
const runCorrelationId = `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`

const stateTransitions: Record<RepairState, RepairState[]> = {
  RECEIVED: ['EVIDENCE_VALIDATED', 'FAILED'],
  EVIDENCE_VALIDATED: ['REVISION_ESTABLISHED', 'FAILED'],
  REVISION_ESTABLISHED: ['LOCATING_SOURCE', 'FAILED'],
  LOCATING_SOURCE: ['DEFECT_REPRODUCED', 'FAILED', 'HUMAN_CONFIRMATION_REQUIRED'],
  DEFECT_REPRODUCED: ['DIAGNOSED', 'FAILED'],
  DIAGNOSED: ['CHECKPOINT_CREATED', 'FAILED'],
  CHECKPOINT_CREATED: ['PATCHING', 'FAILED'],
  PATCHING: ['STATIC_CHECK', 'ROLLING_BACK', 'FAILED'],
  STATIC_CHECK: ['TESTING', 'BUILDING', 'ROLLING_BACK', 'FAILED'],
  TESTING: ['BUILDING', 'BEHAVIOR_VERIFY', 'ROLLING_BACK', 'FAILED'],
  BUILDING: ['BEHAVIOR_VERIFY', 'ROLLING_BACK', 'FAILED'],
  BEHAVIOR_VERIFY: ['REGRESSION_VERIFY', 'ROLLING_BACK', 'HUMAN_CONFIRMATION_REQUIRED', 'FAILED'],
  REGRESSION_VERIFY: ['SUCCEEDED', 'ROLLING_BACK', 'FAILED'],
  ROLLING_BACK: ['FAILED'],
  HUMAN_CONFIRMATION_REQUIRED: [],
  SUCCEEDED: [],
  FAILED: [],
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function isWithinWorkspace(path: string): boolean {
  const normalizedWorkspace = resolve(workspaceDir)
  const normalizedPath = resolve(path)
  return normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}${sep}`)
}

function resolveWorkspacePath(relativePath: string): string {
  const target = resolve(workspaceDir, relativePath)
  if (!isWithinWorkspace(target)) throw new Error(`Path escapes workspace: ${relativePath}`)
  return target
}

function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const base = normalized.split('/').pop() || ''
  return base === '.env' || base.startsWith('.env.') || /(^|[._-])(secret|credential|private[-_]?key)([._-]|$)/.test(base)
}

function shellCommandAllowed(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  const blocked = [
    /(^|\s)(env|printenv)(\s|$)/i,
    /(^|\s)(curl|wget|ssh|scp|nc|netcat)(\s|$)/i,
    /(^|\s)git\s+(push|reset|clean)(\s|$)/i,
    /(^|\s)rm\s+-[^\n]*r[^\n]*f/i,
    /\.env(?:\.|\s|$)/i,
    /(authorization|bearer|api[_-]?key|service[_-]?role[_-]?key|private[_-]?key)/i,
  ]
  return blocked.every((pattern) => !pattern.test(trimmed))
}

/**
 * READ-ONLY task retrieval.
 *
 * This was a general-purpose read/write helper: it carried the Supabase service role and
 * was used to INSERT lifecycle events and PATCH live_repair_tasks, which let the runner
 * write authoritative state around the control plane. It is now restricted to GET, and
 * the method is asserted rather than assumed so a future edit cannot quietly restore
 * write capability through the same function.
 *
 * The remaining read exists because task loading has not been redesigned yet. It cannot
 * change any authoritative state.
 */
async function dataRead(path: string) {
  const response = await fetch(`${appDataUrl}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: appDataServiceKey,
      Authorization: `Bearer ${appDataServiceKey}`,
      'Content-Type': 'application/json',
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Repair data read failed (${response.status}): ${text}`)
  return text ? JSON.parse(text) : null
}

async function loadTask(): Promise<RepairTask> {
  const rows = await dataRead(`live_repair_tasks?id=eq.${encodeURIComponent(taskId)}&select=*`)
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`Repair task ${taskId} was not found.`)
  const row = rows[0]
  const task: RepairTask = {
    schemaVersion: '1.0',
    taskId: row.id,
    createdAt: row.created_at,
    repository: { owner: row.repository_owner, name: row.repository_name },
    revision: row.revision,
    route: row.route,
    userRequest: row.user_request,
    scope: { authorized: row.authorized_scope, prohibited: row.prohibited_scope },
    requiredProof: row.required_proof,
    evidence: row.evidence,
  }
  if (task.taskId !== taskId) throw new Error('Loaded repair task ID does not match requested task ID.')
  if (task.revision !== requiredEnv('LIVE_REPAIR_STARTING_REVISION')) throw new Error('Repair task revision does not match checked-out revision.')
  if (task.repository.owner + '/' + task.repository.name !== requiredEnv('GITHUB_REPOSITORY')) throw new Error('Repair task repository does not match workflow repository.')
  return task
}

/**
 * Reports one lifecycle transition to the control plane as it actually occurs.
 *
 * Sequence allocation is gone from here: the application allocates it inside the same
 * transaction as the transition, so two reports cannot collide. The local state machine
 * check is kept as a fast local guard, but the application's decision is authoritative —
 * a refused transition throws, and the runner does not advance `currentState`.
 */
async function emitStatus(state: RepairState, message: string, file: string | null = null, summary: string | null = null) {
  if (state !== currentState && !stateTransitions[currentState].includes(state)) {
    throw new Error(`Invalid live repair state transition: ${currentState} -> ${state}`)
  }
  await reportTransition(taskId, { state, message, file, summary })
  currentState = state
}

/**
 * Submits the candidate result and records the CANONICAL adjudication.
 *
 * The runner no longer writes final_status or final_result. What it submits is a claim;
 * the application re-decides it against the recorded events, the candidate-bound receipts
 * and the integrity evaluation, and may downgrade it. `terminalResult` therefore holds the
 * decided status, not the requested one, so nothing downstream acts on a status the
 * control plane rejected.
 */
async function persistFinalResult(result: FinalResult) {
  const adjudication = await submitResult(taskId, {
    ...result,
    candidateId,
    mutationRationales,
    baselineChecks,
    candidateChecks,
    candidateDiff: checkpointSha ? candidateDiff(workspaceDir, checkpointSha) : null,
  })

  const decided: FinalResult = { ...result, status: adjudication.decidedStatus as FinalStatus }
  if (adjudication.downgraded) {
    console.warn(`Control plane downgraded ${adjudication.claimedStatus} to ${adjudication.decidedStatus}: ${adjudication.reasons.join(' ')}`)
  }

  // The local artifact is workflow continuity only. finalize.ts must not branch on it;
  // it asks the control plane for release authorization instead.
  writeFileSync(resultPath, JSON.stringify({
    ...decided,
    submittedStatus: result.status,
    canonicalStatus: adjudication.decidedStatus,
    deliveryState: adjudication.delivery?.state ?? 'NOT_ELIGIBLE',
    note: 'canonicalStatus is the control plane decision. This file is not authorization to release.',
  }, null, 2), 'utf-8')

  terminalResult = decided
}

function listChangedFiles(): string[] {
  const output = execSync('git status --porcelain', { cwd: workspaceDir, encoding: 'utf-8' })
  return output.split('\n').filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean)
}

const scanDirectoryTree = tool({
  name: 'scanDirectoryTree',
  description: 'Returns a bounded repository file index for source discovery. Generated, dependency, VCS, and secret-bearing paths are excluded.',
  parameters: z.object({}),
  execute: async () => {
    const files: string[] = []
    const excluded = new Set(['node_modules', '.git', '.vercel', '.next', 'dist', 'build', 'coverage'])
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (excluded.has(entry)) continue
        const absolute = join(dir, entry)
        const rel = relative(workspaceDir, absolute)
        if (isSensitivePath(rel)) continue
        if (statSync(absolute).isDirectory()) walk(absolute)
        else files.push(rel)
      }
    }
    walk(workspaceDir)
    return { status: 'SUCCESS', files }
  },
})

const readTargetFile = tool({
  name: 'readTargetFile',
  description: 'Reads an exact non-secret workspace file after its path has been established.',
  parameters: z.object({ relativePath: z.string() }),
  execute: async ({ relativePath }) => {
    try {
      if (isSensitivePath(relativePath)) return { status: 'ERROR', message: 'Sensitive files are not readable by the repair agent.' }
      const target = resolveWorkspacePath(relativePath)
      return { status: 'SUCCESS', content: readFileSync(target, 'utf-8') }
    } catch (error) {
      return { status: 'ERROR', message: error instanceof Error ? error.message : String(error) }
    }
  },
})

const recordDiagnosis = tool({
  name: 'recordDiagnosis',
  description: 'Records a source-backed diagnosis only after the reported condition and active source mechanism have been established.',
  parameters: z.object({ diagnosis: z.string().min(1), evidenceSummary: z.string().min(1) }),
  execute: async ({ diagnosis: value, evidenceSummary }) => {
    if (currentState !== 'LOCATING_SOURCE') return { status: 'ERROR', message: `Diagnosis cannot be recorded from ${currentState}.` }
    await emitStatus('DEFECT_REPRODUCED', 'Reported condition established from task evidence and repository investigation.', null, evidenceSummary)
    diagnosis = value
    await emitStatus('DIAGNOSED', 'Responsible active source mechanism established.', null, value)
    return { status: 'SUCCESS', diagnosis: value }
  },
})

const createSourceCheckpoint = tool({
  name: 'createSourceCheckpoint',
  description: 'Records the exact Git commit used as the rollback checkpoint before source mutation.',
  parameters: z.object({ checkpointMessage: z.string().min(1) }),
  execute: async ({ checkpointMessage }) => {
    if (currentState !== 'DIAGNOSED') return { status: 'ERROR', message: `Checkpoint cannot be created from ${currentState}.` }
    const dirty = execSync('git status --porcelain', { cwd: workspaceDir, encoding: 'utf-8' }).trim()
    if (dirty) return { status: 'ERROR', message: 'Workspace is not clean before the repair checkpoint.' }
    checkpointSha = execSync('git rev-parse HEAD', { cwd: workspaceDir, encoding: 'utf-8' }).trim()
    // Published so the delivery stage can recompute candidate identity from the same
    // checkpoint. Without a shared checkpoint the two computations would disagree even for
    // an unchanged tree, and the provenance recheck would fail for the wrong reason.
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, `LIVE_REPAIR_CHECKPOINT_SHA=${checkpointSha}\n`)
    }
    await emitStatus('CHECKPOINT_CREATED', 'Source checkpoint created.', null, checkpointMessage)
    return { status: 'SUCCESS', checkpointSha }
  },
})

const patchCodeDiff = tool({
  name: 'patchCodeDiff',
  description: 'Performs one exact surgical search-and-replace patch in a workspace file.',
  parameters: z.object({
    relativePath: z.string(),
    searchBlock: z.string().min(1),
    replaceBlock: z.string(),
    // Mutation accountability: the control plane blocks release on any task-created change
    // with no recorded justification, so it is captured at the moment of the patch.
    requirement: z.string().min(1).describe('Which established finding requires this exact change.'),
  }),
  execute: async ({ relativePath, searchBlock, replaceBlock, requirement }) => {
    if (!checkpointSha) return { status: 'ERROR', message: 'A source checkpoint is required before patching.' }
    if (isSensitivePath(relativePath)) return { status: 'ERROR', message: 'Sensitive files cannot be patched.' }

    // PRE-WRITE protected-surface check. The policy comes from the control plane, and the
    // path is canonicalised first so ./x, ../x, an absolute path or a symlink alias all
    // resolve to the same decision. A refusal happens before any byte is written.
    if (protectionSurface) {
      const guard = guardWorkspaceWrite({ targetPath: relativePath, workspaceDir, surface: protectionSurface })
      if (!guard.allowed) {
        return { status: 'BLOCKED', message: guard.reason ?? 'Mutation refused by the enforcement protection surface.' }
      }
    }

    try {
      const target = resolveWorkspacePath(relativePath)
      const original = readFileSync(target, 'utf-8')
      const occurrences = original.split(searchBlock).length - 1
      if (occurrences !== 1) return { status: 'ERROR', message: `Expected exactly one search block match in ${relativePath}; found ${occurrences}.` }
      if (currentState === 'CHECKPOINT_CREATED') await emitStatus('PATCHING', 'Applying the bounded source repair.', relativePath)
      writeFileSync(target, original.replace(searchBlock, replaceBlock), 'utf-8')

      mutationRationales.push({ path: relativePath, requirement, necessary: true })
      // Candidate identity is recomputed from the actual diff after every mutation, so it
      // always describes the current candidate rather than a stale one.
      candidateId = computeCandidateId(workspaceDir, checkpointSha)

      return { status: 'SUCCESS', message: `Patched ${relativePath}.`, candidateId }
    } catch (error) {
      return { status: 'ERROR', message: error instanceof Error ? error.message : String(error) }
    }
  },
})

const runLiveCommand = tool({
  name: 'runLiveCommand',
  description: 'Runs a repository-justified local verification command. Network utilities, secret inspection, destructive Git commands, and pushes are blocked.',
  parameters: z.object({
    command: z.string().min(1),
    purpose: z.enum(['STATIC_CHECK', 'TESTING', 'BUILDING', 'BEHAVIOR_VERIFY', 'REGRESSION_VERIFY']),
  }),
  execute: async ({ command, purpose }) => {
    if (!shellCommandAllowed(command)) return { status: 'BLOCKED', output: 'Command blocked by repair runner policy.' }

    // A guarded patch tool with an unguarded shell is not protection. In-place editors and
    // file movers can reach protected source without passing the write guard, so they are
    // refused for an ordinary repair; source mutation must go through patchCodeDiff.
    const mutating = commandCanMutateSource(command)
    if (mutating.capable && protectionSurface?.taskClass !== 'CONTROL_PLANE_MAINTENANCE') {
      return {
        status: 'BLOCKED',
        output: `This command can modify source outside the guarded patch path (matched "${mutating.matched}"). Use patchCodeDiff so the target is checked against the enforcement protection surface before any write.`,
      }
    }

    activeBudget.attempts += 1
    if (activeBudget.attempts > activeBudget.maxAttempts) return { status: 'BUDGET_EXHAUSTED', output: 'Configured repair execution-attempt budget exhausted.' }
    if (currentState !== purpose) await emitStatus(purpose, `${purpose.replaceAll('_', ' ').toLowerCase()} running.`)

    const startedAt = new Date().toISOString()
    let exitCode: number | null = 0
    let output = ''
    let failed = false
    try {
      output = execSync(command, { cwd: workspaceDir, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 })
    } catch (error: unknown) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; status?: number }
      exitCode = failure.status ?? null
      output = failure.stdout || failure.stderr || failure.message || 'Command failed.'
      failed = true
    }
    const finishedAt = new Date().toISOString()

    // Checks are recorded on both sides of the checkpoint so the control plane can tell a
    // pre-existing failure from one this candidate created.
    const checkRecord = { name: `${purpose}:${command}`, status: (failed ? 'FAIL' : 'PASS') as 'PASS' | 'FAIL', detail: failed ? output.slice(0, 500) : null }
    if (candidateId) candidateChecks.push(checkRecord)
    else baselineChecks.push(checkRecord)

    // A verification execution produces a receipt. This is the only way a required gate
    // can reach PASS: the outcome comes from the command's exit status, not from prose.
    if (purpose === 'BEHAVIOR_VERIFY' || purpose === 'REGRESSION_VERIFY') {
      const gate = purpose === 'BEHAVIOR_VERIFY' ? 'BEHAVIOR' : 'REGRESSION'
      try {
        await submitReceipt(taskId, {
          gate,
          operation: command,
          revision: requiredEnv('LIVE_REPAIR_STARTING_REVISION'),
          outcome: failed ? 'FAIL' : 'PASS',
          candidateId,
          operationType: 'shell_command',
          exitCode,
          runCorrelationId,
          evidenceRef: `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || ''}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
          startedAt,
          finishedAt,
          detail: output.slice(0, 2000),
        })
      } catch (receiptError) {
        // A rejected receipt means the gate has no accepted evidence, which the control
        // plane will treat as unverified. Surfaced rather than swallowed.
        return { status: 'RECEIPT_REJECTED', exitCode, output, message: receiptError instanceof Error ? receiptError.message : String(receiptError) }
      }
    }

    if (failed) return { status: 'FAILED', exitCode, output }
    return { status: 'SUCCESS', output, candidateId }
  },
})

const rollbackWorkspace = tool({
  name: 'rollbackWorkspace',
  description: 'Restores the fresh runner workspace to the recorded source checkpoint after a failed or regressing candidate patch.',
  parameters: z.object({ reason: z.string().min(1) }),
  execute: async ({ reason }) => {
    if (!checkpointSha) return { status: 'ERROR', message: 'No checkpoint exists.' }
    await emitStatus('ROLLING_BACK', 'Rolling back the unverified candidate repair.', null, reason)
    execSync(`git reset --hard ${checkpointSha}`, { cwd: workspaceDir, encoding: 'utf-8', stdio: 'pipe' })
    const dirty = execSync('git status --porcelain', { cwd: workspaceDir, encoding: 'utf-8' }).trim()
    if (dirty) return { status: 'ERROR', message: `Rollback left a dirty workspace: ${dirty}` }
    // The candidate no longer exists once its changes are reverted; receipts bound to it
    // must not appear to describe whatever is built next.
    candidateId = null
    mutationRationales.length = 0
    return { status: 'SUCCESS', checkpointSha }
  },
})

const completeRepair = tool({
  name: 'completeRepair',
  description: 'Writes the only allowed terminal repair result after evidence gates are evaluated.',
  parameters: z.object({
    status: z.enum(['REPAIR_VERIFIED', 'REPAIR_FAILED', 'HUMAN_CONFIRMATION_REQUIRED']),
    diagnosis: z.string(),
    changedFiles: z.array(z.string()),
    verification: z.array(z.object({ gate: z.string(), status: z.enum(['PASS', 'FAIL', 'UNAVAILABLE']), evidence: z.string() })),
    rollback: z.object({ needed: z.boolean(), completed: z.boolean() }),
    failureCode: z.string().nullable(),
    humanConfirmationReason: z.string().nullable(),
  }),
  execute: async (input) => {
    const actualChangedFiles = listChangedFiles()
    const expected = [...input.changedFiles].sort()
    const actual = [...actualChangedFiles].sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      return { status: 'ERROR', message: `Reported changed files do not match Git state. Actual: ${actual.join(', ') || '(none)'}` }
    }
    if (input.status === 'REPAIR_VERIFIED') {
      if (currentState !== 'REGRESSION_VERIFY') return { status: 'ERROR', message: `Verified repair cannot complete from ${currentState}.` }
      if (!input.verification.length || input.verification.some((entry) => entry.status !== 'PASS')) return { status: 'ERROR', message: 'REPAIR_VERIFIED requires every reported verification gate to PASS.' }
      await emitStatus('SUCCEEDED', 'Repair verified.')
    } else if (input.status === 'HUMAN_CONFIRMATION_REQUIRED') {
      if (!['LOCATING_SOURCE', 'BEHAVIOR_VERIFY'].includes(currentState)) return { status: 'ERROR', message: `Human confirmation cannot be requested from ${currentState}.` }
      if (!input.humanConfirmationReason) return { status: 'ERROR', message: 'Human confirmation reason is required.' }
      await emitStatus('HUMAN_CONFIRMATION_REQUIRED', 'Human confirmation is required before the candidate repair can be applied.', null, input.humanConfirmationReason)
    } else {
      if (input.rollback.needed && !input.rollback.completed) return { status: 'ERROR', message: 'A required rollback must be completed before REPAIR_FAILED.' }
      if (currentState !== 'FAILED') await emitStatus('FAILED', 'Repair was not verified.', null, input.failureCode)
    }

    const result: FinalResult = {
      schemaVersion: '1.0', taskId, status: input.status,
      repository: requiredEnv('GITHUB_REPOSITORY'), startingRevision: requiredEnv('LIVE_REPAIR_STARTING_REVISION'), finalRevision: null,
      diagnosis: input.diagnosis || diagnosis, changedFiles: actualChangedFiles, verification: input.verification,
      rollback: input.rollback, failureCode: input.failureCode, humanConfirmationReason: input.humanConfirmationReason,
    }
    await persistFinalResult(result)
    return { status: 'SUCCESS', result }
  },
})

// Fail fast and unambiguously on a runtime-key mismatch.
const ping = await pingControlPlane()
console.log(`Control plane reachable and authenticated. Policy ${ping.policyVersion ?? 'unknown'}.`)

const task = await loadTask()

// The protected surface and this task's authoritative class come from the control plane.
// Fetching rather than embedding keeps one definition of what is protected, and the class
// is whatever the stored task says — the runner cannot promote itself.
protectionSurface = await fetchProtectionSurface(taskId)
console.log(`Enforcement policy ${protectionSurface.policyVersion}: ${protectionSurface.protectedPaths.length} protected paths, task class ${protectionSurface.taskClass}.`)

const agent = new Agent({
  name: 'DropshipLiveRepairAgent',
  instructions: `
You are DropshipLiveRepairAgent. Execute exactly one immutable repair task against the exact checked-out repository revision.

ABSOLUTE EXECUTION RULES:
- Never simulate execution, build success, browser interaction, Git state, logs, deployment state, root cause, or verification.
- Never infer a technical cause from the user's symptom. Establish the active source mechanism first.
- Never guess paths, environment values, dependency versions, active route implementations, or runtime state. Use repository tools.
- The checked-out repository is source truth. Live browser evidence is reproduction evidence, not permission to invent source.
- Do not perform repository-wide cleanup, unrelated refactors, dependency churn, test weakening, error suppression, fake data, environment-specific hacks, or opportunistic improvements.
- Read active imports and styles before patching. A search result is not proof that a file is active.
- Create a source checkpoint before any mutation.
- Prefer the smallest exact patch. patchCodeDiff must be used for source mutation.
- Run repository-defined verification commands only after discovering them from source.
- A build pass, test pass, HTTP 200, page load, or absence of errors does not by itself prove the user's requested behavior.
- Visual repairs require actual behavioral/visual proof. If the runner cannot independently reproduce the post-change visual condition, use HUMAN_CONFIRMATION_REQUIRED rather than claiming it is fixed.
- If a candidate introduces a regression or fails required gates, roll it back before another strategy.
- Never push or merge. Git finalization is performed outside the agent after terminal evidence is recorded.
- completeRepair is mandatory. REPAIR_VERIFIED is permitted only when every required verification gate is PASS.

ORDERED REPAIR PROTOCOL:
1. Inspect the immutable task and live evidence.
2. Discover and trace the active source implementation.
3. Establish/reproduce the reported condition from available evidence.
4. Establish a falsifiable, source-backed diagnosis and call recordDiagnosis.
5. Call createSourceCheckpoint.
6. Apply the minimum surgical patch with patchCodeDiff.
7. Run applicable static checks, tests, and build commands using runLiveCommand in source-established order.
8. Verify the exact requested behavior. For unavailable visual proof, do not self-certify; use HUMAN_CONFIRMATION_REQUIRED.
9. Run proportional adjacent regression checks.
10. Call completeRepair exactly once with changed files matching actual Git state.
`,
  tools: [scanDirectoryTree, readTargetFile, recordDiagnosis, createSourceCheckpoint, patchCodeDiff, runLiveCommand, rollbackWorkspace, completeRepair],
})

const objective = `Execute this repair task exactly as submitted:\n${JSON.stringify(task, null, 2)}`

try {
  await run(agent, objective)
  if (!terminalResult) {
    const actualChangedFiles = listChangedFiles()
    const fallback: FinalResult = {
      schemaVersion: '1.0', taskId, status: 'REPAIR_FAILED', repository: requiredEnv('GITHUB_REPOSITORY'),
      startingRevision: requiredEnv('LIVE_REPAIR_STARTING_REVISION'), finalRevision: null,
      diagnosis: diagnosis || 'No terminal source-backed diagnosis was recorded.', changedFiles: actualChangedFiles,
      verification: [], rollback: { needed: actualChangedFiles.length > 0, completed: false },
      failureCode: 'BEHAVIOR_NOT_FIXED', humanConfirmationReason: null,
    }
    if (currentState !== 'FAILED') await emitStatus('FAILED', 'Agent execution ended without a terminal repair result.')
    await persistFinalResult(fallback)
  }
  console.log('Live repair execution completed with terminal status:', terminalResult?.status)
  if (terminalResult?.status === 'REPAIR_FAILED') process.exitCode = 1
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const changedFiles = listChangedFiles()
  if (checkpointSha && changedFiles.length) {
    execSync(`git reset --hard ${checkpointSha}`, { cwd: workspaceDir, encoding: 'utf-8', stdio: 'pipe' })
  }
  const fallback: FinalResult = {
    schemaVersion: '1.0', taskId, status: 'REPAIR_FAILED', repository: process.env.GITHUB_REPOSITORY || '',
    startingRevision: process.env.LIVE_REPAIR_STARTING_REVISION || '', finalRevision: null,
    diagnosis: diagnosis || 'Repair execution failed before a complete diagnosis was established.', changedFiles: [], verification: [],
    rollback: { needed: changedFiles.length > 0, completed: checkpointSha ? listChangedFiles().length === 0 : changedFiles.length === 0 },
    failureCode: 'BEHAVIOR_NOT_FIXED', humanConfirmationReason: null,
  }
  try {
    if (currentState !== 'FAILED' && stateTransitions[currentState].includes('FAILED')) await emitStatus('FAILED', 'Repair execution failed.', null, message)
    await persistFinalResult(fallback)
  } catch (persistenceError) {
    console.error('Unable to persist repair failure state:', persistenceError instanceof Error ? persistenceError.message : String(persistenceError))
  }
  console.error('Live repair execution failed:', message)
  process.exitCode = 1
}
