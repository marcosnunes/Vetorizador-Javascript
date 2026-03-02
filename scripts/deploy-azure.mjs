import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

const cliArgs = process.argv.slice(2);
const envArgIndex = cliArgs.findIndex((arg) => arg === '--env');
const envName = envArgIndex >= 0 && cliArgs[envArgIndex + 1]
  ? cliArgs[envArgIndex + 1]
  : 'production';

const tokenArgIndex = cliArgs.findIndex((arg) => arg === '--token');
const tokenFromArg = tokenArgIndex >= 0 && cliArgs[tokenArgIndex + 1]
  ? cliArgs[tokenArgIndex + 1]
  : '';

const token = tokenFromArg
  || process.env.AZURE_STATIC_WEB_APPS_DEPLOYMENT_TOKEN
  || process.env.SWA_DEPLOYMENT_TOKEN
  || '';

if (!token) {
  console.error('❌ Missing deployment token. Set AZURE_STATIC_WEB_APPS_DEPLOYMENT_TOKEN (or SWA_DEPLOYMENT_TOKEN), or pass --token <value>.');
  process.exit(1);
}

console.log('📦 Building project...');
run('npm', ['run', 'build']);

console.log(`🚀 Deploying to Azure Static Web Apps (${envName})...`);
run('npx', [
  '@azure/static-web-apps-cli',
  'deploy',
  './dist',
  '--api-location',
  './api',
  '--api-language',
  'node',
  '--api-version',
  '20',
  '--env',
  envName,
  '--deployment-token',
  token
]);

console.log('✅ Azure deployment finished.');
