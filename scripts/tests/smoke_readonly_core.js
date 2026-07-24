#!/usr/bin/env node

/**
 * Read-only core smoke test for the stock recommendation platform.
 *
 * Goals:
 * - Verify the API process, auth, task automation health, market data health,
 *   quant read endpoints and paper-trading risk dashboard are reachable.
 * - Avoid triggering data sync, TradingAgents analysis, paper trades or queue jobs.
 * - Avoid write-like GET endpoints that create default portfolios/snapshots.
 *
 * Usage:
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 \
 *   SMOKE_USERNAME=stocks \
 *   SMOKE_PASSWORD=666 \
 *   node scripts/tests/smoke_readonly_core.js
 *
 * Optional:
 *   SMOKE_TOKEN=...                 # skip login and use an existing Bearer token
 *   SMOKE_TIMEOUT_MS=15000          # per-request timeout
 *   SMOKE_INCLUDE_EXTERNAL=true     # include TradingAgents health route
 */

const baseUrl =
  process.env.SMOKE_BASE_URL ||
  process.env.API_BASE_URL ||
  "http://127.0.0.1:3000";
const username =
  process.env.SMOKE_USERNAME || process.env.ADMIN_USERNAME || "stocks";
const password =
  process.env.SMOKE_PASSWORD || process.env.ADMIN_PASSWORD || "666";
const timeoutMs = Math.max(Number(process.env.SMOKE_TIMEOUT_MS || 15000), 1000);
const includeExternal =
  String(process.env.SMOKE_INCLUDE_EXTERNAL || "").toLowerCase() === "true";
const jsonOutPath = process.env.SMOKE_JSON_OUT || "";

const results = [];

const color = {
  green: (text) => (process.stdout.isTTY ? `\u001b[32m${text}\u001b[0m` : text),
  yellow: (text) =>
    process.stdout.isTTY ? `\u001b[33m${text}\u001b[0m` : text,
  red: (text) => (process.stdout.isTTY ? `\u001b[31m${text}\u001b[0m` : text),
  gray: (text) => (process.stdout.isTTY ? `\u001b[90m${text}\u001b[0m` : text),
};

function buildUrl(path) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const base = new URL(normalizedBase);
  let normalizedPath = String(path || "").replace(/^\/+/, "");

  // If callers pass SMOKE_BASE_URL=http://host/api, keep endpoint paths intuitive.
  if (
    base.pathname.replace(/\/+$/, "").endsWith("/api") &&
    normalizedPath.startsWith("api/")
  ) {
    normalizedPath = normalizedPath.slice(4);
  }
  if (
    base.pathname.replace(/\/+$/, "").endsWith("/api") &&
    (normalizedPath === "" ||
      normalizedPath === "health" ||
      normalizedPath === "healthz")
  ) {
    return new URL(`/${normalizedPath}`, base.origin).toString();
  }

  return new URL(normalizedPath, base).toString();
}

function preview(value, limit = 700) {
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}

function assertApiSuccess(json, context) {
  if (!json || json.success !== true) {
    throw new Error(
      `${context} expected { success: true }, got ${preview(json)}`
    );
  }
}

