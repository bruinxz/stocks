#!/usr/bin/env node
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out[key] = true;
    } else if (out[key] !== undefined) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = value;
    }
    i += 1;
  }
  return out;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeMessage(message) {
  return String(message)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDiagnosticMessage(message, repoRoot) {
  const normalizedRoot = path.resolve(repoRoot).split(path.sep).join('/');
  return normalizeMessage(message).replace(
    new RegExp(escapeRegExp(normalizedRoot), 'gi'),
    '<repo>',
  );
}

function repoRelative(filePath, repoRoot, workdir) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(repoRoot, workdir || '.', filePath);
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

function makeFingerprint(kind, diagnostic) {
  return sha256Text(
    [
      kind,
      diagnostic.path,
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
    ].join('\0'),
  );
}

function groupDiagnostics(kind, diagnostics) {
  const map = new Map();
  for (const diagnostic of diagnostics) {
    const key = makeFingerprint(kind, diagnostic);
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.locations.push(...diagnostic.locations);
    } else {
      map.set(key, { fingerprint: key, ...diagnostic, count: 1 });
    }
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      locations: item.locations
        .slice()
        .sort((a, b) => a.line - b.line || a.column - b.column)
        .slice(0, 5),
    }))
    .sort((a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.severity.localeCompare(b.severity) ||
      a.message.localeCompare(b.message),
    );
}

function parseEslintJson(inputPath, repoRoot, workdir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse ESLint JSON ${inputPath}: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('ESLint JSON root must be an array');

  const diagnostics = [];
  for (const result of parsed) {
    const rel = repoRelative(result.filePath, repoRoot, workdir);
    for (const message of result.messages || []) {
      const severity = message.severity === 2 ? 'error' : 'warning';
      const code = message.ruleId || (message.fatal ? 'fatal' : 'unknown');
      diagnostics.push({
        path: rel,
        severity,
        code,
        message: normalizeDiagnosticMessage(message.message, repoRoot),
        locations: [{ line: message.line || 0, column: message.column || 0 }],
      });
    }
  }
  return groupDiagnostics('eslint', diagnostics);
}

function parseTscText(inputPath, repoRoot, workdir) {
  const text = fs.readFileSync(inputPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const diagnostics = [];
  const pattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    diagnostics.push({
      path: repoRelative(match[1], repoRoot, workdir),
      severity: 'error',
      code: match[4],
      message: normalizeDiagnosticMessage(match[5], repoRoot),
      locations: [{ line: Number(match[2]), column: Number(match[3]) }],
    });
  }
  if (text.trim() && diagnostics.length === 0) {
    throw new Error(`TypeScript output contained text but no parseable diagnostics: ${inputPath}`);
  }
  return groupDiagnostics('tsc', diagnostics);
}

function parseDiagnostics(kind, inputPath, repoRoot, workdir) {
  if (kind === 'eslint') return parseEslintJson(inputPath, repoRoot, workdir);
  if (kind === 'tsc') return parseTscText(inputPath, repoRoot, workdir);
  throw new Error(`unsupported kind: ${kind}`);
}

function normalizeArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function buildConfigFiles(paths, repoRoot) {
  return paths.map((relPath) => {
    const abs = path.resolve(repoRoot, relPath);
    if (!fs.existsSync(abs)) throw new Error(`config file missing: ${relPath}`);
    return { path: relPath.split(path.sep).join('/'), sha256: fileHash(abs) };
  });
}

function validateBaselineShape(baseline) {
  if (!baseline || typeof baseline !== 'object') throw new Error('baseline must be an object');
  if (baseline.version !== 1) throw new Error('baseline version must be 1');
  if (!['eslint', 'tsc'].includes(baseline.kind)) throw new Error('invalid baseline kind');
  if (typeof baseline.baseline_sha !== 'string' || !/^[0-9a-f]{40}$/.test(baseline.baseline_sha)) {
    throw new Error('baseline_sha must be a 40-char hex SHA');
  }
  if (!baseline.tool || typeof baseline.tool.version !== 'string') {
    throw new Error('baseline.tool.version is required');
  }
  if (!Array.isArray(baseline.config_files)) throw new Error('baseline.config_files must be an array');
  if (!Array.isArray(baseline.diagnostics)) throw new Error('baseline.diagnostics must be an array');

  const seenConfigs = new Set();
  for (const configFile of baseline.config_files) {
    if (
      !configFile ||
      typeof configFile.path !== 'string' ||
      typeof configFile.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(configFile.sha256)
    ) {
      throw new Error('invalid config file entry');
    }
    if (seenConfigs.has(configFile.path)) {
      throw new Error(`duplicate config file ${configFile.path}`);
    }
    seenConfigs.add(configFile.path);
  }

  const seen = new Set();
  for (const diagnostic of baseline.diagnostics) {
    for (const field of ['fingerprint', 'path', 'severity', 'code', 'message']) {
      if (typeof diagnostic[field] !== 'string') throw new Error(`diagnostic missing ${field}`);
    }
    if (!Number.isInteger(diagnostic.count) || diagnostic.count < 1) {
      throw new Error(`invalid count for ${diagnostic.fingerprint}`);
    }
    if (seen.has(diagnostic.fingerprint)) {
      throw new Error(`duplicate fingerprint ${diagnostic.fingerprint}`);
    }
    const expectedFingerprint = makeFingerprint(baseline.kind, diagnostic);
    if (diagnostic.fingerprint !== expectedFingerprint) {
      throw new Error(`fingerprint mismatch for ${diagnostic.path}`);
    }
    seen.add(diagnostic.fingerprint);
  }
}

