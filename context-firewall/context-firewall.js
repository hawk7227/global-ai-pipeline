import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const INSTALL_FLAG = Symbol.for('context-firewall.openai-fetch-installed')
const DEFAULTS = {
  maxFiles: 100,
  maxFileBytes: 500000,
  maxContextChars: 60000,
  maxPromptChars: 12000,
  maxRequestTextChars: 60000,
  maxTextBlockChars: 20000,
  blockedNames: ['.git','node_modules','.next','dist','build','coverage','.cache','.env','.env.local','.env.production','.env.development'],
  blockedExtensions: ['.png','.jpg','.jpeg','.gif','.webp','.ico','.pdf','.zip','.gz','.mp3','.mp4','.mov','.avi','.woff','.woff2','.ttf','.eot'],
}

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/')
const optionsFor = (overrides = {}) => ({ ...DEFAULTS, ...overrides })
const opaqueAsset = (value) => /^data:(?:image|audio|video|application)\//i.test(value)

function redactSecrets(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]')
    .replace(/(OPENAI_API_KEY\s*=\s*)[^\s'\"]+/gi, '$1[REDACTED]')
    .replace(/(API_KEY\s*=\s*)[^\s'\"]+/gi, '$1[REDACTED]')
    .replace(/(SECRET\s*=\s*)[^\s'\"]+/gi, '$1[REDACTED]')
    .replace(/(PASSWORD\s*=\s*)[^\s'\"]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
}

function blocked(root, file, options) {
  const names = new Set(options.blockedNames)
  const extensions = new Set(options.blockedExtensions)
  return rel(root, file).split('/').some((part) => names.has(part)) || extensions.has(path.extname(file).toLowerCase())
}

function walk(root, current, options, files) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (blocked(root, full, options) || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(root, full, options, files)
    else if (entry.isFile()) files.push(full)
  }
}

function dedupable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return ('role' in value && 'content' in value) || ('type' in value && ('text' in value || 'input_text' in value)) || ('path' in value && 'hash' in value && 'content' in value)
}

function sanitize(value, state, options) {
  if (value == null) return value
  if (typeof value === 'string') {
    if (opaqueAsset(value)) return value
    const clean = redactSecrets(value)
    if (clean.length > options.maxTextBlockChars) throw new Error(`CONTEXT_FIREWALL_TEXT_BLOCK_TOO_LARGE: limit ${options.maxTextBlockChars} characters`)
    state.textChars += clean.length
    if (state.textChars > options.maxRequestTextChars) throw new Error(`CONTEXT_FIREWALL_REQUEST_TOO_LARGE: limit ${options.maxRequestTextChars} text characters`)
    return clean
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const output = []
    const seen = new Set()
    for (const item of value) {
      const clean = sanitize(item, state, options)
      if (dedupable(clean)) {
        const fingerprint = digest(JSON.stringify(clean))
        if (seen.has(fingerprint)) continue
        seen.add(fingerprint)
      }
      output.push(clean)
    }
    return output
  }
  const output = {}
  for (const [key, child] of Object.entries(value)) output[key] = sanitize(child, state, options)
  return output
}

export function buildContext(rootDir, previousManifest = {}, overrides = {}) {
  const root = path.resolve(rootDir)
  const options = optionsFor(overrides)
  const files = []
  walk(root, root, options, files)
  const manifest = {}
  const approved = []
  const seen = new Set()
  let contextChars = 0
  for (const file of files) {
    const stat = fs.statSync(file)
    if (stat.size > options.maxFileBytes) continue
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { continue }
    const filePath = rel(root, file)
    const hash = digest(raw)
    manifest[filePath] = hash
    if (previousManifest[filePath] === hash || seen.has(hash)) continue
    seen.add(hash)
    const content = redactSecrets(raw)
    contextChars += content.length
    if (approved.length >= options.maxFiles) throw new Error(`CONTEXT_FIREWALL_MAX_FILES: limit ${options.maxFiles}`)
    if (contextChars > options.maxContextChars) throw new Error(`CONTEXT_FIREWALL_MAX_CONTEXT: limit ${options.maxContextChars} characters`)
    approved.push({ path: filePath, hash, content })
  }
  return { approved, manifest, stats: { scannedFiles: files.length, approvedFiles: approved.length, contextChars } }
}

export function filterPrompt(prompt, maxChars = DEFAULTS.maxPromptChars) {
  const clean = redactSecrets(prompt ?? '')
  if (clean.length > maxChars) throw new Error(`CONTEXT_FIREWALL_PROMPT_TOO_LARGE: limit ${maxChars} characters`)
  return clean
}

export function sanitizeOpenAIRequest(payload, overrides = {}) {
  return sanitize(payload, { textChars: 0 }, optionsFor(overrides))
}

export function assertModelAllowed(model, allowedModels) {
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return model
  if (!allowedModels.includes(model)) throw new Error(`CONTEXT_FIREWALL_MODEL_BLOCKED: ${model}`)
  return model
}

export function installOpenAIFetchFirewall(overrides = {}) {
  if (globalThis[INSTALL_FLAG]) return
  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') throw new Error('CONTEXT_FIREWALL_FETCH_UNAVAILABLE')
  const allowedHosts = new Set(Array.isArray(overrides.hosts) ? overrides.hosts : ['api.openai.com'])
  globalThis.fetch = async (input, init) => {
    const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || ''
    let hostname
    try { hostname = new URL(requestUrl).hostname } catch { return originalFetch(input, init) }
    if (!allowedHosts.has(hostname) || !init || typeof init.body !== 'string') return originalFetch(input, init)
    const trimmed = init.body.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return originalFetch(input, init)
    let parsed
    try { parsed = JSON.parse(init.body) } catch { return originalFetch(input, init) }
    return originalFetch(input, { ...init, body: JSON.stringify(sanitizeOpenAIRequest(parsed, overrides)) })
  }
  globalThis[INSTALL_FLAG] = true
}
