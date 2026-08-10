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
    Your objective is to look at the package.json scripts and run the relevant test/build checks.
    
    STRICT INTEGRATION PROTOCOLS:
    1. ZERO MOCK POLICIES: You are strictly forbidden from leaving or generating mock data models, placeholder objects, or 'MOCK_*' prefixes. All data models must bind to active databases or real snapshot collection schemas.
    2. TOTAL WIRE COMPLIANCE: Every single UI component, tab, action item, or button must have explicit navigation or state-event handler wiring. Dead links, hash anchors (href: '#'), and empty onClick parameters are treated as critical pipeline compilation crashes.
    3. END-TO-END VERIFICATION: If you encounter partial mock implementations, immediately use your patch tools to replace them with live functional logic (e.g., real API endpoints, explicit routing blocks, verified sub-nav state changes).
    4. Loop autonomously until 'pnpm test' or the build matrix reports 100% full runtime functionality and zero mock items remain.
  `,

  tools: [runLiveCommand, patchCloudFile]
});

async function runLivePipeline() {
  const objective = "Run tests, fix failures, and auto-commit the passing resolution back to the origin branch.";
  const result = await run(agent, objective);
  console.log("Pipeline Finished: ", result.finalOutput);
}

runLivePipeline();
