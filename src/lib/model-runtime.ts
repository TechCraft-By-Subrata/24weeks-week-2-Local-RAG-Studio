import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type RuntimeName = 'foundry' | 'lmstudio';

export type RuntimeModel = {
  id: string;
  provider: RuntimeName;
  downloaded: boolean;
  size?: string;
  source?: string;
};

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
};

export type DownloadCommand = {
  command: string;
  args: string[];
  label: string;
};

type Attempt = {
  cmd: string;
  args: string[];
  label: string;
};

const PROJECT_REQUIRED_FOUNDRY_MODELS = [
  'nomic-embed-text-v1',
  'phi-4-mini-reasoning',
  'phi-4-reasoning',
  'phi-4',
  'phi-3.5-mini',
];

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 12_000,
): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        ok: false,
        stdout,
        stderr,
        code: -1,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    child.on('error', err => {
      clearTimeout(timeout);
      finish({
        ok: false,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        code: -1,
        timedOut: false,
      });
    });

    child.on('close', code => {
      clearTimeout(timeout);
      finish({
        ok: code === 0,
        stdout,
        stderr,
        code: code ?? -1,
        timedOut: false,
      });
    });
  });
}

function parseLmStudioModels(stdout: string): RuntimeModel[] {
  try {
    const parsed = JSON.parse(stdout) as Array<{
      modelKey?: string;
      displayName?: string;
      path?: string;
      size?: string;
    }>;

    return parsed
      .map(item => ({
        id: item.modelKey || item.displayName || item.path || 'unknown-model',
        provider: 'lmstudio' as const,
        downloaded: true,
        size: item.size,
        source: item.path,
      }))
      .filter(item => item.id !== 'unknown-model');
  } catch {
    return [];
  }
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getFoundryInstalledFolderNames(): string[] {
  const base = join(homedir(), '.foundry', 'cache', 'models');
  if (!existsSync(base)) return [];

  const providers = readdirSync(base, { withFileTypes: true }).filter(
    entry => entry.isDirectory(),
  );

  const folders: string[] = [];
  for (const provider of providers) {
    const providerPath = join(base, provider.name);
    const models = readdirSync(providerPath, { withFileTypes: true }).filter(
      entry => entry.isDirectory(),
    );
    for (const model of models) {
      folders.push(model.name);
    }
  }

  return folders;
}

function listProjectRequiredFoundryModels(): RuntimeModel[] {
  const installedFolders = getFoundryInstalledFolderNames().map(normalizeKey);

  return PROJECT_REQUIRED_FOUNDRY_MODELS.map(modelId => {
    const modelNorm = normalizeKey(modelId);
    const downloaded = installedFolders.some(folder => folder.includes(modelNorm));

    return {
      id: modelId,
      provider: 'foundry' as const,
      downloaded,
    };
  });
}

const FOUNDRY_BINARIES = [
  'foundry',
  '/opt/homebrew/bin/foundry',
  '/usr/local/bin/foundry',
];

const LMSTUDIO_BINARIES = [
  'lms',
  '/Users/kin_macpro/.lmstudio/bin/lms',
  '/opt/homebrew/bin/lms',
];

const DEFAULT_CHAT_MODEL_BY_RUNTIME: Record<RuntimeName, string> = {
  foundry: 'phi-4-mini-reasoning',
  lmstudio: 'qwen2.5-7b-instruct',
};

export async function listModels(runtime: RuntimeName): Promise<{
  models: RuntimeModel[];
  warning?: string;
}> {
  if (runtime === 'foundry') {
    const models = listProjectRequiredFoundryModels();
    return { models };
  }

  if (runtime === 'lmstudio') {
    const attempts: Attempt[] = LMSTUDIO_BINARIES.map(cmd => ({
      cmd,
      args: ['ls', '--json'],
      label: `${cmd} ls --json`,
    }));
    const diagnostics: string[] = [];

    for (const attempt of attempts) {
      const result = await runCommand(attempt.cmd, attempt.args, 10_000);
      if (!result.ok) {
        diagnostics.push(
          `${attempt.label} -> ${result.timedOut ? 'timeout' : result.stderr.trim() || 'failed'}`,
        );
        continue;
      }

      const models = parseLmStudioModels(result.stdout);
      if (models.length > 0) return { models };
    }

    return {
      models: [],
      warning: `LM Studio model listing failed. ${diagnostics.join(' | ')}`,
    };
  }

  return {
    models: [],
    warning: 'Unknown runtime selected.',
  };
}

export function getDownloadCommands(
  runtime: RuntimeName,
  modelId: string,
): DownloadCommand[] {
  if (runtime === 'lmstudio') {
    return LMSTUDIO_BINARIES.map(command => ({
      command,
      args: ['get', modelId, '--yes'],
      label: `${command} get --yes`,
    }));
  }

  return [
    ...FOUNDRY_BINARIES.map(command => ({
      command,
      args: ['model', 'download', modelId, '--yes'],
      label: `${command} model download --yes`,
    })),
    ...FOUNDRY_BINARIES.map(command => ({
      command,
      args: ['model', 'download', modelId],
      label: `${command} model download`,
    })),
    ...FOUNDRY_BINARIES.map(command => ({
      command,
      args: ['models', 'download', modelId],
      label: `${command} models download`,
    })),
  ];
}

export { runCommand };

async function runCommandWithInput(
  command: string,
  args: string[],
  input: string,
  timeoutMs = 15_000,
): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, stdout, stderr, code: -1, timedOut: true });
    }, timeoutMs);

    child.stdin.write(input);
    child.stdin.end();

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    child.on('error', err => {
      clearTimeout(timeout);
      finish({ ok: false, stdout, stderr: `${stderr}\n${err.message}`, code: -1, timedOut: false });
    });

    child.on('close', code => {
      clearTimeout(timeout);
      finish({ ok: code === 0, stdout, stderr, code: code ?? -1, timedOut: false });
    });
  });
}

