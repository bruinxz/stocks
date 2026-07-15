#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const FINGERPRINT_SOURCES = [
  'backend/src/security/leakedSecretFingerprints.ts',
];
const EXCLUDED_PREFIXES = [
  '.git/',
  'backend/dist/',
  'backend/logs/',
  'backend/node_modules/',
  'frontend/build/',
  'frontend/node_modules/',
  'logs/',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function loadLeakFingerprints() {
  const fingerprints = new Set();
  for (const relativePath of FINGERPRINT_SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    for (const match of source.matchAll(/['"]([a-f0-9]{64})['"]/g)) {
      fingerprints.add(match[1]);
    }
  }
  if (fingerprints.size < 4) {
    throw new Error('leaked-secret fingerprint registry is missing or incomplete');
  }
  return fingerprints;
}

function listCandidateFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return [...new Set(output.split('\0').filter(Boolean))]
    .filter(file => !EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix)))
    .sort();
}

function addFinding(findings, file, text, offset, rule) {
  findings.push({ file, line: lineNumber(text, offset), rule });
}

function scanFile(file, fingerprints, findings) {
  const absolutePath = path.join(ROOT, file);
  let bytes;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');

  const tokenPattern = /[A-Za-z0-9_!@#$%^&*()+={}\[\]:;,.?/~\\-]{8,192}/g;
  for (const match of text.matchAll(tokenPattern)) {
    if (fingerprints.has(sha256(match[0]))) {
      addFinding(findings, file, text, match.index, 'known-leaked-secret-fingerprint');
    }
  }

  // Test suites intentionally exercise DSN parsing with synthetic credentials.
  // Known leaked values are still caught by the fingerprint scan above, while
  // generic embedded credentials remain forbidden everywhere else.
  if (!/(^|\/)tests?\//.test(file)) {
    for (const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s:/@]+:[^\s/@]+@/gi)) {
      addFinding(findings, file, text, match.index, 'credential-in-database-url');
    }
  }

  const rules = [
    {
      id: 'private-key-material',
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    },
    {
      id: 'weak-credential-assignment',
      skipTests: true,
      pattern:
        /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"](?:666|password|postgres|admin|changeme|change-me)['"]/gi,
    },
  ];

  for (const rule of rules) {
    if (rule.skipTests && /(^|\/)tests?\//.test(file)) continue;
    for (const match of text.matchAll(rule.pattern)) {
      addFinding(findings, file, text, match.index, rule.id);
    }
  }
}

function main() {
  const fingerprints = loadLeakFingerprints();
  const findings = [];
  for (const file of listCandidateFiles()) {
    scanFile(file, fingerprints, findings);
  }

  if (findings.length > 0) {
    console.error(`[secret-lint] blocked ${findings.length} finding(s); values are intentionally redacted`);
    for (const finding of findings.slice(0, 200)) {
      console.error(`  ${finding.file}:${finding.line} ${finding.rule}`);
    }
    if (findings.length > 200) {
      console.error(`  ... ${findings.length - 200} additional finding(s)`);
    }
    process.exit(1);
  }

  console.log(
    `[secret-lint] PASS (${fingerprints.size} blocked fingerprints; tracked and untracked source scanned)`
  );
}

try {
  main();
} catch (error) {
  console.error(`[secret-lint] scanner failed closed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(2);
}
