import { Agent, run, tool } from '@openai/agents';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { z } from 'zod';

const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();

// COST CONTAINMENT TRACKER (Domain 6)
interface BudgetTracker {
  initialGenerationTokens: number;
  repairTokens: number;
  qualityRetries: number;
  maxAttempts: number;
}
const activeBudget: BudgetTracker = {
  initialGenerationTokens: 0,
  repairTokens: 0,
  qualityRetries: 0,
  maxAttempts: 5
};

// TOOL 1: Native Cloud Command execution
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

// TOOL 2: Surgical Diff Matcher (Aider/Cline Equivalent)
const patchCodeDiff = tool({
  name: 'patchCodeDiff',
  description: 'Performs precise surgical search-and-replace block patches inside a workspace file.',
  parameters: z.object({
    relativePath: z.string().describe('The relative file path from workspace root'),
    searchBlock: z.string().describe('The exact code segment currently in the file that needs to be replaced'),
    replaceBlock: z.string().describe('The updated code block to put in place of the search block')
  }),
  execute: async ({ relativePath, searchBlock, replaceBlock }) => {
    try {
      const targetPath = resolve(workspaceDir, relativePath);
      const originalContent = readFileSync(targetPath, 'utf-8');
      
      if (!originalContent.includes(searchBlock)) {
        return { status: 'ERROR', message: `Search block not found inside ${relativePath}.` };
      }
      
      const updatedContent = originalContent.replace(searchBlock, replaceBlock);
      writeFileSync(targetPath, updatedContent, 'utf-8');
      return { status: 'SUCCESS', message: `Surgically patched ${relativePath} successfully.` };
    } catch (error: any) {
      return { status: 'ERROR', message: error.message };
    }
  }
});

// TOOL 3: Complete Repository Tree Indexer (Cursor/Windsurf Equivalent)
const scanDirectoryTree = tool({
  name: 'scanDirectoryTree',
  description: 'Returns a mapped directory list of files in the current repository workspace to locate structural entities.',
  parameters: z.object({}),
  execute: async () => {
    try {
      const walk = (dir: string, fileList: string[] = []): string[] => {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file === 'node_modules' || file === '.git' || file === '.vercel' || file === '.next') continue;
          const name = join(dir, file);
          if (statSync(name).isDirectory()) {
            walk(name, fileList);
          } else {
            fileList.push(name.replace(workspaceDir + '/', ''));
          }
        }
        return fileList;
      };
      return { status: 'SUCCESS', files: walk(workspaceDir) };
    } catch (error: any) {
      return { status: 'ERROR', message: error.message };
    }
  }
});

// TOOL 4: Precision Target Reader
const readTargetFile = tool({
  name: 'readTargetFile',
  description: 'Reads the complete file contents of a small config, script, or log file to analyze codebase state.',
  parameters: z.object({
    relativePath: z.string().describe('The relative file path to read')
  }),
  execute: async ({ relativePath }) => {
    try {
      const targetPath = resolve(workspaceDir, relativePath);
      const content = readFileSync(targetPath, 'utf-8');
      return { status: 'SUCCESS', content };
    } catch (error: any) {
      return { status: 'ERROR', message: error.message };
    }
  }
});

// TOOL 5: Safety Checkpoint Generator (Domain 20)
const createSourceCheckpoint = tool({
  name: 'createSourceCheckpoint',
  description: 'Creates a snapshot state of the codebase before automated repair tools mutate source configurations.',
  parameters: z.object({
    checkpointMessage: z.string().describe('Descriptive label for the file checkpoint state')
  }),
  execute: async ({ checkpointMessage }) => {
    try {
      execSync('git stash save "AI_CHECKPOINT: ' + checkpointMessage + '"', { cwd: workspaceDir });
      execSync('git stash apply', { cwd: workspaceDir });
      return { status: 'SUCCESS', message: `Checkpoint saved: ${checkpointMessage}` };
    } catch (error: any) {
      return { status: 'ERROR', message: error.message };
    }
  }
});

