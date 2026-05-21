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
 *   SMOKE_USERNAME=lym \
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
  process.env.SMOKE_USERNAME || process.env.ADMIN_USERNAME || "lym";
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

    await requestJson("market service health", "/api/market/health", {
      expect: (json) => {
        assertApiSuccess(json, "market service health");
        if (!json.data?.status)
          throw new Error(`market health status missing: ${preview(json)}`);
      },
    });

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
        if (Number(paramMaintenanceTask.parameters?.refresh_limit || 0) < 1000) {
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
            !json.data?.summary ||
            !Array.isArray(json.data?.suggestions || []) ||
            !json.data?.recommended_params_by_strategy
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
          if (
            !json.data?.summary ||
            !Array.isArray(json.data?.versions || []) ||
            !Array.isArray(json.data?.summary_by_version || [])
          ) {
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
      "strategy opening preflight",
      "/api/strategy-research/opening-preflight?factor_limit=80",
      {
        token,
        critical: false,
        expect: (json) => {
          assertApiSuccess(json, "strategy opening preflight");
          if (
            !json.data?.status ||
            !json.data?.summary ||
            !json.data?.checks?.quant_task ||
            !json.data?.checks?.factor_provider ||
            !json.data?.checks?.quote_sync_task
          ) {
            throw new Error(
              `strategy opening preflight payload invalid: ${preview(json)}`
            );
          }
        },
      }
    );

    await requestJson(
      "quant fusion audits",
      "/api/quant/fusion-audits?limit=5",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "quant fusion audits");
          assertArray(json.data, "quant fusion audits data");
        },
      }
    );

    await requestJson(
      "quant rankings dashboard",
      "/api/quant/rankings?limit=5",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "quant rankings dashboard");
          if (!json.data?.summary) {
            throw new Error(`quant rankings summary missing: ${preview(json)}`);
          }
          assertArray(json.data.quant_rankings || [], "quant rankings data");
          assertArray(
            json.data.fusion_rankings || [],
            "quant fusion rankings data"
          );
          if (json.data.summary.quote_persistence) {
            const quotePersistence = json.data.summary.quote_persistence;
            for (const key of [
              "latest_trade_date_snapshot_count",
              "latest_trade_date_symbol_count",
            ]) {
              if (
                quotePersistence[key] !== undefined &&
                !Number.isFinite(Number(quotePersistence[key]))
              ) {
                throw new Error(
                  `quote persistence ${key} invalid: ${preview(
                    quotePersistence
                  )}`
                );
              }
            }
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
      "recommendation trade outcomes",
      "/api/paper-trading/recommendation-outcomes?limit=5&include_open=false",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "recommendation trade outcomes");
          if (!json.data?.summary) {
            throw new Error(
              `recommendation outcome summary missing: ${preview(json)}`
            );
          }
        },
      }
    );

    await requestJson("AI signal stats", "/api/ai/signals/stats", {
      token,
      critical: false,
      expect: (json) => assertApiSuccess(json, "AI signal stats"),
    });

    await requestJson(
      "recommendation loop policy snapshots",
      "/api/ai/recommendations/loop-policy-snapshots?limit=5",
      {
        token,
        expect: (json) => {
          assertApiSuccess(json, "recommendation loop policy snapshots");
          if (!json.data?.summary || !Array.isArray(json.data?.snapshots)) {
            throw new Error(
              `loop policy snapshot payload missing: ${preview(json)}`
            );
          }
          const riskGateAnalysis = json.data?.risk_gate_analysis;
          if (riskGateAnalysis && riskGateAnalysis.field_gate_advice) {
            if (!Array.isArray(riskGateAnalysis.field_gate_advice.items)) {
              throw new Error(
                `field gate advice items missing: ${preview(riskGateAnalysis)}`
              );
            }
            if (!riskGateAnalysis.field_gate_advice.conclusion) {
              throw new Error(
                `field gate advice conclusion missing: ${preview(
                  riskGateAnalysis
                )}`
              );
            }
          }
          const fieldGateAttribution =
            json.data?.field_gate_adjustment_attribution;
          if (fieldGateAttribution) {
            if (
              !fieldGateAttribution.status ||
              !fieldGateAttribution.conclusion
            ) {
              throw new Error(
                `field gate adjustment attribution status/conclusion missing: ${preview(
                  fieldGateAttribution
                )}`
              );
            }
            for (const key of [
              "before_sample_count",
              "after_sample_count",
              "before_avg_excess_return_pct",
              "after_avg_excess_return_pct",
              "delta_pct",
            ]) {
              if (
                fieldGateAttribution[key] !== undefined &&
                !Number.isFinite(Number(fieldGateAttribution[key]))
              ) {
                throw new Error(
                  `field gate adjustment attribution ${key} invalid: ${preview(
                    fieldGateAttribution
                  )}`
                );
              }
            }
            if (fieldGateAttribution.windows !== undefined) {
              if (!Array.isArray(fieldGateAttribution.windows)) {
                throw new Error(
                  `field gate adjustment attribution windows invalid: ${preview(
                    fieldGateAttribution
                  )}`
                );
              }
              for (const item of fieldGateAttribution.windows) {
                if (
                  !Number.isFinite(Number(item.days)) ||
                  !Number.isFinite(Number(item.sample_count))
                ) {
                  throw new Error(
                    `field gate adjustment attribution window fields invalid: ${preview(
                      item
                    )}`
                  );
                }
              }
              if (fieldGateAttribution.decision !== undefined) {
                if (
                  !fieldGateAttribution.decision.action ||
                  !fieldGateAttribution.decision.reason
                ) {
                  throw new Error(
                    `field gate adjustment attribution decision invalid: ${preview(
                      fieldGateAttribution
                    )}`
                  );
                }
              }
            }
          }
          const promotion = json.data?.promotion;
          if (promotion?.field_gate_adjustment_attribution) {
            if (
              promotion.field_gate_adjustment_attribution.status !==
                fieldGateAttribution?.status ||
              !promotion.field_gate_adjustment_attribution.conclusion
            ) {
              throw new Error(
                `promotion field gate attribution inconsistent: ${preview(
                  promotion
                )}`
              );
            }
            if (
              promotion.field_gate_confidence_adjustment !== undefined &&
              !Number.isFinite(
                Number(promotion.field_gate_confidence_adjustment)
              )
            ) {
              throw new Error(
                `promotion field gate confidence invalid: ${preview(promotion)}`
              );
            }
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
