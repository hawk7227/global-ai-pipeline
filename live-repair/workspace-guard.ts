// live-repair/workspace-guard.ts
//
// Pre-write protection at the runner's real mutation boundary, plus candidate identity.
//
// The policy is NOT duplicated here. The protected-path list and the task's authoritative
// class are fetched from the control plane (see control-plane.ts) and passed in, so there
// is one definition of what is protected. This file supplies only the mechanism: resolve
// the real path, compare, refuse before anything reaches disk.
//
// The application independently re-evaluates the finished candidate, so a runner that
// somehow skipped this check would still be caught — but by then the working tree has
// already changed, which is why the pre-write check has to exist here too.

import { realpathSync, existsSync, lstatSync, readFileSync, readlinkSync } from 'fs'
import { resolve, relative, sep } from 'path'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import type { ProtectionSurface } from './control-plane'

export type GuardResult = {
  allowed: boolean
  canonicalPath: string | null
  reason: string | null
  matchedRule: string | null
}

/**
 * Resolves a path to workspace-relative canonical form, following symlinks.
 *
 * Returns null when the result escapes the workspace. Non-existent paths resolve through
 * their nearest existing ancestor so a new file inside a symlinked directory cannot evade
 * the comparison.
 */
export function canonicalWorkspacePath(inputPath: string, workspaceDir: string): string | null {
  const root = realpathSync(resolve(workspaceDir))
  const absolute = resolve(root, inputPath.replace(/\\/g, '/'))

  let resolved = absolute
  if (existsSync(absolute)) {
    try { resolved = realpathSync(absolute) } catch { resolved = absolute }
  } else {
    let ancestor = absolute
    const trailing: string[] = []
    while (ancestor !== resolve(ancestor, '..') && !existsSync(ancestor)) {
      trailing.unshift(ancestor.split(sep).pop() as string)
      ancestor = resolve(ancestor, '..')
    }
    try { resolved = resolve(realpathSync(ancestor), ...trailing) } catch { resolved = absolute }
  }

  const rel = relative(root, resolved)
  if (rel.startsWith('..') || resolve(root, rel) !== resolved) return null
  return rel.split(sep).join('/')
}

/** Checks one target path against the fetched protected surface. */
export function guardWorkspaceWrite(input: {
  targetPath: string
  workspaceDir: string
  surface: ProtectionSurface
}): GuardResult {
  const canonical = canonicalWorkspacePath(input.targetPath, input.workspaceDir)
  if (canonical === null) {
    return { allowed: false, canonicalPath: null, reason: 'The resolved path escapes the workspace.', matchedRule: null }
  }

  for (const entry of input.surface.protectedPaths) {
    const rule = entry.path.replace(/^\.\//, '').replace(/^\/+/, '')
    const matches = rule.endsWith('/')
      ? canonical === rule.slice(0, -1) || canonical.startsWith(rule)
      : canonical === rule

    if (!matches) continue
    if (input.surface.taskClass === 'CONTROL_PLANE_MAINTENANCE') {
      return { allowed: true, canonicalPath: canonical, reason: null, matchedRule: rule }
    }
    return {
      allowed: false,
      canonicalPath: canonical,
      reason: `${canonical} is part of the Live Repair Enforcement Protection Surface (${entry.area}). An ordinary repair may not modify the controls that govern it.`,
      matchedRule: rule,
    }
  }

  return { allowed: true, canonicalPath: canonical, reason: null, matchedRule: null }
}

/**
 * Commands capable of writing source outside the guarded patch tool.
 *
 * A guarded patchCodeDiff combined with an unrestricted `sed -i` is not protection. The
 * existing runner already blocks pushes, network tools and secret inspection; this adds
 * the in-place editors and file movers it did not cover.
 */
const MUTATING_COMMAND_PATTERNS = [
  /\bsed\b[^|]*-i/, /\bperl\b[^|]*-p?i/, /\btee\b/, /\bdd\b/, /\bpatch\b/, /\bln\b/, /\btruncate\b/,
  /\b(mv|cp|install|shred)\b/, /\brm\b/, /\bgit\s+(checkout|restore|apply|rm|mv|clean|reset)\b/,
  />>?\s*\S/,
]

export function commandCanMutateSource(command: string): { capable: boolean; matched: string | null } {
  for (const pattern of MUTATING_COMMAND_PATTERNS) {
    const match = pattern.exec(command)
    if (match) return { capable: true, matched: match[0].trim() }
  }
  return { capable: false, matched: null }
}

/**
 * Identity of the repaired candidate.
 *
 * Derived from the actual content of the candidate, so it changes whenever the meaningful
 * candidate changes and stays stable when it does not. Verification receipts bind to this
 * value, which is what stops a PASS from one candidate satisfying another.
 *
 * Untracked files are hashed by CONTENT, not by name. The earlier version hashed the
 * tracked diff plus the untracked *filename list*, so two candidates that both created
 * `new-file.ts` with different contents produced the same identity — which would have let
 * a receipt earned by one candidate satisfy the other. The list told us a file existed; it
 * did not tell us what was in it.
 *
 * Determinism matters as much as coverage: this function is run by cloud-agent.ts when the
 * candidate is built and again by finalize.ts immediately before release, and the two must
 * agree. Paths are normalized to forward slashes and sorted by byte order, digests are
 * lowercase hex, and directories/symlinks are skipped rather than read.
 */
export function computeCandidateId(workspaceDir: string, checkpointSha: string): string {
  return createHash('sha256').update(candidateFingerprintInput(workspaceDir, checkpointSha)).digest('hex').slice(0, 40).replace(/^/, 'cand:')
}

/**
 * The exact bytes that candidate identity is computed over. Kept separate so both the
 * runner and any diagnostic can reproduce the input rather than only the digest.
 */
export function candidateFingerprintInput(workspaceDir: string, checkpointSha: string): string {
  const diff = execSync(`git diff ${checkpointSha} --patch --no-color`, {
    cwd: workspaceDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  })

  // -z gives NUL-separated paths, so filenames containing spaces or newlines cannot split
  // into phantom entries.
  const untrackedRaw = execSync('git ls-files --others --exclude-standard -z', {
    cwd: workspaceDir, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024,
  })

  const untrackedEntries = untrackedRaw
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
    .sort()
    .map((relativePath) => {
      const absolute = resolve(workspaceDir, relativePath)
      let stats
      try { stats = lstatSync(absolute) } catch { return `${relativePath}\tMISSING` }
      // A symlink's target content is not the candidate's content; record the link itself.
      if (stats.isSymbolicLink()) return `${relativePath}\tSYMLINK\t${createHash('sha256').update(readlinkSync(absolute)).digest('hex')}`
      if (!stats.isFile()) return `${relativePath}\tNOT_A_FILE`
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex')
      return `${relativePath}\t${stats.size}\t${digest}`
    })

  return [
    `checkpoint:${checkpointSha}`,
    'tracked-diff:',
    diff,
    'untracked:',
    ...untrackedEntries,
  ].join('\n')
}

/** The candidate diff, for the integrity layer's suppression and substitution scanning. */
export function candidateDiff(workspaceDir: string, checkpointSha: string): string {
  return execSync(`git diff ${checkpointSha} --patch --no-color`, {
    cwd: workspaceDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  })
}

/** Changed files including untracked additions, normalized and sorted for comparison. */
export function candidateChangedFiles(workspaceDir: string): string[] {
  const output = execSync('git status --porcelain -z', {
    cwd: workspaceDir, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024,
  })
  return output
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.slice(3).trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .sort()
}
