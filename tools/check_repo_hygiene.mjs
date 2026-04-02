import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitLsFiles() {
  const output = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function assertClean(tracked, predicate, message) {
  const offenders = tracked.filter(predicate);
  if (offenders.length) {
    throw new Error(`${message}\n${offenders.join('\n')}`);
  }
}

function containsPrivateAbsolutePath(text) {
  const patterns = [
    /[A-Za-z]:\\Users\\(?!<user>)[^\\\r\n]+\\/,
    /\/home\/(?!<user>)[^\/\s]+(?:\/|$)/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function main() {
  const tracked = gitLsFiles().filter((entry) => fs.existsSync(path.join(repoRoot, entry)));

  assertClean(tracked, (entry) => entry.startsWith('mjwp_inject/overlay/'), 'Tracked overlay mirror is forbidden.');
  assertClean(tracked, (entry) => entry === 'index.html' || entry === 'embed.html', 'Legacy standalone pages are forbidden.');
  assertClean(tracked, (entry) => entry.startsWith('app/'), 'Legacy standalone app shell is forbidden.');
  assertClean(tracked, (entry) => entry.startsWith('backend/'), 'Legacy standalone backend proxy is forbidden.');
  assertClean(tracked, (entry) => entry.startsWith('renderer/'), 'Legacy standalone renderer is forbidden.');
  assertClean(tracked, (entry) => entry.startsWith('ui/'), 'Legacy standalone UI store is forbidden.');
  assertClean(tracked, (entry) => entry.startsWith('demo_assets/'), 'Low-poly demo assets are forbidden.');
  assertClean(tracked, (entry) => entry === 'tools/build_demo_bundle.py', 'Legacy demo bundle builder is forbidden.');
  assertClean(tracked, (entry) => entry === 'tools/browser_smoke.py', 'Legacy standalone browser smoke is forbidden.');
  assertClean(tracked, (entry) => entry === 'tools/dev_server.py', 'Legacy standalone dev server is forbidden.');
  assertClean(tracked, (entry) => entry === 'tools/export_site.py', 'Legacy site exporter is forbidden.');
  assertClean(tracked, (entry) => entry === 'tools/site_release_check.py', 'Legacy site release checker is forbidden.');
  assertClean(tracked, (entry) => entry === 'doc/integration/play_split_recovery_audit.md', 'Split-recovery audit doc must stay local-only.');
  assertClean(tracked, (entry) => entry === 'doc/integration/mhr_backend_perf_investigation.md', 'Perf investigation doc must stay local-only.');
  assertClean(tracked, (entry) => entry === 'tests/tooling/full_cpu_stage_oracle.test.mjs', 'Deep stage-oracle test must stay out of the shipped repo.');
  assertClean(tracked, (entry) => entry.startsWith('mjwp_inject/') && entry.includes('/assets/mhr_demo/'), 'Duplicated demo assets under mjwp_inject are forbidden.');
  assertClean(tracked, (entry) => entry.includes('__pycache__/'), 'Tracked __pycache__ artifacts are forbidden.');

  const textLike = tracked.filter((entry) => (
    /\.(?:md|mjs|js|json|py|ps1|html|css|xml|txt)$/i.test(entry)
    && !/\.gen\.mjs$/i.test(entry)
  ));
  const offenders = [];
  for (const relative of textLike) {
    const absolute = path.join(repoRoot, relative);
    const text = fs.readFileSync(absolute, 'utf8');
    if (containsPrivateAbsolutePath(text)) {
      offenders.push(relative);
    }
  }
  if (offenders.length) {
    throw new Error(`Tracked files still contain local private path fragments.\n${offenders.join('\n')}`);
  }

  console.log('Repo hygiene OK.');
}

main();
