#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'infra', 'build');
const SERVICES = ['ingest', 'detect', 'dispatch', 'confirm', 'api'];

async function buildOne(svc) {
  const entry = path.join(ROOT, 'services', svc, 'handler.js');
  const outdir = path.join(BUILD_DIR, svc);
  const zipPath = path.join(BUILD_DIR, `${svc}.zip`);

  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
  fs.rmSync(zipPath, { force: true });

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(outdir, 'handler.js'),
    external: [
      '@aws-sdk/*',     // provided by Lambda runtime
      'pg-native',      // optional native binding for `pg`, not used
      'cloudflare:*',   // pg's Cloudflare Workers shim — runtime detect, safe to drop
    ],
    logLevel: 'warning',
  });

  zipDir(outdir, zipPath);

  const sizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`  ✓ infra/build/${svc}.zip  (${sizeKb} KB)`);
}

function zipDir(srcDir, zipPath) {
  if (process.platform === 'win32') {
    // Windows fallback — useful for sanity-checking on dev machines.
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    // Cloud9 / Linux / Mac
    execSync(`cd "${srcDir}" && zip -q -r "${zipPath}" .`, { stdio: 'inherit' });
  }
}

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  console.log(`Building Lambda packages → infra/build/`);
  for (const svc of SERVICES) {
    await buildOne(svc);
  }
}

main().catch((err) => { console.error('build failed:', err); process.exit(1); });
