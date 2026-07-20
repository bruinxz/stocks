#!/usr/bin/env node

/**
 * Verify AI recommendation performance endpoints.
 *
 * Usage:
 *   API_BASE_URL=http://127.0.0.1:3000/api \
 *   ADMIN_TOKEN=... \
 *   node scripts/tests/verify_recommendation_performance_api.js
 *
 * For local/remote diagnostics only. It does not create data by default.
 */

const assert = require('assert');

function loadJsonWebToken() {
  try {
    return require('jsonwebtoken');
  } catch (error) {
    return require('../../backend/node_modules/jsonwebtoken');
  }
}

const jwt = loadJsonWebToken();

const apiBaseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api';
const token =
  process.env.ADMIN_TOKEN ||
  (process.env.JWT_SECRET
    ? jwt.sign(
        {
          user_id: Number(process.env.ADMIN_USER_ID || 1),
          username: process.env.ADMIN_USERNAME || 'admin',
          role: 'admin',
          type: 'access',
        },
        process.env.JWT_SECRET,
        {
          algorithm: 'HS256',
          issuer: 'stocks-backend',
          audience: 'stocks-api',
          expiresIn: '10m',
        }
      )
    : '');

if (!token) {
  console.error('ADMIN_TOKEN or JWT_SECRET is required');
  process.exit(1);
}

async function requestJson(path, options = {}) {
  const normalizedBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(normalizedPath, normalizedBaseUrl).toString();
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Non-JSON response ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || json.success !== true) {
    throw new Error(`API failed ${response.status}: ${JSON.stringify(json).slice(0, 800)}`);
  }
  return json;
}

(async () => {
  const dashboardResponse = await requestJson('/ai/signals/performance?horizon=5d');
  const dashboard = dashboardResponse.data;
  assert.ok(dashboard, 'dashboard missing');
  assert.ok(dashboard.overview, 'overview missing');
  assert.ok(Array.isArray(dashboard.horizon_summary), 'horizon_summary should be array');
  assert.ok(Array.isArray(dashboard.by_decision), 'by_decision should be array');
  assert.ok(Array.isArray(dashboard.recent_signals), 'recent_signals should be array');
  assert.ok(Array.isArray(dashboard.equity_curve), 'equity_curve should be array');

  const refreshResponse = await requestJson('/ai/signals/performance/refresh', {
    method: 'POST',
    body: JSON.stringify({ limit: 20 }),
  });
  assert.ok(refreshResponse.data?.verification, 'refresh verification missing');
  assert.ok(refreshResponse.data?.dashboard?.overview, 'refresh dashboard overview missing');

  console.log(
    JSON.stringify(
      {
        success: true,
        apiBaseUrl,
        overview: dashboard.overview,
        horizon_summary: dashboard.horizon_summary,
        refresh: refreshResponse.data.verification,
      },
      null,
      2
    )
  );
})().catch(error => {
  console.error(error);
  process.exit(1);
});
