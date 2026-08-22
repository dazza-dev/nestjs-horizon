import { client, type Suite } from './harness';
import { run as reporting } from './reporting';
import { run as tags } from './tags';
import { run as robustness } from './robustness';
import { run as commands } from './commands';
import { run as board } from './board';
import { run as cluster } from './cluster';
import { run as batches } from './batches';
import { run as resilience } from './resilience';
import { run as asyncBoot } from './async';

const suites = [
  reporting,
  tags,
  batches,
  robustness,
  resilience,
  commands,
  asyncBoot,
  board,
  cluster,
];

const green = (text: string): string => `[32m${text}[0m`;
const red = (text: string): string => `[31m${text}[0m`;
const dim = (text: string): string => `[2m${text}[0m`;
const yellow = (text: string): string => `[33m${text}[0m`;

async function requireRedis(): Promise<void> {
  const redis = client();

  try {
    await redis.ping();
  } catch {
    console.error(
      'These are integration tests and need a Redis on REDIS_HOST/REDIS_PORT.\n' +
        'They write to REDIS_TEST_DB (15 by default) and clean up after themselves.',
    );
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  await requireRedis();

  const done: Suite[] = [];

  // Sequential, never parallel: the suites run real workers against one shared Redis.
  for (const suite of suites) {
    done.push(await suite());
  }

  let failed = 0;

  for (const suite of done) {
    console.log(`\n${suite.name}`);

    for (const result of suite.results) {
      const mark = result.skipped ? yellow('  ○') : result.ok ? green('  ✓') : red('  ✗');
      const detail = result.detail ? dim(` — ${result.detail}`) : '';

      console.log(`${mark} ${result.label}${detail}`);
    }

    failed += suite.failed;
  }

  const total = done.reduce((count, suite) => count + suite.results.length, 0);
  const skipped = done.reduce((count, suite) => count + suite.skipped, 0);

  // Skips get their own count. A check that never ran is not a pass.
  const parts = [green(`${total - failed - skipped} passing`)];

  if (skipped) {
    parts.push(yellow(`${skipped} skipped`));
  }

  if (failed) {
    parts.push(red(`${failed} failing`));
  }

  console.log(`\n${parts.join(', ')}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

void main();
