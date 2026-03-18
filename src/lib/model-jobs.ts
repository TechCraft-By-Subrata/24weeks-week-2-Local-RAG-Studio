import { spawn } from 'node:child_process';
import { getDownloadCommands, runCommand, type RuntimeName } from './model-runtime';

export type ModelDownloadJob = {
  id: string;
  runtime: RuntimeName;
  modelId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  log: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  commandLabel?: string;
};

const jobs = new Map<string, ModelDownloadJob>();

const MAX_RUNTIME_MS = 30 * 60 * 1000;
const STALL_TIMEOUT_MS = 90 * 1000;

function genId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function modelIdsMatch(a: string, b: string): boolean {
  const left = normalizeModelKey(a);
  const right = normalizeModelKey(b);
  return left === right || left.includes(right) || right.includes(left);
}

function parseFoundryModelAliases(stdout: string): string[] {
  const aliases = new Set<string>();
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('Alias') || /^[-]{3,}$/.test(trimmed)) continue;
    const firstCell = line.slice(0, 30).trim();
    if (!firstCell) continue;
    aliases.add(firstCell);
  }
  return Array.from(aliases);
}

async function isFoundryModelInCatalog(modelId: string): Promise<boolean | null> {
  const checks = ['foundry', '/opt/homebrew/bin/foundry', '/usr/local/bin/foundry'];
  for (const cmd of checks) {
    const result = await runCommand(cmd, ['model', 'list'], 12_000);
    if (!result.ok) continue;
    const aliases = parseFoundryModelAliases(result.stdout);
    if (aliases.length === 0) return null;
    return aliases.some(alias => modelIdsMatch(alias, modelId));
  }

  return null;
}

function extractProgress(log: string): number | null {
  const matches = log.match(/(\d{1,3})%/g);
  if (!matches || matches.length === 0) return null;

  const last = matches[matches.length - 1].replace('%', '');
  const parsed = Number(last);
  if (Number.isNaN(parsed)) return null;

  return Math.max(0, Math.min(parsed, 99));
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function appendLog(job: ModelDownloadJob, chunk: unknown) {
  job.log += String(chunk);
  if (job.log.length > 30_000) {
    job.log = job.log.slice(job.log.length - 30_000);
  }

  const parsedProgress = extractProgress(job.log);
  if (parsedProgress !== null) {
    job.progress = parsedProgress;
  }

  job.updatedAt = Date.now();
}

function runAttempt(
  job: ModelDownloadJob,
  command: string,
  args: string[],
): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const startedAt = Date.now();
    let lastOutputAt = Date.now();
    let finished = false;

    const finish = (status: 'completed' | 'failed', error?: string) => {
      if (finished) return;
      finished = true;
      clearInterval(healthCheck);
      clearTimeout(hardTimeout);
      job.status = status;
      job.progress = status === 'completed' ? 100 : job.progress;
      job.updatedAt = Date.now();
      if (error) job.error = error;
      resolve(status === 'completed');
    };

    const hardTimeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(
        'failed',
        'Download exceeded maximum allowed time. Please retry or use manual download commands from docs section.',
      );
    }, MAX_RUNTIME_MS);

    const healthCheck = setInterval(() => {
      const now = Date.now();
      if (now - lastOutputAt > STALL_TIMEOUT_MS) {
        child.kill('SIGTERM');
        finish(
          'failed',
          'Download stalled with no output for 90s. Please run manual download and then click Refresh Installed Models.',
        );
        return;
      }

      if (job.progress === 0 && now - startedAt > 1500) {
        job.progress = 1;
        job.updatedAt = now;
      }
    }, 2000);

    child.stdout.on('data', chunk => {
      lastOutputAt = Date.now();
      appendLog(job, chunk);
    });

    child.stderr.on('data', chunk => {
      lastOutputAt = Date.now();
      appendLog(job, chunk);
    });

    child.on('error', error => {
      finish('failed', error.message);
    });

    child.on('close', code => {
      if (code === 0) {
        finish('completed');
      } else {
        const error =
          job.log.trim() ||
          `Command exited with code ${String(code ?? -1)}. Try manual download and refresh.`;
        finish('failed', error);
      }
    });
  });
}

export function startDownloadJob(runtime: RuntimeName, modelId: string) {
  const existing = Array.from(jobs.values()).find(
    job =>
      job.runtime === runtime &&
      job.modelId === modelId &&
      (job.status === 'queued' || job.status === 'running'),
  );

  if (existing) return existing;

  const job: ModelDownloadJob = {
    id: genId(),
    runtime,
    modelId,
    status: 'queued',
    progress: 0,
    log: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobs.set(job.id, job);

  void (async () => {
    if (runtime === 'foundry') {
      const found = await isFoundryModelInCatalog(modelId);
      if (found === false) {
        job.status = 'failed';
        job.error = [
          `Model "${modelId}" is not available in your Foundry catalog.`,
          'Use LM Studio for embedding models (for example: text-embedding-nomic-embed-text-v1.5).',
        ].join(' ');
        job.updatedAt = Date.now();
        return;
      }
    }

    const attempts = getDownloadCommands(runtime, modelId);

    for (const attempt of attempts) {
      job.status = 'running';
      job.progress = 0;
      job.commandLabel = attempt.label;
      job.log = `Running: ${attempt.command} ${attempt.args.join(' ')}\n`;
      job.error = undefined;
      job.updatedAt = Date.now();

      const completed = await runAttempt(job, attempt.command, attempt.args);
      if (completed) return;

      job.log += `\nAttempt failed using ${attempt.label}. Trying next fallback...\n`;
      job.updatedAt = Date.now();
    }

    job.status = 'failed';
    job.error =
      job.error ||
      'All automatic download command attempts failed. Please use manual command and then refresh models.';
    job.updatedAt = Date.now();
  })();

  return job;
}
