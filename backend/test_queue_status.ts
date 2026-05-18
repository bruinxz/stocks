import { dataUpdateWorker } from './src/jobs/dataUpdateWorker';
dataUpdateWorker.getQueueStatus().then(console.log).catch(console.error).finally(() => process.exit(0));
