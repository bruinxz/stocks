'use strict';

function requireLegacyDeploymentUnlock(scriptName) {
  if (process.env.ALLOW_LEGACY_DEPLOYMENT_SCRIPT === 'true') {
    return;
  }

  const label = scriptName || 'legacy deployment script';
  console.error(`[SAFE-GUARD] ${label} is a legacy deployment/maintenance script and is disabled by default.`);
  console.error('[SAFE-GUARD] Use scripts/deployment/sync_and_deploy.js or scripts/deployment/simple_deploy.js instead.');
  console.error('[SAFE-GUARD] If you must run it after source review, set ALLOW_LEGACY_DEPLOYMENT_SCRIPT=true explicitly.');
  process.exit(1);
}

module.exports = {
  requireLegacyDeploymentUnlock
};