const agent = new Agent({
  name: 'PremiumPipelineRoutingAgent',
  instructions: `
    You are running inside a live GitHub Actions CI container executing live commands.
    Your objective is to map out the repository layout, discover the runtime stack, and execute the full ordered lifecycle validation.
    
    [EXECUTION MODE: DETERMINISTIC ENGINE]
    - You are a non-generative, literal execution engine. Never simulate execution paths or pretend a build succeeded.
    - Never guess environment states, file structures, or dependency parameters. If unknown, utilize workspace tools.
    - Validate every code snippet for syntax errors and confirm every logic loop closes before patching.
    
    AIDER/CLINE SURGICAL PATCH PROTOCOL:
    - You must prefer 'patchCodeDiff' over overwriting entire code files. Provide exact matching 'searchBlock' contents down to the spaces.
    
    NON-NEGOTIABLE PRODUCT INVARIANTS:
    1. EXPLICIT ANTI-IFRAME PASS: You must never allow raw AI-generated frontend code to expose itself directly to a user preview via 'AI -> iframe' or 'AI -> srcDoc -> user'. The lifecycle must pass through source validation, compile checks, and browser verification gates.
    2. ZERO MOCK POLICIES: You are strictly forbidden from leaving or generating mock data models, placeholder objects, or 'MOCK_*' prefixes. All data models must bind to active databases or real snapshot collection schemas.
    3. TOTAL WIRE COMPLIANCE: Every single UI component, tab, action item, or button must have explicit navigation or state-event handler wiring. Dead links, hash anchors (href: '#'), and empty onClick parameters are treated as critical pipeline compilation crashes.
    
    DOMAIN 8 - STATIC SOURCE VALIDATION INVARIANTS:
    - MANDATORY ROUTINE DISCOVERY: The 'source-validator.ts' file must invoke structural AST, CSS, dangerous-code, and component-policy checks simultaneously.
    - AST ENGINE CHECKS: Reject fixed page canvas definitions (e.g., width: 1200), absolute page shell positioning, or layout-critical margin-left offsets (e.g., marginLeft: 250) inside TSX/JSX trees.
    - FLAT TEMPLATE BLOCK: Reject fallback generation of giant standalone HTML documents if the current project workspace requires React/TSX components ('FLAT_TEMPLATE_OUTPUT_REJECTED').
    
    DOMAIN 13 & 15 - DOM GEOMETRY & VIEWPORT ERGONOMICS:
    - REPRESENTATIVE VIEWPORT MATRIX: You must enforce browser proof evaluations across all 11 explicit viewport thresholds: 320, 375, 390, 430, 768, 820, 1024, 1280, 1440, 1920, and 2560 pixels.
    - LAYOUT ERROR INTERCEPTION: Treat horizontal document page overflow, offscreen critical controls, clipped text containers, overlapping primary headers, and unreachable navigation as fatal build failures.
    - KEYBOARD VIEWPORT REDUCTION: Test generated forms under simulated keyboard/focus viewport reduction. Verify focusable inputs stay completely visible and submit controls aren't irrecoverably covered up.
    
    DOMAIN 16 & 17 - ACCESSIBILITY & VISUAL POLISH:
    - AUDIT ACCESSIBILITY: Validate accessible names, input labels, focusability parameters, heading structures, semantic buttons, and mobile touch-target viability.
    - VISUAL HIERARCHY EVALUATION: Verify spacing consistency, typography balance, card proportions, section rhythm, desktop whitespace margins, and mobile design density layout constraints.
    
    RUNNER POLICY SAFETY OPERATIONS:
    - DECOUPLED PRIVATE PREVIEWS: Never call external HTTP HTTP API routes for candidate evaluation. Use local backend functions to generate private preview records with 'visibility = private', 'qualityStatus = pending', and 'publishable = false'.
    - ATOMIC ROLLBACKS: If an applied code fix causes brand-new regression errors in adjacent modules, instantly restore the file to its original git state before applying a different structural logic strategy.
    - EMERGENCY LOOPS: If a single test script fails consistently over 5 consecutive adjustment loops without reducing the error log volume, trigger an intentional hard process exit with code 1 to alert the user.
    - FIXED BUDGET GOVERNANCE: Monitor token structures, repair limits, and total execution attempts. If constraints cross threshold boundaries, exit immediately with 'BUDGET_EXHAUSTED'.
  `,
  tools: [runLiveCommand, patchCodeDiff, scanDirectoryTree, readTargetFile, createSourceCheckpoint]
});

async function runLivePipeline() {
  activeBudget.qualityRetries++;
  if (activeBudget.qualityRetries > activeBudget.maxAttempts) {
    console.error("❌ ERROR: Pipeline terminated due to BUDGET_EXHAUSTED constraint limits.");
    process.exit(1);
  }
  
  const objective = "Execute comprehensive StreamSAI 27-domain pipeline validation lifecycle. Scan repo structure, establish source truth, create file checkpoints, test layout geometries, execute full accessibility/viewport matrices, repair anomalies, and await publication gate approval indicators.";
  const result = await run(agent, objective);
  console.log("Pipeline Process Finished: ", result.finalOutput);
}

runLivePipeline();
