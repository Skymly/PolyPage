/**
 * Publish the native-host gateway for the current git HEAD and fail if the
 * published exe ProductVersion does not embed that commit.
 *
 * Used by test:contract and smoke so those suites cannot pass against a stale
 * PolyPage.Gateway.exe (M-17).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_CSPROJ = path.join(root, 'native-host/PolyPage.Gateway/PolyPage.Gateway.csproj');

export const DEFAULT_GATEWAY_EXE = path.join(
  root,
  'native-host/PolyPage.Gateway/bin/Release/net8.0/win-x64/publish/PolyPage.Gateway.exe',
);

export function gitHead(cwd = root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${(r.stderr || r.stdout).trim()}`);
  }
  const head = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error(`unexpected git HEAD: ${head}`);
  }
  return head;
}

export function readProductVersion(exePath) {
  const escaped = exePath.replace(/'/g, "''");
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(
      `failed to read ProductVersion of ${exePath}: ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r.stdout.trim();
}

export function commitFromProductVersion(productVersion) {
  const plus = productVersion.indexOf('+');
  if (plus < 0) return '';
  return productVersion.slice(plus + 1).trim();
}

export function assertGatewayCommit(exePath, expectedHead) {
  if (!existsSync(exePath)) {
    throw new Error(`gateway exe not found: ${exePath}`);
  }
  const productVersion = readProductVersion(exePath);
  const embedded = commitFromProductVersion(productVersion);
  if (embedded !== expectedHead) {
    throw new Error(
      `gateway ProductVersion commit mismatch:\n  exe ProductVersion: ${productVersion}\n  git rev-parse HEAD: ${expectedHead}`,
    );
  }
  console.log(`gateway ProductVersion ${productVersion} matches git HEAD`);
}

export function publishGateway(expectedHead = gitHead()) {
  console.log(`dotnet publish PolyPage.Gateway (Release/win-x64) for ${expectedHead}`);
  const r = spawnSync(
    'dotnet',
    [
      'publish',
      GATEWAY_CSPROJ,
      '-c',
      'Release',
      '-r',
      'win-x64',
      `--property:SourceRevisionId=${expectedHead}`,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    const detail = `${r.stdout || ''}${r.stderr || ''}`.trim();
    throw new Error(`dotnet publish failed (exit ${r.status})${detail ? `:\n${detail}` : ''}`);
  }
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return expectedHead;
}

export function ensurePublishedGateway(exePath = DEFAULT_GATEWAY_EXE) {
  const head = gitHead();
  publishGateway(head);
  assertGatewayCommit(exePath, head);
  return exePath;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    ensurePublishedGateway();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
