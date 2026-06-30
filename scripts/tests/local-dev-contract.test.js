const fs = require("fs");
const path = require("path");

let failed = 0;
let passed = 0;

function findRepoRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(current, "frontend")) &&
      fs.existsSync(path.join(current, "backend"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot find repo root from ${start}`);
    }
    current = parent;
  }
}

function assert(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(findRepoRoot(), relativePath), "utf8");
}

console.log("\n## local-dev script contract");

const script = read("scripts/development/local-dev.sh");
const docs = read("docs/LOCAL_DEVELOPMENT.md");

assert(
  "usage exposes repair command for broken tunnel/backend state",
  script.includes('$(basename "$0") repair') &&
    /repair\)[\s\S]{0,120}configure_mode "\$CURRENT_MODE"[\s\S]{0,120}repair/.test(
      script,
    ),
);

assert(
  "status reports backend DB-backed health instead of process health only",
  script.includes("backend_db_status") &&
    script.includes("backend-db=ok") &&
    script.includes("backend-db=down") &&
    /managed_status_line "backend"[\s\S]{0,120}backend_db_status/.test(script),
);

assert(
  "backend readiness waits for a DB-backed endpoint after /health",
  script.includes("wait_for_backend_db") &&
    script.includes("Backend DB-backed API") &&
    /wait_for_http "http:\/\/127\.0\.0\.1:\$BACKEND_PORT\/health"[\s\S]{0,900}wait_for_backend_db/.test(
      script,
    ),
);

assert(
  "check validates the DB-backed stock endpoint with an explicit timeout",
  script.includes("check_backend_db") &&
    script.includes("curl -fsS --max-time") &&
    script.includes("/api/stocks?limit=1") &&
    /check\(\)[\s\S]{0,900}check_backend_db/.test(script),
);

assert(
  "repair restarts tunnel/backend path and fails unless DB-backed endpoint works",
  script.includes("repair()") &&
    /repair\(\)[\s\S]{0,1200}start_tunnel/.test(script) &&
    /repair\(\)[\s\S]{0,1200}start_backend/.test(script) &&
    /repair\(\)[\s\S]{0,1200}check_backend_db/.test(script),
);

assert(
  "SSH tunnel supports password-priority mode to avoid too many authentication failures",
  script.includes("STOCKS_DEV_SSH_AUTH_MODE") &&
    script.includes("PreferredAuthentications=password,keyboard-interactive") &&
    script.includes("PubkeyAuthentication=no"),
);

assert(
  "tunnel startup reuses an existing local listener before requiring SSH host",
  /start_tunnel\(\)[\s\S]{0,900}existing_pid="\$\(port_listener_pid "\$LOCAL_DB_PORT"\)"[\s\S]{0,900}STOCKS_DEV_SSH_HOST is required/.test(
    script,
  ),
);

assert(
  "tunnel startup can reuse the last SSH host cache for repair",
  script.includes("SSH_HOST_CACHE") &&
    /if \[ -z "\$SSH_HOST" \] && \[ -f "\$SSH_HOST_CACHE" \]/.test(script) &&
    script.includes('printf \'%s\\n\' "$SSH_HOST" > "$SSH_HOST_CACHE"'),
);

assert(
  "local development docs mention repair and DB-backed health",
  docs.includes("scripts/development/local-dev.sh repair") &&
    docs.includes("backend-db=ok") &&
    docs.includes("DB-backed"),
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
