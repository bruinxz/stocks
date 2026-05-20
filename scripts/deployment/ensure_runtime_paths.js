const path = require('path');
const { shellQuote } = require('./deploy_config');

function buildEnsureRuntimePathsCommand(remoteRoot, options = {}) {
  const backendUser = options.backendUser || process.env.DEPLOY_BACKEND_OWNER || 'stocks_app';
  const backendGroup = options.backendGroup || process.env.DEPLOY_BACKEND_GROUP || 'stocks';
  const root = remoteRoot || '/opt/stocks';
  const sharedUploads = path.posix.join(root, 'shared', 'uploads');
  const sharedAvatars = path.posix.join(sharedUploads, 'avatars');

  return `
set -e
mkdir -p ${shellQuote(sharedAvatars)}
if command -v chown >/dev/null 2>&1; then
  chown -R ${shellQuote(`${backendUser}:${backendGroup}`)} ${shellQuote(sharedUploads)} 2>/dev/null || true
fi
if command -v chmod >/dev/null 2>&1; then
  chmod -R u+rwX,g+rwX ${shellQuote(sharedUploads)} 2>/dev/null || true
fi
echo "runtime-paths-ready:${sharedAvatars}"
`.trim();
}

module.exports = {
  buildEnsureRuntimePathsCommand,
};