export async function getEmbeddings(runtime: RuntimeName, texts: string[]): Promise<number[][]> {
  const modelId = runtime === 'lmstudio' ? 'text-embedding-nomic-embed-text-v1.5' : 'nomic-embed-text-v1';
  const payload = JSON.stringify({ texts });

  const binaryPath = runtime === 'lmstudio' ? LMSTUDIO_BINARIES[0] : FOUNDRY_BINARIES[0];
  const args = runtime === 'lmstudio' ? ['remote', 'run', modelId] : ['model', 'run', modelId];

  const result = await runCommandWithInput(binaryPath, args, payload);

  if (!result.ok) {
    throw new Error(`Failed to get embeddings: ${result.stderr}`);
  }

  try {
    const parsed = JSON.parse(result.stdout) as { embeddings: number[][] };
    if (!parsed.embeddings || !Array.isArray(parsed.embeddings)) {
      throw new Error('Invalid embeddings format from model.');
    }
    return parsed.embeddings;
  } catch (e) {
    throw new Error(`Failed to parse embeddings output: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }
}

function extractGeneratedText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed) as
      | { output?: string; text?: string; response?: string; content?: string; choices?: Array<{ text?: string; message?: { content?: string } }> }
      | Array<{ output?: string; text?: string; response?: string; content?: string }>;

    if (Array.isArray(parsed)) {
      const first = parsed[0];
      return (first?.output || first?.text || first?.response || first?.content || '').trim();
    }

    const choiceText = parsed.choices?.[0]?.message?.content || parsed.choices?.[0]?.text;
    return (choiceText || parsed.output || parsed.text || parsed.response || parsed.content || '').trim();
  } catch {
    return trimmed;
  }
}

export function getDefaultChatModel(runtime: RuntimeName): string {
  return DEFAULT_CHAT_MODEL_BY_RUNTIME[runtime];
}

export async function generateGroundedAnswer(args: {
  runtime: RuntimeName;
  modelId?: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<string> {
  const modelId = args.modelId?.trim() || getDefaultChatModel(args.runtime);
  const binaryPath = args.runtime === 'lmstudio' ? LMSTUDIO_BINARIES[0] : FOUNDRY_BINARIES[0];
  const commandArgs =
    args.runtime === 'lmstudio'
      ? ['remote', 'run', modelId]
      : ['model', 'run', modelId];

  const result = await runCommandWithInput(
    binaryPath,
    commandArgs,
    args.prompt,
    args.timeoutMs ?? 45_000,
  );

  if (!result.ok) {
    throw new Error(result.stderr.trim() || `Generation failed with code ${result.code}`);
  }

  const text = extractGeneratedText(result.stdout);
  if (!text) {
    throw new Error('Model returned an empty response.');
  }

  return text;
}
