import { Agent, run, tool } from '@openai/agents';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod'; // Added for proper type parameter validation

const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();

const runLiveCommand = tool({
  name: 'runLiveCommand',
  description: 'Executes build/test processes natively on the live Ubuntu GitHub Action runner.',
  parameters: z.object({
    command: z.string().describe('The exact shell command to run')
  }),
  execute: async ({ command }) => {
    try {
      const output = execSync(command, { cwd: workspaceDir, encoding: 'utf-8', stdio: 'pipe' });
      return { status: 'SUCCESS', output };
    } catch (error: any) {
      return { status: 'FAILED', output: error.stdout || error.stderr || error.message };
    }
  }
});

const patchCloudFile = tool({
  name: 'patchCloudFile',
  description: 'Modifies application code or configuration blocks directly on the remote branch workspace.',
  parameters: z.object({
    relativePath: z.string().describe('The relative file path from workspace root'),
    content: z.string().describe('The full text content to write to the file')
  }),
  execute: async ({ relativePath, content }) => {
    try {
      const targetPath = resolve(workspaceDir, relativePath);
      writeFileSync(targetPath, content, 'utf-8');
      return { status: 'SUCCESS', message: `Patched ${relativePath}` };
    } catch (error: any) {
      return { status: 'ERROR', message: error.message };
    }
  }
});

const agent = new Agent({
  name: 'LivePipelineRoutingAgent',
       instructions: `
    You are running inside a live GitHub Actions CI container executing live commands.
    Your objective is to look at the workspace environment files, discover the runtime stack, and execute the relevant test/build checks.
    
    [EXECUTION MODE: DETERMINISTIC ENGINE]
    - You are a non-generative, literal execution engine.
    - You must never pretend to execute a command or simulate a build success.
    - You must never guess missing environment variables, system paths, or dependency versions.
    - Validate every code snippet for syntax errors and confirm every logic loop closes before saving.
    - Match user code line-for-line without summarizing.
    
    STRICT INTEGRATION PROTOCOLS:
    1. ZERO MOCK POLICIES: You are strictly forbidden from leaving or generating mock data models, placeholder objects, or 'MOCK_*' prefixes. All data models must bind to active databases or real snapshot collection schemas.
    2. TOTAL WIRE COMPLIANCE: Every single UI component, tab, action item, or button must have explicit navigation or state-event handler wiring. Dead links, hash anchors (href: '#'), and empty onClick parameters are treated as critical pipeline compilation crashes.
    3. END-TO-END VERIFICATION: If you encounter partial mock implementations, immediately use your patch tools to replace them with live functional logic.
    4. Loop autonomously until your test or build matrix reports 100% full runtime functionality and zero mock items remain.
    
    RUNNER POLICY SAFETY OPERATIONS:
    - RUNTIME ISOLATION: If a command log outputs a missing execution binary or missing platform SDK, invoke the appropriate global setup command (e.g., 'pnpm exec playwright install') before touching source files.
    - ATOMIC ROLLBACKS: If an applied code fix causes brand-new regression errors in adjacent modules, instantly restore the file to its original git state before applying a different structural logic strategy.
    - EMERGENCY LOOPS: If a single test script fails consistently over 5 consecutive adjustment loops without reducing the error log volume, trigger an intentional hard process exit with code 1 to alert the user.

    GLOBAL ENVIRONMENT ADAPTATION:
    - STACK AUTO-DISCOVERY: Check workspace manifest files to detect the ecosystem. Automatically translate execution commands (e.g., run 'pytest' for Python repositories containing requirements.txt, or 'cargo test' for Rust codebases containing Cargo.toml).
    - MIGRATION COMPLIANCE: If a runtime crash trace identifies a missing database schema element, execute the stack's native database migration command rather than patching entity classes manually.
    - SECRET SANITIZATION: Never write raw credentials, private authorization tokens, or explicit security strings into any patched file. Use ecosystem environment variable hooks (e.g., process.env or os.environ) exclusively.
  `,



  tools: [runLiveCommand, patchCloudFile]
});

async function runLivePipeline() {
  const objective = "Run tests, fix failures, and auto-commit the passing resolution back to the origin branch.";
  const result = await run(agent, objective);
  console.log("Pipeline Finished: ", result.finalOutput);
}

runLivePipeline();
