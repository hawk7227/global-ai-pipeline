import { Agent, run, tool } from '@openai/agents';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { z } from 'zod';

const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();

// TOOL 1: Live Container Command execution
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

// TOOL 2: Intelligent Search & Replace (Equal to Aider / Cline diff patching)
const patchCodeDiff = tool({
  name: 'patchCodeDiff',
  description: 'Performs precise surgical search-and-replace block patches inside a workspace file. Avoids overwriting the whole file.',
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
        return { status: 'ERROR', message: `Search block not found exactly as written inside ${relativePath}. Ensure indentation matches perfectly.` };
      }
      
      const updatedContent = originalContent.replace(searchBlock, replaceBlock);
      writeFileSync(targetPath, updatedContent, 'utf-8');
      return { status: 'SUCCESS', message: `Surgically patched ${relativePath} successfully.` };
    } catch (error: any) {
      return { status: 'ERROR', message: error.message };
    }
  }
});

// TOOL 3: Complete Repository File-Tree Indexer (Equal to Cursor / Windsurf directory scanning)
const scanDirectoryTree = tool({
  name: 'scanDirectoryTree',
  description: 'Returns a mapped directory list of files in the current repository workspace to locate structural entities.',
  parameters: z.object({}),
  execute: async () => {
    try {
      const walk = (dir: string, fileList: string[] = []): string[] => {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file === 'node_modules' || file === '.git' || file === '.vercel') continue;
          const name = join(dir, file);
          if (statSync(name).isDirectory()) {
            walk(name, fileList);
          } else {
            fileList.push(name.replace(workspaceDir + '/', ''));
          }
        }
        return fileList;
      };
      const files = walk(workspaceDir);
      return { status: 'SUCCESS', files };
    } catch (error: any) {
      return { status: 'ERROR', message: error.message };
    }
  }
});

// TOOL 4: Inspection tool
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

const agent = new Agent({
  name: 'LivePipelineRoutingAgent',
  instructions: `
    You are running inside a live GitHub Actions CI container executing live commands.
    Your objective is to map out the repository layout, discover the runtime stack, and execute build/test checks until completely clean.
    
    [EXECUTION MODE: DETERMINISTIC ENGINE]
    - You are a non-generative, literal execution engine. Never simulate execution paths or pretend a build succeeded.
    - Never guess environment states, file structures, or dependency parameters. If unknown, invoke 'scanDirectoryTree' or 'readTargetFile'.
    - Validate every code snippet for syntax errors and confirm every logic loop closes before patching.
    
    AIDER/CLINE SURGICAL PATCH PROTOCOL:
    - You must prefer 'patchCodeDiff' over overwriting entire code files. Provide exact matching 'searchBlock' contents down to the spaces.
    
    STRICT INTEGRATION PROTOCOLS:
    1. ZERO MOCK POLICIES: You are strictly forbidden from leaving or generating mock data models, placeholder objects, or 'MOCK_*' prefixes. All data models must bind to active databases or real snapshot collection schemas.
    2. TOTAL WIRE COMPLIANCE: Every single UI component, tab, action item, or button must have explicit navigation or state-event handler wiring. Dead links, hash anchors (href: '#'), and empty onClick parameters are treated as critical pipeline compilation crashes.
    3. END-TO-END VERIFICATION: If you encounter partial mock implementations, immediately use your patch tools to replace them with live functional logic.
    4. Loop autonomously until your test or build matrix reports 100% full runtime functionality and zero mock items remain.
    
    RUNNER POLICY SAFETY OPERATIONS:
    - RUNTIME ISOLATION: If a command log outputs a missing execution binary or missing platform SDK, invoke the appropriate global setup command before touching source files.
    - ATOMIC ROLLBACKS: If an applied code fix causes brand-new regression errors in adjacent modules, instantly restore the file to its original git state before applying a different structural logic strategy.
    - EMERGENCY LOOPS: If a single test script fails consistently over 5 consecutive adjustment loops without reducing the error log volume, trigger an intentional hard process exit with code 1 to alert the user.

    GLOBAL ENVIRONMENT ADAPTATION:
    - STACK AUTO-DISCOVERY: Check workspace manifest files via 'scanDirectoryTree' to detect the ecosystem. Automatically translate execution commands (e.g., run 'pytest' for Python repositories or 'cargo test' for Rust).
    - MIGRATION COMPLIANCE: If a runtime crash trace identifies a missing database schema element, execute the stack's native database migration command rather than patching entity classes manually.
    - SECRET SANITIZATION: Never write raw credentials, private authorization tokens, or explicit security strings into any patched file. Use environment variable hooks exclusively.
  `,
  tools: [runLiveCommand, patchCodeDiff, scanDirectoryTree, readTargetFile]
});

async function runLivePipeline() {
  const objective = "Scan repository structure, map dependencies, execute test architecture commands, repair any failure profiles or mock states, and auto-commit the passing deployment state.";
  const result = await run(agent, objective);
  console.log("Pipeline Process Finished: ", result.finalOutput);
}

runLivePipeline();

