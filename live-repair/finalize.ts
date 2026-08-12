import { execSync } from 'child_process'
import { readFileSync } from 'fs'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const taskId = required('LIVE_REPAIR_TASK_ID')
const resultPath = required('LIVE_REPAIR_RESULT_PATH')
const appDataUrl = required('APP_DATA_URL').replace(/\/$/, '')
const appDataServiceKey = required('APP_DATA_SERVICE_KEY')
const repository = required('GITHUB_REPOSITORY')
const githubToken = required('GITHUB_TOKEN')
const workspace = required('GITHUB_WORKSPACE')

const result = JSON.parse(readFileSync(resultPath, 'utf-8')) as {
  status: 'REPAIR_VERIFIED' | 'REPAIR_FAILED' | 'HUMAN_CONFIRMATION_REQUIRED'
  diagnosis: string
  changedFiles: string[]
  verification: Array<{ gate: string; status: string; evidence: string }>
}

async function dataPatch(values: Record<string, unknown>) {
  const response = await fetch(`${appDataUrl}/rest/v1/live_repair_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { apikey: appDataServiceKey, Authorization: `Bearer ${appDataServiceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  })
  if (!response.ok) throw new Error(`Task finalization persistence failed (${response.status}): ${await response.text()}`)
}

if (result.status === 'REPAIR_FAILED') {
  console.log('Repair failed verification; no branch or pull request will be created.')
  process.exit(0)
}

const statusOutput = execSync('git status --porcelain', { cwd: workspace, encoding: 'utf-8' }).trim()
if (!statusOutput) {
  await dataPatch({ failure_code: 'PATCH_FAILED', failure_message: 'Terminal repair result contained no source changes to finalize.' })
  throw new Error('No source changes exist to finalize.')
}

const actualFiles = statusOutput.split('\n').filter(Boolean).map((line) => line.slice(3).trim()).sort()
const reportedFiles = [...result.changedFiles].sort()
if (JSON.stringify(actualFiles) !== JSON.stringify(reportedFiles)) throw new Error('Terminal changed-file list does not match Git state during finalization.')

const branch = `repair/${taskId}`
execSync(`git checkout -b ${branch}`, { cwd: workspace, stdio: 'inherit' })
execSync('git add --all', { cwd: workspace, stdio: 'inherit' })
execSync(`git -c user.name="Live Repair Agent" -c user.email="agent@users.noreply.github.com" commit -m "fix(live-repair): ${taskId}"`, { cwd: workspace, stdio: 'inherit' })
const finalRevision = execSync('git rev-parse HEAD', { cwd: workspace, encoding: 'utf-8' }).trim()
execSync(`git push origin HEAD:${branch}`, { cwd: workspace, stdio: 'inherit' })

const [owner, repo] = repository.split('/')
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
      `Terminal status: ${result.status}`,
      '',
      'Diagnosis:',
      result.diagnosis,
      '',
      'Verification:',
      ...result.verification.map((entry) => `- ${entry.gate}: ${entry.status} — ${entry.evidence}`),
    ].join('\n'),
  }),
})
if (!prResponse.ok) throw new Error(`Pull request creation failed (${prResponse.status}): ${await prResponse.text()}`)
const pr = await prResponse.json() as { number: number; html_url: string }
await dataPatch({ repair_branch: branch, pr_number: pr.number, pr_url: pr.html_url, final_revision: finalRevision })
console.log(JSON.stringify({ taskId, branch, finalRevision, pullRequest: pr.number, pullRequestUrl: pr.html_url }))