function assertArray(value, context) {
  if (!Array.isArray(value)) {
    throw new Error(`${context} expected array, got ${preview(value)}`);
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestProcessHealth() {
  const startedAt = Date.now();
  const candidates = ["/health", "/healthz"];
  const errors = [];

  for (const path of candidates) {
    const url = buildUrl(path);
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "stocks-readonly-smoke/1.0",
        },
      });
      const text = await response.text();
      if (!response.ok) {
        errors.push(`${path}: HTTP ${response.status}`);
        continue;
      }
      const trimmed = text.trim();
      let ok = false;
      if (trimmed === "ok") {
        ok = true;
      } else {
        try {
          const json = trimmed ? JSON.parse(trimmed) : {};
          ok = json.status === "ok" || json.success === true;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        errors.push(`${path}: unexpected payload ${trimmed.slice(0, 120)}`);
        continue;
      }
      const elapsedMs = Date.now() - startedAt;
      results.push({
        name: "process health",
        path,
        status: "pass",
        critical: true,
        elapsed_ms: elapsedMs,
      });
      console.log(
        color.green("[PASS] process health"),
        color.gray(`GET ${path} ${elapsedMs}ms`)
      );
      return true;
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : error.message;
      errors.push(`${path}: ${message}`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const message = errors.join("; ");
  results.push({
    name: "process health",
    path: candidates.join(" | "),
    status: "fail",
    critical: true,
    elapsed_ms: elapsedMs,
    message,
  });
  console.log(
    color.red("[FAIL] process health"),
    color.gray(`GET ${candidates.join(" | ")} ${elapsedMs}ms`),
    message
  );
  return false;
}

async function requestJson(name, path, options = {}) {
  const startedAt = Date.now();
  const critical = options.critical !== false;
  const method = options.method || "GET";
  const url = buildUrl(path);

  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "stocks-readonly-smoke/1.0",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers || {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `Non-JSON response ${response.status}: ${text.slice(0, 300)}`
      );
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${preview(json)}`);
    }

    if (typeof options.expect === "function") {
      options.expect(json, response);
    }

    const elapsedMs = Date.now() - startedAt;
    results.push({
      name,
      path,
      status: "pass",
      critical,
      elapsed_ms: elapsedMs,
    });
    console.log(
      color.green(`[PASS] ${name}`),
      color.gray(`${method} ${path} ${elapsedMs}ms`)
    );
    return json;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message =
      error?.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : error.message;
    results.push({
      name,
      path,
      status: "fail",
      critical,
      elapsed_ms: elapsedMs,
      message,
    });
    console.log(
      critical ? color.red(`[FAIL] ${name}`) : color.yellow(`[WARN] ${name}`),
      color.gray(`${method} ${path} ${elapsedMs}ms`),
      message
    );
    return null;
  }
}

function skip(name, reason) {
  results.push({ name, status: "skip", critical: false, message: reason });
  console.log(color.yellow(`[SKIP] ${name}`), reason);
}

function extractToken(loginJson) {
  return (
    process.env.SMOKE_TOKEN ||
    loginJson?.data?.tokens?.accessToken ||
    loginJson?.data?.accessToken ||
    loginJson?.tokens?.accessToken ||
    loginJson?.accessToken ||
    loginJson?.token ||
    ""
  );
}

function getTaskList(tasksJson) {
  const data = tasksJson?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.tasks)) return data.tasks;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function writeJsonSummary(payload) {
  if (!jsonOutPath) return;
  const fs = require("fs");
  const path = require("path");
  fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
  fs.writeFileSync(jsonOutPath, JSON.stringify(payload, null, 2));
}

async function main() {
  if (typeof fetch !== "function") {
    throw new Error(
      "This script requires Node.js 18+ with global fetch support."
    );
  }

  console.log(
    `Read-only smoke test started: base=${baseUrl}, timeout=${timeoutMs}ms, include_external=${includeExternal}`
  );

  let orderIntentTraceCandidateId = null;
  let paperTradingPortfolioId = null;

  await requestProcessHealth();

  if (String(process.env.SMOKE_CHECK_API_ROOT || "").toLowerCase() === "true") {
    await requestJson("api root", "/", {
      critical: false,
      expect: (json) => {
        if (!json.message)
          throw new Error(`unexpected root payload: ${preview(json)}`);
      },
    });
  } else {
    skip(
      "api root",
      "skipped by default because public frontend roots often serve HTML"
    );
  }

  let token = process.env.SMOKE_TOKEN || "";
  if (!token) {
    const loginJson = await requestJson("auth login", "/api/auth/login", {
      method: "POST",
      body: { username, password },
      expect: (json) => assertApiSuccess(json, "auth login"),
    });
    token = extractToken(loginJson);
  } else {
    skip("auth login", "SMOKE_TOKEN provided, login skipped");
  }

  if (!token) {
    console.log(
      color.red(
        "No access token available; authenticated checks will be skipped."
      )
    );
    skip("authenticated checks", "missing token");
  } else {
    await requestJson("auth profile", "/api/auth/profile", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "auth profile");
        if (!json.data?.user?.id)
          throw new Error(`profile user missing: ${preview(json)}`);
      },
    });

    await requestJson(
      "paper trading portfolios",
      "/api/paper-trading/portfolios",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "paper trading portfolios");
          const portfolios = Array.isArray(json.data) ? json.data : [];
          const researchLoop =
            portfolios.find(
              (item) => item?.portfolio_type === "research_loop"
            ) || portfolios.find((item) => item?.name === "研究闭环模拟盘");
          paperTradingPortfolioId = Number(researchLoop?.id || 0);
          if (
            !Number.isSafeInteger(paperTradingPortfolioId) ||
            paperTradingPortfolioId <= 0
          ) {
            throw new Error(
              `research-loop portfolio missing: ${preview(portfolios)}`
            );
          }
        },
      }
    );

    await requestJson("market service health", "/api/market/health", {
      expect: (json) => {
        assertApiSuccess(json, "market service health");
        if (!json.data?.status)
          throw new Error(`market health status missing: ${preview(json)}`);
      },
    });

    await requestJson("live trading readiness", "/api/live-trading/readiness", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "live trading readiness");
        if (
          !json.data?.safety ||
          !json.data?.broker ||
          !json.data?.market_data
        ) {
          throw new Error(
            `live trading readiness payload missing: ${preview(json)}`
          );
        }
        if (!json.data.market_data_health?.status) {
          throw new Error(
            `live trading market data health missing: ${preview(json)}`
          );
        }
        if (
          !Array.isArray(json.data.market_data_provider_comparison?.providers)
        ) {
          throw new Error(
            `live trading provider comparison missing: ${preview(json)}`
          );
        }
        if (json.data.safety.can_submit_orders === true) {
          throw new Error(
            `live trading readiness should be safe by default: ${preview(
              json.data.safety
            )}`
          );
        }
        if (json.data.safety.unattended_real_order_allowed !== false) {
          throw new Error(
            `live trading unattended real orders must be blocked: ${preview(
              json.data.safety
            )}`
          );
        }
        if (!json.data.safety.unattended_policy?.conclusion) {
          throw new Error(
            `live trading unattended policy missing: ${preview(
              json.data.safety
            )}`
          );
        }
      },
    });

    await requestJson("live trading overview", "/api/live-trading/overview", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "live trading overview");
        if (!json.data?.summary || !json.data?.readiness) {
          throw new Error(
            `live trading overview payload missing: ${preview(json)}`
          );
        }
        if (!json.data.summary.market_data_status) {
          throw new Error(
            `live trading overview market status missing: ${preview(json.data)}`
          );
        }
        if (json.data.summary.can_submit_orders === true) {
          throw new Error(
            `live trading overview should not allow orders by default: ${preview(
              json.data.summary
            )}`
          );
        }
        if (!json.data.shadow_autopilot?.summary) {
          throw new Error(
            `live trading shadow autopilot summary missing: ${preview(
              json.data
            )}`
          );
        }
      },
    });

    await requestJson(
      "live trading reconciliation",
      "/api/live-trading/reconciliation",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "live trading reconciliation");
          if (
            !json.data?.summary ||
            !Array.isArray(json.data?.position_matches)
          ) {
            throw new Error(
              `live trading reconciliation payload missing: ${preview(json)}`
            );
          }
          if (Number(json.data.summary.alignment_score || 0) < 0) {
            throw new Error(
              `live trading reconciliation score invalid: ${preview(
                json.data.summary
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "live trading draft candidates",
      "/api/live-trading/order-draft-candidates?limit=5",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "live trading draft candidates");
          if (!json.data?.summary || !Array.isArray(json.data?.candidates)) {
            throw new Error(
              `live trading draft candidate payload missing: ${preview(json)}`
            );
          }
          if (
            json.data.summary.eligible_count > json.data.summary.total_count
          ) {
            throw new Error(
              `live trading draft candidate counts invalid: ${preview(
                json.data.summary
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "live trading shadow autopilot dry run",
      "/api/live-trading/order-drafts/shadow-autopilot",
      {
        token,
        method: "POST",
        body: { dry_run: true, limit: 1, source: "readonly_smoke" },
        expect: (json) => {
          assertApiSuccess(json, "live trading shadow autopilot dry run");
          if (json.data?.summary?.real_order_submitted !== 0) {
            throw new Error(
              `live trading shadow dry run must not submit real orders: ${preview(
                json.data?.summary
              )}`
            );
          }
          if (json.data?.safety?.unattended_real_order_allowed !== false) {
            throw new Error(
              `live trading shadow dry run policy invalid: ${preview(
                json.data?.safety
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "live trading shadow outcomes",
      "/api/live-trading/shadow-outcomes?limit=5",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "live trading shadow outcomes");
          if (!json.data?.summary || !Array.isArray(json.data?.items)) {
            throw new Error(
              `live trading shadow outcomes payload missing: ${preview(json)}`
            );
          }
          if (json.data.summary.real_order_submitted !== 0) {
            throw new Error(
              `live trading shadow outcomes must not include real submissions: ${preview(
                json.data.summary
              )}`
            );
          }
          if (!Array.isArray(json.data.summary.horizon_summary)) {
            throw new Error(
              `live trading shadow horizon summary missing: ${preview(
                json.data.summary
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "live trading shadow trend",
      "/api/live-trading/shadow-trend?limit=5",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "live trading shadow trend");
          if (!json.data?.summary || !Array.isArray(json.data?.points)) {
            throw new Error(
              `live trading shadow trend payload missing: ${preview(json)}`
            );
          }
          if (Number(json.data.summary.real_order_submitted || 0) !== 0) {
            throw new Error(
              `live trading shadow trend must not contain real submissions: ${preview(
                json.data.summary
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "live trading shadow budget attribution",
      "/api/live-trading/shadow-budget-attribution?limit=5&window_days=7",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "live trading shadow budget attribution");
          if (!json.data?.summary || !Array.isArray(json.data?.periods)) {
            throw new Error(
              `live trading shadow budget attribution payload missing: ${preview(
                json
              )}`
            );
          }
          if (Number(json.data.real_order_submitted || 0) !== 0) {
            throw new Error(
              `shadow budget attribution must not contain real submissions: ${preview(
                json.data
              )}`
            );
          }
          for (const key of [
            "suggestion_count",
            "applied_count",
            "pending_count",
            "total_shadow_sample_count",
            "total_evaluated_count",
          ]) {
            if (!Number.isFinite(Number(json.data.summary[key] || 0))) {
              throw new Error(
                `shadow budget attribution summary ${key} invalid: ${preview(
                  json.data.summary
                )}`
              );
            }
          }
          const first = json.data.periods[0];
          if (first) {
            if (
              !first.decision?.action ||
              !first.delta ||
              !first.pre_window ||
              !first.post_window
            ) {
              throw new Error(
                `shadow budget attribution period invalid: ${preview(first)}`
              );
            }
          }
        },
      }
    );

    await requestJson("data source health", "/api/market/data-sources/health", {
      expect: (json) => {
        assertApiSuccess(json, "data source health");
        if (!json.data?.summary)
          throw new Error(`data source summary missing: ${preview(json)}`);
      },
    });

    await requestJson(
      "data update status",
      "/api/market/update-status?type=daily_update&limit=5",
      {
        critical: false,
        expect: (json) => assertApiSuccess(json, "data update status"),
      }
    );

    const tasksJson = await requestJson("scheduled tasks", "/api/tasks", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "scheduled tasks");
        assertArray(getTaskList(json), "scheduled tasks data");
        const tasks = getTaskList(json);
        const quantTasks = tasks.filter(
          (task) => task?.type === "QUANT_DAILY_PIPELINE"
        );
        for (const task of quantTasks) {
          const params = task.parameters || {};
          if (Number(params.quote_sync_limit || 0) < 300) {
            throw new Error(
              `quant task quote_sync_limit below baseline: ${
                task.name
              } ${preview(params)}`
            );
          }
          if (Number(params.factor_sync_limit || 0) < 300) {
            throw new Error(
              `quant task factor_sync_limit below baseline: ${
                task.name
              } ${preview(params)}`
            );
          }
          if (String(params.realtime_quote_source || "auto") !== "auto") {
            throw new Error(
              `quant task realtime_quote_source should be auto: ${
                task.name
              } ${preview(params)}`
            );
          }
        }
        const quoteSyncTask = tasks.find(
          (task) => task?.type === "REALTIME_QUOTE_SYNC"
        );
        if (
          !quoteSyncTask ||
          Number(quoteSyncTask.parameters?.limit || 0) < 300
        ) {
          throw new Error(
            `realtime quote sync task missing or low limit: ${preview(
              quoteSyncTask
            )}`
          );
        }
        const paramMaintenanceTask = tasks.find(
          (task) => task?.type === "QUANT_PARAM_MAINTENANCE"
        );
        if (!paramMaintenanceTask) {
          throw new Error("quant param maintenance task missing");
        }
        if (
          Number(paramMaintenanceTask.parameters?.refresh_limit || 0) < 1000
        ) {
          throw new Error(
            `quant param maintenance refresh_limit too low: ${preview(
              paramMaintenanceTask
            )}`
          );
        }
        if (
          !Array.isArray(paramMaintenanceTask.parameters?.horizons) ||
          paramMaintenanceTask.parameters.horizons.length < 3
        ) {
          throw new Error(
            `quant param maintenance horizons incomplete: ${preview(
              paramMaintenanceTask
            )}`
          );
        }
        const shadowAutopilotTask = tasks.find(
          (task) => task?.type === "LIVE_SHADOW_AUTOPILOT"
        );
        if (!shadowAutopilotTask) {
          throw new Error("live shadow autopilot task missing");
        }
        if (
          shadowAutopilotTask.parameters?.require_opening_readiness !== true ||
          Number(shadowAutopilotTask.parameters?.limit || 0) < 1 ||
          Number(shadowAutopilotTask.parameters?.limit || 0) > 10
        ) {
          throw new Error(
            `live shadow autopilot task parameters invalid: ${preview(
              shadowAutopilotTask
            )}`
          );
        }
        const shadowWeeklyReviewTask = tasks.find(
          (task) => task?.type === "LIVE_SHADOW_WEEKLY_REVIEW"
        );
        if (!shadowWeeklyReviewTask) {
          throw new Error("live shadow weekly review task missing");
        }
        if (
          Number(shadowWeeklyReviewTask.parameters?.outcome_limit || 0) < 30
        ) {
          throw new Error(
            `live shadow weekly review outcome_limit too low: ${preview(
              shadowWeeklyReviewTask
            )}`
          );
        }
      },
    });

    await requestJson("automation health", "/api/tasks/automation-health", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "automation health");
        if (!json.data)
          throw new Error(`automation health data missing: ${preview(json)}`);
        const fieldGateAttribution =
          json.data?.risk_limit_suggestion?.field_gate_adjustment_attribution;
        if (fieldGateAttribution?.decision) {
          if (
            !fieldGateAttribution.decision.action ||
            !fieldGateAttribution.decision.reason
          ) {
            throw new Error(
              `automation health field gate decision invalid: ${preview(
                fieldGateAttribution
              )}`
            );
          }
        }
      },
    });

    await requestJson(
      "runtime schema health",
      "/api/tasks/runtime-schema-health",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "runtime schema health");
          if (!json.data?.status || !json.data?.summary) {
            throw new Error(
              `runtime schema health payload invalid: ${preview(json)}`
            );
          }
          if (json.data.status === "critical") {
            throw new Error(
              `runtime schema critical: ${preview(json.data?.summary)}`
            );
          }
        },
      }
    );

    const tasks = getTaskList(tasksJson);
    const firstTaskWithId = tasks.find((task) =>
      Number.isInteger(Number(task?.id))
    );
    if (firstTaskWithId) {
      await requestJson(
        "scheduled task logs + queue details",
        `/api/tasks/${firstTaskWithId.id}/logs`,
        {
          token,
          expect: (json) => {
            assertApiSuccess(json, "scheduled task logs");
            assertArray(json.data, "scheduled task logs data");
          },
        }
      );
    } else {
      skip(
        "scheduled task logs + queue details",
        "no scheduled task with id found"
      );
    }

    await requestJson(
      "task parameter audit timeline",
      "/api/tasks/parameter-audits?limit=5&watched_only=false",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "task parameter audit timeline");
          assertArray(json.data, "task parameter audit timeline data");
        },
      }
    );

    const shadowBudgetAuditsJson = await requestJson(
      "live shadow budget suggestion audit",
      "/api/tasks/parameter-audits?event_type=live_shadow_budget_suggestion&limit=1&watched_only=false",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "live shadow budget suggestion audit");
          assertArray(json.data, "live shadow budget suggestion audit data");
        },
      }
    );
    const latestShadowBudgetAudit = Array.isArray(shadowBudgetAuditsJson?.data)
      ? shadowBudgetAuditsJson.data[0]
      : null;
    if (latestShadowBudgetAudit?.id) {
      await requestJson(
        "live shadow budget apply dry run",
        "/api/tasks/live-shadow-budget-suggestion/apply",
        {
          token,
          method: "POST",
          critical: false,
          body: { dry_run: true, audit_id: latestShadowBudgetAudit.id },
          expect: (json) => {
            assertApiSuccess(json, "live shadow budget apply dry run");
            if (json.data?.dry_run !== true || json.data?.applied === true) {
              throw new Error(
                `shadow budget apply smoke must stay dry-run: ${preview(
                  json.data
                )}`
              );
            }
            if (
              !Number.isInteger(Number(json.data?.suggested_limit)) ||
              Number(json.data.suggested_limit) < 1 ||
              Number(json.data.suggested_limit) > 10
            ) {
              throw new Error(
                `shadow budget suggested limit invalid: ${preview(json.data)}`
              );
            }
            if (
              !Array.isArray(json.data?.changed_keys || []) ||
              !json.data?.target_task_id
            ) {
              throw new Error(
                `shadow budget apply preview payload invalid: ${preview(
                  json.data
                )}`
              );
            }
          },
        }
      );
    } else {
      skip(
        "live shadow budget apply dry run",
        "no live_shadow_budget_suggestion audit found"
      );
    }

    await requestJson("quant signal list", "/api/quant/signals?limit=5", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "quant signal list");
        assertArray(json.data, "quant signal list data");
      },
    });

    await requestJson("quant backtest list", "/api/quant/backtests?limit=5", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "quant backtest list");
        assertArray(json.data, "quant backtest list data");
      },
    });

    await requestJson("quant open watchdog", "/api/quant/open-watchdog", {
      token,
      critical: false,
      expect: (json) => {
        assertApiSuccess(json, "quant open watchdog");
        if (
          !json.data?.status ||
          !json.data?.checks ||
          !Array.isArray(json.data?.issues)
        ) {
          throw new Error(
            `quant open watchdog payload invalid: ${preview(json)}`
          );
        }
      },
    });

    await requestJson(
      "quant strategy experiments",
      "/api/quant/strategy-experiments?limit=5",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "quant strategy experiments");
          if (!json.data || !Array.isArray(json.data.experiments || [])) {
            throw new Error(
              `quant strategy experiments payload invalid: ${preview(json)}`
            );
          }
        },
      }
    );

    await requestJson(
      "quant experiment param suggestions",
      "/api/quant/strategy-experiments/param-suggestions?limit=50",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "quant experiment param suggestions");
          if (
            !Array.isArray(json.data) &&
            !Array.isArray(json.data?.suggestions)
          ) {
            throw new Error(
              `quant experiment param suggestions payload invalid: ${preview(
                json
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "quant param versions",
      "/api/quant/param-versions?limit=20",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "quant param versions");
          if (!Array.isArray(json.data?.versions)) {
            throw new Error(
              `quant param versions payload invalid: ${preview(json)}`
            );
          }
        },
      }
    );

    await requestJson("quant data freshness", "/api/quant/data-freshness", {
      token,
      critical: false,
      expect: (json) => {
        assertApiSuccess(json, "quant data freshness");
        if (
          !json.data?.status ||
          !json.data?.summary ||
          !json.data?.checks ||
          !Array.isArray(json.data?.issues)
        ) {
          throw new Error(
            `quant data freshness payload invalid: ${preview(json)}`
          );
        }
      },
    });

    await requestJson("quant runtime health", "/api/quant/runtime-health", {
      token,
      critical: false,
      expect: (json) => {
        assertApiSuccess(json, "quant runtime health");
        if (
          !json.data?.status ||
          !json.data?.summary ||
          !json.data?.buy_gate ||
          !Array.isArray(json.data?.next_actions || []) ||
          !Array.isArray(json.data?.checks)
        ) {
          throw new Error(
            `quant runtime health payload invalid: ${preview(json)}`
          );
        }
        if (
          !json.data.summary.next_action ||
          !json.data.summary.next_action_label
        ) {
          throw new Error(
            `quant runtime next action missing: ${preview(json.data.summary)}`
          );
        }
        if ((json.data.next_actions || []).length === 0) {
          throw new Error(
            `quant runtime next actions empty: ${preview(
              json.data.next_actions
            )}`
          );
        }
        if (
          Number(json.data.runtime_schema?.summary?.missing_columns || 0) > 0
        ) {
          throw new Error(
            `quant runtime required columns missing: ${preview(
              json.data.runtime_schema.summary
            )}`
          );
        }
        if (
          json.data.factor_coverage &&
          Number(json.data.factor_coverage?.coverage_rate?.valuation || 0) <= 0
        ) {
          throw new Error(
            `quant runtime factor coverage invalid: ${preview(
              json.data.factor_coverage
            )}`
          );
        }
        if (
          json.data.factor_coverage &&
          json.data.factor_coverage.latest_landed_factor_date &&
          !json.data.factor_coverage.effective_factor_date
        ) {
          throw new Error(
            `quant runtime effective factor date missing: ${preview(
              json.data.factor_coverage
            )}`
          );
        }
        if (json.data.factor_coverage?.source_breakdown) {
          for (const [factorKey, breakdown] of Object.entries(
            json.data.factor_coverage.source_breakdown
          )) {
            const sourceSum = Object.values(breakdown || {}).reduce(
              (sum, count) => sum + Number(count || 0),
              0
            );
            const coverageCount = Number(
              json.data.factor_coverage.coverage?.[factorKey] || 0
            );
            if (sourceSum > 0 && coverageCount < sourceSum) {
              throw new Error(
                `quant runtime factor coverage count below effective source breakdown: ${factorKey} coverage=${coverageCount} source_sum=${sourceSum}`
              );
            }
          }
        }
        if (
          !json.data.execution_discipline?.summary ||
          !Array.isArray(json.data.execution_discipline?.issues)
        ) {
          throw new Error(
            `quant runtime execution discipline missing: ${preview(
              json.data.execution_discipline
            )}`
          );
        }
        if (
          json.data.execution_discipline.summary.quote_sync_task_count ===
          undefined
        ) {
          throw new Error(
            `quant runtime quote sync discipline missing: ${preview(
              json.data.execution_discipline.summary
            )}`
          );
        }
        if (
          !(json.data.checks || []).some(
            (item) => item?.key === "execution_discipline"
          )
        ) {
          throw new Error(
            `quant runtime execution discipline check missing: ${preview(
              json.data.checks
            )}`
          );
        }
      },
    });

    await requestJson(
      "today command center",
      "/api/today/command-center?limit=3",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "today command center");
          if (!json.data?.conclusion?.headline) {
            throw new Error(
              `today command center conclusion missing: ${preview(json)}`
            );
          }
          if (
            json.data?.opening_readiness &&
            !["ready", "degraded", "blocked"].includes(
              json.data.opening_readiness.status
            )
          ) {
            throw new Error(
              `today command center opening readiness invalid: ${preview(
                json.data.opening_readiness
              )}`
            );
          }
          if (
            json.data?.tuning_radar &&
            (!json.data.tuning_radar.summary ||
              !Array.isArray(json.data.tuning_radar.canary_candidates || []))
          ) {
            throw new Error(
              `today command center tuning radar invalid: ${preview(
                json.data.tuning_radar
              )}`
            );
          }
          if (
            json.data?.canary_memory &&
            (!json.data.canary_memory.summary ||
              !Array.isArray(json.data.canary_memory.snapshots || []))
          ) {
            throw new Error(
              `today command center canary memory invalid: ${preview(
                json.data.canary_memory
              )}`
            );
          }
        },
      }
    );

    await requestJson("quant indicator catalog", "/api/quant/indicators", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "quant indicator catalog");
        if (!json.data?.group_count || !Array.isArray(json.data?.groups)) {
          throw new Error(`quant indicator catalog invalid: ${preview(json)}`);
        }
      },
    });

    await requestJson(
      "quant performance dashboard",
      "/api/quant/performance-dashboard",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "quant performance dashboard");
          if (
            !json.data?.readiness ||
            !json.data?.indicator_catalog ||
            !json.data?.runtime_health ||
            !json.data?.runtime_discipline?.summary
          ) {
            throw new Error(
              `quant performance dashboard missing readiness/catalog/runtime discipline: ${preview(
                json
              )}`
            );
          }
          assertArray(
            json.data?.latest_backtests?.leaderboard || [],
            "quant performance backtest leaderboard"
          );
          assertArray(
            json.data?.outcome_comparison?.families || [],
            "quant performance outcome families"
          );
          assertArray(
            json.data?.param_validation_dashboard?.summary_by_version || [],
            "quant performance param validation"
          );
          assertArray(
            json.data?.portfolio_family_comparison?.families || [],
            "quant performance portfolio families"
          );
          assertArray(
            json.data?.schedule_summary?.tasks || [],
            "quant performance schedules"
          );
          if (
            !json.data?.schedule_summary?.tasks?.some(
              (task) => task?.type === "REALTIME_QUOTE_SYNC"
            )
          ) {
            throw new Error(
              `quant performance quote sync schedule missing: ${preview(
                json.data?.schedule_summary
              )}`
            );
          }
          if (
            !json.data?.schedule_summary?.tasks?.some(
              (task) => task?.type === "QUANT_PARAM_MAINTENANCE"
            )
          ) {
            throw new Error(
              `quant performance param maintenance schedule missing: ${preview(
                json.data?.schedule_summary
              )}`
            );
          }
          if (!json.data?.param_validation_dashboard?.maintenance_status) {
            throw new Error(
              `quant performance param maintenance status missing: ${preview(
                json.data?.param_validation_dashboard
              )}`
            );
          }
        },
      }
    );

    await requestJson("quant strategy weights", "/api/quant/strategy-weights", {
      token,
      expect: (json) => {
        assertApiSuccess(json, "quant strategy weights");
        assertArray(json.data, "quant strategy weights data");
        const withMetrics = json.data.find((item) => item?.metrics);
        if (withMetrics && !withMetrics.metrics?.weight_decision) {
          throw new Error(
            `quant strategy weight decision missing: ${preview(withMetrics)}`
          );
        }
      },
    });

    await requestJson(
      "quant allocation policy",
      "/api/quant/allocation-policy?capital=200000",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "quant allocation policy");
          if (!json.data)
            throw new Error(`allocation policy data missing: ${preview(json)}`);
          if (!json.data.summary?.conclusion)
            throw new Error(
              `allocation policy conclusion missing: ${preview(json.data)}`
            );
          if (!Array.isArray(json.data.next_actions))
            throw new Error(
              `allocation policy next_actions missing: ${preview(json.data)}`
            );
          const firstAllocation = (json.data.allocations || [])[0];
          if (firstAllocation && !firstAllocation.decision)
            throw new Error(
              `allocation policy decision missing: ${preview(firstAllocation)}`
            );
        },
      }
    );

    await requestJson(
      "paper trading risk profile",
      "/api/paper-trading/risk-profile",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "paper trading risk profile");
          if (!json.data?.status)
            throw new Error(`risk profile status missing: ${preview(json)}`);
        },
      }
    );

    await requestJson(
      "paper trading order intents",
      "/api/paper-trading/order-intents?limit=5&lookback_days=30",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "paper trading order intents");
          if (!json.data?.summary || !Array.isArray(json.data?.intents)) {
            throw new Error(
              `paper trading order intents payload invalid: ${preview(json)}`
            );
          }
          const traceCandidate =
            (json.data?.recent_rejections || [])[0] || json.data.intents[0];
          if (traceCandidate?.id) {
            orderIntentTraceCandidateId = traceCandidate.id;
          }
          for (const key of [
            "total",
            "executed_count",
            "rejected_count",
            "planned_count",
            "held_count",
            "execution_rate",
          ]) {
            if (!Number.isFinite(Number(json.data.summary[key] || 0))) {
              throw new Error(
                `paper trading order intent summary ${key} invalid: ${preview(
                  json.data.summary
                )}`
              );
            }
          }
          if (
            json.data.summary.top_reason_categories !== undefined &&
            !Array.isArray(json.data.summary.top_reason_categories)
          ) {
            throw new Error(
              `paper trading order intent top reasons invalid: ${preview(
                json.data.summary
              )}`
            );
          }
          if (json.data.summary.hindsight) {
            for (const key of [
              "evaluated_count",
              "pending_count",
              "false_reject_count",
              "correct_reject_count",
              "avg_intended_action_return_pct",
            ]) {
              if (
                !Number.isFinite(Number(json.data.summary.hindsight[key] || 0))
              ) {
                throw new Error(
                  `paper trading order intent hindsight ${key} invalid: ${preview(
                    json.data.summary.hindsight
                  )}`
                );
              }
            }
            if (
              !Array.isArray(
                json.data.summary.hindsight.top_false_rejections || []
              )
            ) {
              throw new Error(
                `paper trading order intent hindsight false rejections invalid: ${preview(
                  json.data.summary.hindsight
                )}`
              );
            }
            if (
              !Array.isArray(json.data.summary.hindsight.rule_suggestions || [])
            ) {
              throw new Error(
                `paper trading order intent hindsight rule suggestions invalid: ${preview(
                  json.data.summary.hindsight
                )}`
              );
            }
            if (
              !Array.isArray(
                json.data.summary.hindsight.rule_suggestion_windows || []
              )
            ) {
              throw new Error(
                `paper trading order intent rule suggestion windows invalid: ${preview(
                  json.data.summary.hindsight
                )}`
              );
            }
            if (
              !Array.isArray(
                json.data.summary.hindsight.stable_rule_suggestions || []
              )
            ) {
              throw new Error(
                `paper trading order intent stable rule suggestions invalid: ${preview(
                  json.data.summary.hindsight
                )}`
              );
            }
            if (
              !Array.isArray(
                json.data.summary.hindsight.parameter_adjustment_preview || []
              )
            ) {
              throw new Error(
                `paper trading order intent parameter preview invalid: ${preview(
                  json.data.summary.hindsight
                )}`
              );
            }
            for (const key of [
              "cache_hit_count",
              "cache_miss_count",
              "would_persist_count",
              "persisted_snapshot_count",
              "persist_failed_count",
            ]) {
              if (
                !Number.isFinite(Number(json.data.summary.hindsight[key] || 0))
              ) {
                throw new Error(
                  `paper trading order intent cache metric ${key} invalid: ${preview(
                    json.data.summary.hindsight
                  )}`
                );
              }
            }
          }
        },
      }
    );

    await requestJson(
      "paper trading family hindsight",
      "/api/paper-trading/order-intents/family-hindsight?lookback_days=30&limit=500",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "paper trading family hindsight");
          if (!json.data?.summary || !Array.isArray(json.data?.families)) {
            throw new Error(
              `paper trading family hindsight payload invalid: ${preview(json)}`
            );
          }
          for (const key of [
            "portfolio_count",
            "evaluated_count",
            "false_reject_count",
            "saved_loss_count",
            "avg_intended_action_return_pct",
          ]) {
            if (!Number.isFinite(Number(json.data.summary[key] || 0))) {
              throw new Error(
                `paper trading family hindsight summary ${key} invalid: ${preview(
                  json.data.summary
                )}`
              );
            }
          }
        },
      }
    );

    if (orderIntentTraceCandidateId) {
      await requestJson(
        "paper trading order intent trace",
        `/api/paper-trading/order-intents/${orderIntentTraceCandidateId}/trace`,
        {
          token,
          expect: (json) => {
            assertApiSuccess(json, "paper trading order intent trace");
            if (!json.data?.intent || !Array.isArray(json.data?.timeline)) {
              throw new Error(
                `paper trading order intent trace payload invalid: ${preview(
                  json
                )}`
              );
            }
            if (!json.data?.peer_review) {
              throw new Error(
                `paper trading order intent trace peer review missing: ${preview(
                  json
                )}`
              );
            }
          },
        }
      );
    }

    await requestJson(
      "paper trading order intent hindsight refresh",
      "/api/paper-trading/order-intents/hindsight/refresh",
      {
        method: "POST",
        token,
        body: {
          dry_run: true,
          lookback_days: 30,
          limit: 80,
          refresh_hindsight: false,
        },
        expect: (json) => {
          assertApiSuccess(
            json,
            "paper trading order intent hindsight refresh"
          );
          if (!json.data?.summary) {
            throw new Error(
              `paper trading order intent hindsight refresh summary missing: ${preview(
                json
              )}`
            );
          }
          if (
            json.data.dry_run !== true ||
            !Number.isFinite(Number(json.data.refreshed_count || 0)) ||
            !Number.isFinite(Number(json.data.would_persist_count || 0)) ||
            !Number.isFinite(
              Number(json.data.summary.persisted_snapshot_count || 0)
            )
          ) {
            throw new Error(
              `paper trading order intent hindsight refresh metrics invalid: ${preview(
                json.data
              )}`
            );
          }
          if (
            Number(json.data.refreshed_count || 0) !== 0 ||
            Number(json.data.summary.persisted_snapshot_count || 0) !== 0
          ) {
            throw new Error(
              `paper trading order intent refresh smoke must stay dry-run: ${preview(
                json.data
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "recommendation trade outcomes",
      `/api/paper-trading/recommendation-outcomes?portfolio_id=${paperTradingPortfolioId}&limit=5&include_open=false`,
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "recommendation trade outcomes");
          if (!json.data?.summary) {
            throw new Error(
              `recommendation outcome summary missing: ${preview(json)}`
            );
          }
          const outcomeWithPolicy = (json.data?.outcomes || []).find(
            (item) => item?.policy_explain
          );
          if (outcomeWithPolicy) {
            if (!outcomeWithPolicy.policy_explain.entry_risk_guard) {
              throw new Error(
                `recommendation outcome entry risk explain missing: ${preview(
                  outcomeWithPolicy.policy_explain
                )}`
              );
            }
            if (
              outcomeWithPolicy.policy_explain.execution_reality &&
              typeof outcomeWithPolicy.policy_explain.execution_reality
                .allowed !== "boolean"
            ) {
              throw new Error(
                `recommendation outcome execution reality invalid: ${preview(
                  outcomeWithPolicy.policy_explain.execution_reality
                )}`
              );
            }
          }
        },
      }
    );

    await requestJson(
      "paper trading order intent tuning preview",
      "/api/paper-trading/order-intent-tuning/apply",
      {
        method: "POST",
        token,
        body: { dry_run: true, portfolio_id: paperTradingPortfolioId },
        expect: (json) => {
          assertApiSuccess(json, "paper trading order intent tuning preview");
          if (!json.data || !Array.isArray(json.data.changes)) {
            throw new Error(
              `paper trading order intent tuning preview payload invalid: ${preview(
                json
              )}`
            );
          }
          for (const key of ["preview_count", "applied_count"]) {
            if (!Number.isFinite(Number(json.data[key] || 0))) {
              throw new Error(
                `paper trading order intent tuning preview ${key} invalid: ${preview(
                  json.data
                )}`
              );
            }
          }
          if (json.data.dry_run !== true || json.data.applied === true) {
            throw new Error(
              `paper trading order intent tuning preview must be read-only dry run: ${preview(
                json.data
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "paper trading order intent canary preview",
      "/api/paper-trading/order-intent-tuning/apply",
      {
        method: "POST",
        token,
        body: {
          dry_run: true,
          canary: true,
          canary_max_parameters: 1,
          canary_observation_trades: 8,
          canary_observation_days: 10,
          portfolio_id: paperTradingPortfolioId,
        },
        expect: (json) => {
          assertApiSuccess(json, "paper trading order intent canary preview");
          if (!json.data || !Array.isArray(json.data.changes)) {
            throw new Error(
              `paper trading order intent canary preview payload invalid: ${preview(
                json
              )}`
            );
          }
          if (
            json.data.dry_run !== true ||
            json.data.applied === true ||
            json.data.canary !== true
          ) {
            throw new Error(
              `paper trading order intent canary preview must be dry-run canary: ${preview(
                json.data
              )}`
            );
          }
          if (
            json.data.canary_plan &&
            !Array.isArray(json.data.canary_plan.selected_parameter_keys || [])
          ) {
            throw new Error(
              `paper trading order intent canary selected keys invalid: ${preview(
                json.data.canary_plan
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "paper trading order intent tuning candidates",
      `/api/paper-trading/order-intent-tuning/candidates?portfolio_id=${paperTradingPortfolioId}&use_family_hindsight=true&family_hindsight_min_consensus=2&family_hindsight_min_evaluated=5`,
      {
        token,
        expect: (json) => {
          assertApiSuccess(
            json,
            "paper trading order intent tuning candidates"
          );
          if (!json.data || json.data.read_only !== true) {
            throw new Error(
              `paper trading order intent tuning candidates must be read-only: ${preview(
                json
              )}`
            );
          }
          if (
            !json.data.summary ||
            !Array.isArray(json.data.candidates) ||
            !Array.isArray(json.data.canary_candidates)
          ) {
            throw new Error(
              `paper trading order intent tuning candidates payload invalid: ${preview(
                json.data
              )}`
            );
          }
          for (const key of [
            "stable_window_candidate_count",
            "family_hindsight_candidate_count",
            "merged_candidate_count",
            "canary_candidate_count",
          ]) {
            if (!Number.isFinite(Number(json.data.summary[key] || 0))) {
              throw new Error(
                `paper trading order intent tuning candidate ${key} invalid: ${preview(
                  json.data.summary
                )}`
              );
            }
          }
        },
      }
    );

    await requestJson(
      "paper trading order intent canary status",
      "/api/paper-trading/order-intent-tuning/canary",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "paper trading order intent canary status");
          if (!json.data?.summary?.conclusion) {
            throw new Error(
              `paper trading order intent canary status conclusion missing: ${preview(
                json
              )}`
            );
          }
          if (json.data.active && !json.data.observation) {
            throw new Error(
              `paper trading order intent canary active observation missing: ${preview(
                json.data
              )}`
            );
          }
          if (json.data.active) {
            if (!json.data.review?.action || !json.data.review?.action_label) {
              throw new Error(
                `paper trading order intent canary review missing: ${preview(
                  json.data
                )}`
              );
            }
            if (!json.data.rollback_plan?.safety_state) {
              throw new Error(
                `paper trading order intent canary rollback plan missing: ${preview(
                  json.data
                )}`
              );
            }
            if (!json.data.attribution?.conclusion) {
              throw new Error(
                `paper trading order intent canary attribution missing: ${preview(
                  json.data
                )}`
              );
            }
            if (!json.data.evidence?.conclusion) {
              throw new Error(
                `paper trading order intent canary evidence missing: ${preview(
                  json.data
                )}`
              );
            }
            if (
              json.data.review.drawdown_guard &&
              typeof json.data.review.drawdown_guard.passed !== "boolean"
            ) {
              throw new Error(
                `paper trading order intent canary drawdown guard invalid: ${preview(
                  json.data.review.drawdown_guard
                )}`
              );
            }
            if (!Array.isArray(json.data.review.reasons || [])) {
              throw new Error(
                `paper trading order intent canary review reasons invalid: ${preview(
                  json.data.review
                )}`
              );
            }
          }
        },
      }
    );

    await requestJson(
      "paper trading order intent canary snapshots",
      "/api/paper-trading/order-intent-tuning/canary/snapshots?limit=5",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "paper trading order intent canary snapshots");
          if (!json.data?.summary || !Array.isArray(json.data.snapshots)) {
            throw new Error(
              `paper trading order intent canary snapshots payload invalid: ${preview(
                json
              )}`
            );
          }
          if (
            !Number.isFinite(
              Number(
                json.data.summary.snapshot_count ?? json.data.snapshots.length
              )
            )
          ) {
            throw new Error(
              `paper trading order intent canary snapshots count invalid: ${preview(
                json.data.summary
              )}`
            );
          }
          const first = json.data.snapshots[0];
          if (first && (!first.generated_at || !first.review)) {
            throw new Error(
              `paper trading order intent canary snapshot item invalid: ${preview(
                first
              )}`
            );
          }
        },
      }
    );

    await requestJson(
      "paper trading order intent canary rollback dry run",
      "/api/paper-trading/order-intent-tuning/canary/rollback",
      {
        method: "POST",
        token,
        body: { dry_run: true },
        expect: (json) => {
          assertApiSuccess(
            json,
            "paper trading order intent canary rollback dry run"
          );
          if (!json.data || !Array.isArray(json.data.changes)) {
            throw new Error(
              `paper trading order intent canary rollback payload invalid: ${preview(
                json
              )}`
            );
          }
          if (json.data.dry_run !== true || json.data.applied === true) {
            throw new Error(
              `paper trading order intent canary rollback must be read-only dry run: ${preview(
                json.data
              )}`
            );
          }
          if (!json.data.confirm_text) {
            throw new Error(
              `paper trading order intent canary rollback confirm text missing: ${preview(
                json.data
              )}`
            );
          }
        },
      }
    );

    if (includeExternal) {
      await requestJson("TradingAgents health", "/api/ai/health", {
        token,
        critical: false,
        expect: (json) => assertApiSuccess(json, "TradingAgents health"),
      });
    } else {
      skip(
        "TradingAgents health",
        "set SMOKE_INCLUDE_EXTERNAL=true to include remote health probe"
      );
    }
  }

  const passed = results.filter((item) => item.status === "pass").length;
  const failed = results.filter((item) => item.status === "fail").length;
  const skipped = results.filter((item) => item.status === "skip").length;
  const criticalFailed = results.filter(
    (item) => item.status === "fail" && item.critical
  ).length;
  const optionalFailed = failed - criticalFailed;

  const summary = {
    success: criticalFailed === 0,
    base_url: baseUrl,
    passed,
    failed,
    critical_failed: criticalFailed,
    optional_failed: optionalFailed,
    skipped,
    timeout_ms: timeoutMs,
  };
  writeJsonSummary({ summary, results });

  console.log("\n" + JSON.stringify(summary, null, 2));

  if (criticalFailed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(color.red("[FATAL]"), error);
  process.exit(1);
});
