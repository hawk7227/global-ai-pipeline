// live-repair/control-plane.ts
//
// The runner's only route to authoritative state.
//
// Before this file, cloud-agent.ts inserted into live_repair_events and PATCHed
// live_repair_tasks directly over PostgREST with the Supabase service role, and
// finalize.ts PATCHed the task again after deciding on its own whether to release. That
// made the runner the author of its own authoritative state and the approver of its own
// release.
//
// Every function here calls the application control plane with AGENT_RUNTIME_KEY. The
// runner reports what it did; the application decides what that means. Nothing in this
// module can set current_state, final_status, or a delivery outcome directly.

export type RepairState =
  | 'RECEIVED' | 'EVIDENCE_VALIDATED' | 'REVISION_ESTABLISHED' | 'LOCATING_SOURCE' | 'DEFECT_REPRODUCED'
  | 'DIAGNOSED' | 'CHECKPOINT_CREATED' | 'PATCHING' | 'STATIC_CHECK' | 'TESTING' | 'BUILDING'
  | 'BEHAVIOR_VERIFY' | 'REGRESSION_VERIFY' | 'ROLLING_BACK' | 'HUMAN_CONFIRMATION_REQUIRED' | 'SUCCEEDED' | 'FAILED'

export type ProtectionSurface = {
  taskId: string
  taskClass: 'ORDINARY_REPAIR' | 'CONTROL_PLANE_MAINTENANCE'
  policyVersion: string
  protectedPaths: Array<{ path: string; area: string }>
}

export type ReleaseAuthorization = {
  taskId: string
  authorized: boolean
  repairState: string
  finalStatus: string | null
  deliveryState: string
  deliveryDetail: string | null
  reason: string
  /** Candidate the control plane adjudicated. The tree must still contain exactly this. */
  candidateId: string | null
  startingRevision: string
  canonicalChangedFiles: string[]
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const appBaseUrl = () => requiredEnv('LIVE_REPAIR_APP_URL').replace(/\/$/, '')
const runtimeKey = () => requiredEnv('AGENT_RUNTIME_KEY')

async function controlPlane<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${appBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${runtimeKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await response.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }

  if (!response.ok) {
    const detail = (parsed as { error?: string })?.error ?? text
    throw new ControlPlaneError(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${detail}`, response.status, parsed)
  }
  return parsed as T
}

export class ControlPlaneError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
    this.body = body
  }
}

/**
 * Authenticated connectivity check. Run before anything else so a runtime-key mismatch is
 * reported as exactly that, rather than surfacing later as an unexplained repair failure.
 */
export async function pingControlPlane(): Promise<{ ok: boolean; policyVersion: string | null }> {
  return controlPlane('/api/live-repair/runner-ping')
}

/**
 * Sends a conversational update to the user.
 *
 * No label is sent and none is required: the agent writes normal prose. The control plane
 * classifies material claims on its own, so nothing here can promote a claim by wording.
 * A statement that contradicts recorded evidence is refused and comes back with a reason;
 * an over-confident one is published in the language it earned. Ordinary conversation
 * passes through untouched.
 */
export async function reportNote(taskId: string, input: {
  kind: 'investigating' | 'hypothesis' | 'ruled_out' | 'finding' | 'plan' | 'action' | 'result' | 'blocked'
  message: string
  evidenceRef?: string | null
  hypothesisId?: string | null
}): Promise<{ accepted: boolean; verdict?: string; softened?: boolean; reason?: string }> {
  return controlPlane(`/api/live-repair/tasks/${encodeURIComponent(taskId)}/notes`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** Fetches the protected surface and the task's authoritative class. */
export async function fetchProtectionSurface(taskId: string): Promise<ProtectionSurface> {
  return controlPlane<ProtectionSurface>(`/api/live-repair/protection-surface?taskId=${encodeURIComponent(taskId)}`)
}

/**
 * Reports one lifecycle transition.
 *
 * The application validates it against the authoritative state machine and writes the
 * transition and its proving event atomically. A refused transition throws, so the runner
 * must not proceed as though the lifecycle advanced — which is the point: the runner no
 * longer decides what its own state is.
 */
export async function reportTransition(taskId: string, input: {
  state: RepairState
  message: string
  file?: string | null
  summary?: string | null
}): Promise<{ sequence: number; state: string; stateAdvanced: boolean }> {
  return controlPlane(`/api/live-repair/tasks/${encodeURIComponent(taskId)}/events`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * Submits a verification execution receipt.
 *
 * Required gates (BEHAVIOR, REGRESSION) are rejected by the control plane unless the
 * machine-evidence fields are present, so a PASS here has to come from a command that
 * actually ran.
 */
export async function submitReceipt(taskId: string, input: {
  gate: string
  operation: string
  revision: string
  outcome: 'PASS' | 'FAIL' | 'UNAVAILABLE'
  candidateId: string | null
  operationType: string
  exitCode: number | null
  runCorrelationId: string
  evidenceRef: string | null
  startedAt: string
  finishedAt: string
  detail?: string | null
}): Promise<{ receiptId: string | null }> {
  return controlPlane(`/api/live-repair/tasks/${encodeURIComponent(taskId)}/receipts`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * Submits the candidate result.
 *
 * The response carries the CANONICAL adjudication, which may differ from what was
 * submitted. Callers must treat `decidedStatus`, not their own status, as the outcome.
 */
export async function submitResult(taskId: string, result: unknown): Promise<{
  accepted: boolean
  claimedStatus: string
  decidedStatus: string
  downgraded: boolean
  reasons: string[]
  delivery: { state: string; detail: string }
}> {
  return controlPlane(`/api/live-repair/tasks/${encodeURIComponent(taskId)}/result`, {
    method: 'POST',
    body: JSON.stringify(result),
  })
}

/** Asks the control plane whether Git delivery is authorized. Never self-answered. */
export async function fetchReleaseAuthorization(taskId: string): Promise<ReleaseAuthorization> {
  return controlPlane<ReleaseAuthorization>(`/api/live-repair/tasks/${encodeURIComponent(taskId)}/release`)
}

/** Reports what delivery actually did, after the Git operations ran. */
export async function reportDelivery(taskId: string, input: {
  deliveryState: 'DELIVERING' | 'DELIVERED' | 'DELIVERY_FAILED'
  branch?: string | null
  prNumber?: number | null
  prUrl?: string | null
  finalRevision?: string | null
  runCorrelationId?: string | null
  detail?: string | null
}): Promise<{ accepted: boolean; taskComplete: boolean; independentlyVerified?: boolean | null }> {
  return controlPlane(`/api/live-repair/tasks/${encodeURIComponent(taskId)}/release`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