function ensureBaselineIsAncestor(repoRoot, baselineSha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baselineSha, 'HEAD'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    throw new Error(`baseline_sha ${baselineSha} is not an ancestor of HEAD`);
  }
}

function compareDiagnostics({ baseline, current, repoRoot, toolVersion, producerExit }) {
  validateBaselineShape(baseline);
  if (baseline.tool.version !== toolVersion) {
    throw new Error(`tool version mismatch: baseline=${baseline.tool.version} current=${toolVersion}`);
  }
  ensureBaselineIsAncestor(repoRoot, baseline.baseline_sha);
  for (const configFile of baseline.config_files) {
    const currentHash = fileHash(path.resolve(repoRoot, configFile.path));
    if (currentHash !== configFile.sha256) {
      throw new Error(`config hash mismatch for ${configFile.path}`);
    }
  }

  const baselineMap = new Map(baseline.diagnostics.map((d) => [d.fingerprint, d]));
  const currentMap = new Map(current.map((d) => [d.fingerprint, d]));
  const added = [];
  const increased = [];
  const removed = [];
  const decreased = [];
  const unchanged = [];

  for (const diagnostic of current) {
    const base = baselineMap.get(diagnostic.fingerprint);
    if (!base) added.push(diagnostic);
    else if (diagnostic.count > base.count) increased.push({ baseline: base, current: diagnostic });
    else if (diagnostic.count < base.count) decreased.push({ baseline: base, current: diagnostic });
    else unchanged.push(diagnostic);
  }
  for (const diagnostic of baseline.diagnostics) {
    if (!currentMap.has(diagnostic.fingerprint)) removed.push(diagnostic);
  }

  if (producerExit !== 0 && current.length === 0) {
    throw new Error(`producer exited ${producerExit} but no parseable diagnostics were found`);
  }

  return {
    ok: added.length === 0 && increased.length === 0,
    producer_exit: producerExit,
    baseline_count: baseline.diagnostics.reduce((sum, d) => sum + d.count, 0),
    current_count: current.reduce((sum, d) => sum + d.count, 0),
    fingerprints: {
      baseline: baseline.diagnostics.length,
      current: current.length,
      added: added.length,
      increased: increased.length,
      removed: removed.length,
      decreased: decreased.length,
      unchanged: unchanged.length,
    },
    added,
    increased,
    removed,
    decreased,
  };
}

function makeBaseline(args) {
  const repoRoot = path.resolve(args['repo-root'] || '.');
  const kind = args.kind;
  const diagnostics = parseDiagnostics(kind, args.input, repoRoot, args.workdir || '.');
  return {
    version: 1,
    kind,
    baseline_sha: args['baseline-sha'],
    tool: {
      name: kind === 'eslint' ? 'eslint' : 'typescript',
      version: args['tool-version'],
    },
    fingerprint_model: {
      fields: ['kind', 'repo_relative_path', 'severity', 'rule_or_code', 'normalized_message'],
      multiplicity: 'exact count per fingerprint; removals allowed; new fingerprints or count increases fail',
    },
    config_files: buildConfigFiles(normalizeArray(args.config), repoRoot),
    diagnostics,
  };
}

function commandGenerate(args) {
  const baseline = makeBaseline(args);
  const json = `${JSON.stringify(baseline, null, 2)}\n`;
  if (args.output) fs.writeFileSync(args.output, json);
  else process.stdout.write(json);
}

function commandCompare(args) {
  const repoRoot = path.resolve(args['repo-root'] || '.');
  const baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
  const current = parseDiagnostics(baseline.kind, args.input, repoRoot, args.workdir || '.');
  const result = compareDiagnostics({
    baseline,
    current,
    repoRoot,
    toolVersion: args['tool-version'],
    producerExit: Number(args['producer-exit'] || 0),
  });
  if (args.summary) fs.writeFileSync(args.summary, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `diagnostic-baseline ${result.ok ? 'PASS' : 'FAIL'}: current=${result.current_count}, baseline=${result.baseline_count}, added=${result.fingerprints.added}, increased=${result.fingerprints.increased}, removed=${result.fingerprints.removed}`,
  );
  if (!result.ok) {
    const findings = [
      ...result.added.map((diagnostic) => ({
        label: 'ADDED',
        diagnostic,
        baselineCount: 0,
      })),
      ...result.increased.map(({ baseline: base, current: diagnostic }) => ({
        label: 'INCREASED',
        diagnostic,
        baselineCount: base.count,
      })),
    ];
    console.error('Actionable diagnostic baseline findings:');
    for (const { label, diagnostic, baselineCount } of findings.slice(0, 20)) {
      const location = diagnostic.locations[0] || { line: 0, column: 0 };
      console.error(
        `${label} ${diagnostic.path}:${location.line}:${location.column} ${diagnostic.severity} ${diagnostic.code} count=${diagnostic.count} baseline=${baselineCount} ${diagnostic.message}`,
      );
    }
    if (findings.length > 20) {
      console.error(`... ${findings.length - 20} additional findings are available in the JSON summary`);
    }
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === 'generate') return commandGenerate(args);
  if (command === 'compare') return commandCompare(args);
  throw new Error('usage: diagnostic-baseline.js generate|compare --kind <eslint|tsc> ...');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  compareDiagnostics,
  groupDiagnostics,
  makeFingerprint,
  normalizeMessage,
  normalizeDiagnosticMessage,
  parseTscText,
  parseEslintJson,
  validateBaselineShape,
};
