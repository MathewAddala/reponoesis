import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rootDir = process.cwd();
const releaseDir = path.resolve(rootDir, 'release');

console.log('📦 Starting Reponoesis Release Packaging Pipeline...\n');

// 1. Build the monorepo first to ensure bundled core is fresh
console.log('⚡ Step 1: Rebuilding workspace...');
execSync('npm run build', { stdio: 'inherit' });
console.log('✅ Build successful.\n');

// 2. Prepare release directory
if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir, { recursive: true });

// Helper to run npm pack and move tarball
function packAndMove(packageDir, label) {
  const absPkgDir = path.resolve(rootDir, packageDir);
  console.log(`📦 Packaging ${label}...`);
  
  // Run npm pack inside package dir
  const output = execSync('npm pack', { cwd: absPkgDir, encoding: 'utf8' }).trim();
  const tarballName = output.split('\n').pop().trim();
  const sourcePath = path.resolve(absPkgDir, tarballName);
  const destPath = path.resolve(releaseDir, tarballName);
  
  // Move to release directory
  fs.renameSync(sourcePath, destPath);
  console.log(`   └─ Created and moved: release/${tarballName}\n`);
  return tarballName;
}

// 3. Pack packages
const cliTarball = packAndMove('packages/cli', 'CLI (rpn)');
const mcpTarball = packAndMove('packages/mcp', 'MCP Server (rpn-mcp)');

// 4. Create a clean installation guide for their friend
const readmeContent = `# 🚀 Reponoesis Early Adopter — Installation Guide

Thank you for beta-testing **Reponoesis (rpn)**! This release is packaged locally and securely to keep our proprietary semantic engine private.

---

## 🛠️ Prerequisites
- **Node.js**: Version 20.0.0 or higher
- **IDE**: Cursor or Claude Code (if using MCP server)

---

## 📦 Step 1: Installation
Open your terminal in the directory where you saved these files and run:

\`\`\`bash
# 1. Install CLI globally
npm install -g ./${cliTarball}

# 2. Install MCP Server globally
npm install -g ./${mcpTarball}
\`\`\`

*Note: Node will automatically download safe standard public dependencies (like \`better-sqlite3\` and \`simple-git\`) from the public npm registry. Our core semantic Merkle engine runs privately from the local bundle.*

Verify the installations:
\`\`\`bash
rpn --version
rpn-mcp --help
\`\`\`

---

## 🚀 Step 2: Initialize in Your Codebase
Navigate to any git repository on your laptop:

\`\`\`bash
# 1. Initialize
rpn init

# 2. Run a full scan (indexes codebases offline in SQLite)
rpn scan

# 3. Check health status
rpn status
\`\`\`

---

## 🧠 Step 3: Link Cursor or Claude Code as the AI Brain (Zero LLM Cost)
To make your AI agent automatically align configurations, document WHY changes were made, and prevent semantic drift:

1. Open **Cursor Settings** → **Models** → **MCP**.
2. Click **+ Add New MCP Server**.
3. Fill in the details:
   - **Name**: \`reponoesis\`
   - **Type**: \`command\`
   - **Command**: \`rpn-mcp\`
   - **Arguments**: \`["--project", "/absolute/path/to/your/project"]\`
4. Click **Save**.

Your AI agent now has first-class access to 7 powerful tools (\`rpn_get_context\`, \`rpn_impact_map\`, \`rpn_validate\`, etc.) to secure code limits, API versions, and schema parameters for free!
`;

fs.writeFileSync(path.resolve(releaseDir, 'README.md'), readmeContent, 'utf8');
console.log('📝 Created installation instruction guide: release/README.md\n');

console.log('🎉 Reponoesis release successfully created!');
console.log(`👉 Zip the "release" directory and send it to your friend!`);
process.exit(0);
