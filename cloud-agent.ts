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
    You are running inside a live GitHub Actions CI container.
    Your objective is to run 'pnpm test' or the requested build check.
    If it fails, read the terminal log stream, apply the code patch, commit it, and exit.
    Do not simulate execution paths.
  `,
  tools: [runLiveCommand, patchCloudFile]
});

async function runLivePipeline() {
  const objective = "Run tests, fix failures, and auto-commit the passing resolution back to the origin branch.";
  const result = await run(agent, objective);
  console.log("Pipeline Finished: ", result.finalOutput);
}

runLivePipeline();
