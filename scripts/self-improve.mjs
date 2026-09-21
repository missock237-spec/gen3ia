#!/usr/bin/env node
/**
 * Automated Quality Audit Script for gen3ia
 * Scans repository quality: lint, typecheck, tests, TODO/FIXME debt, and package health.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function runCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return (err.stdout || '') + '\n' + (err.stderr || '');
  }
}

function countOccurrences(dir, pattern) {
  let count = 0;
  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(js|ts|jsx|tsx|md|mjs)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const matches = content.match(pattern);
          if (matches) count += matches.length;
        } catch (e) {}
      }
    }
  }
  walk(dir);
  return count;
}

console.log('🔍 Starting Quality Audit...');

// 1. Lint
const lintOut = runCmd('npm run lint');
const lintErrorMatches = lintOut.match(/error/gi) || [];
const lintWarnMatches = lintOut.match(/warning/gi) || [];
const lintIssues = lintErrorMatches.length + lintWarnMatches.length;

// 2. Typecheck
const tscOut = runCmd('npx tsc --noEmit');
const tscErrorMatches = tscOut.match(/error TS\d+/gi) || [];
const tscErrors = tscErrorMatches.length;

// 3. Tests
const testOut = runCmd('npm test -- --run');
const testFailures = (testOut.match(/failed/gi) || []).length > 0 ? 1 : 0;

// 4. TODO / FIXME Debt
const todoDebt = countOccurrences('.', /TODO|FIXME/g);

// Score Calculation (base 100)
let score = 100;
score -= tscErrors * 5;
score -= lintIssues * 2;
score -= todoDebt * 1;
if (testFailures > 0) score -= 20;
if (score < 0) score = 0;

const report = `
========================================
📊 GEN3IA QUALITY AUDIT REPORT
========================================
Score: ${score}/100

• TypeScript Errors: ${tscErrors}
• ESLint Issues: ${lintIssues}
• TODO / FIXME Debt: ${todoDebt}
• Test Failures: ${testFailures}

Prioritized Next Actions:
${tscErrors > 0 ? '- [CRITICAL] Fix TypeScript compilation errors in tsc' : '- TypeScript compilation clean'}
${lintIssues > 0 ? '- [HIGH] Resolve ESLint errors and warnings' : '- ESLint clean'}
${todoDebt > 0 ? `- [MEDIUM] Resolve ${todoDebt} pending TODO/FIXME items in codebase` : '- Debt clean'}
========================================
`;

console.log(report);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ score, tscErrors, lintIssues, todoDebt, testFailures }, null, 2));
}

// Exit non-zero only on real degradation (e.g., test failures or score < 50)
if (testFailures > 0 || score < 50) {
  process.exit(1);
}
