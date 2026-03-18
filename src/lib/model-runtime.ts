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

type ParsedEmbeddings = {
  embeddings?: number[][];
  data?: Array<{ embedding?: number[] }>;
};

export type EmbeddingResult = {
  embeddings: number[][];
  modelId: string;
};

const PROJECT_REQUIRED_FOUNDRY_MODELS = [
  'nomic-embed-text-v1',
  'phi-4-mini-reasoning',
  'phi-4-reasoning',
  'phi-4',
  'phi-3.5-mini',
];

const DEFAULT_FOUNDRY_EMBEDDING_MODELS = [
  process.env.FOUNDRY_EMBEDDING_MODEL?.trim() || '',
  'nomic-embed-text-v1',
  'text-embedding-nomic-embed-text-v1.5',
  'nomic-embed-text-v1.5',
];

const DEFAULT_EMBEDDING_MODEL_BY_RUNTIME: Record<RuntimeName, string> = {
  foundry: 'nomic-embed-text-v1',
  lmstudio: 'text-embedding-nomic-embed-text-v1.5',
};

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map(item => item.trim()).filter(Boolean)));
}

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
  const embeddingCandidates = uniqueNonEmpty(DEFAULT_FOUNDRY_EMBEDDING_MODELS).map(normalizeKey);
  const embeddingAvailable = installedFolders.some(folder =>
    embeddingCandidates.some(modelNorm => folder.includes(modelNorm)),
  );

  return PROJECT_REQUIRED_FOUNDRY_MODELS.map(modelId => {
    const modelNorm = normalizeKey(modelId);
    const downloaded =
      modelId === 'nomic-embed-text-v1'
        ? embeddingAvailable
        : installedFolders.some(folder => folder.includes(modelNorm));

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
  lmstudio: 'qwen/qwen3-vl-8b',
};

const LMSTUDIO_DEFAULT_BASE_URL = 'http://127.0.0.1:1234';

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

export function getDefaultEmbeddingModel(runtime: RuntimeName): string {
  return DEFAULT_EMBEDDING_MODEL_BY_RUNTIME[runtime];
}

export async function getEmbeddingsWithModel(
  runtime: RuntimeName,
  texts: string[],
  embeddingModelId?: string,
): Promise<EmbeddingResult> {
  if (runtime === 'lmstudio') {
    const lmModel = embeddingModelId?.trim() || getDefaultEmbeddingModel('lmstudio');
    const embeddings = await getLmStudioEmbeddings(texts, lmModel);
    return { embeddings, modelId: lmModel };
  }

  const payload = JSON.stringify({ texts });
  const modelCandidates = uniqueNonEmpty([
    embeddingModelId?.trim() || '',
    ...DEFAULT_FOUNDRY_EMBEDDING_MODELS,
  ]);
  const errors: string[] = [];

  for (const modelId of modelCandidates) {
    const result = await runCommandWithInput(
      FOUNDRY_BINARIES[0],
      ['model', 'run', modelId],
      payload,
    );

    if (!result.ok) {
      errors.push(`${modelId}: ${result.stderr.trim() || 'failed'}`);
      continue;
    }

    try {
      return {
        embeddings: parseEmbeddingsOutput(result.stdout),
        modelId,
      };
    } catch (error) {
      errors.push(
        `${modelId}: parse failed (${error instanceof Error ? error.message : 'invalid output'})`,
      );
    }
  }

  const lmFallbackCandidates = uniqueNonEmpty([
    embeddingModelId?.trim() || '',
    getDefaultEmbeddingModel('lmstudio'),
  ]);
  const lmErrors: string[] = [];

  for (const lmModel of lmFallbackCandidates) {
    try {
      const embeddings = await getLmStudioEmbeddings(texts, lmModel);
      return { embeddings, modelId: lmModel };
    } catch (error) {
      lmErrors.push(`${lmModel}: ${error instanceof Error ? error.message : 'unknown LM Studio error'}`);
    }
  }

  throw new Error(
    [
      `Failed to get embeddings from Foundry. Tried: ${modelCandidates.join(', ')}`,
      'Download one of these models and retry.',
      ...modelCandidates.map(modelId => `- foundry model download ${modelId}`),
      `Foundry details: ${errors.join(' | ')}`,
      `LM Studio fallback failed: ${lmErrors.join(' | ')}`,
    ].join('\n'),
  );
}

export async function getEmbeddings(
  runtime: RuntimeName,
  texts: string[],
  embeddingModelId?: string,
): Promise<number[][]> {
  const result = await getEmbeddingsWithModel(runtime, texts, embeddingModelId);
  return result.embeddings;
}

function getLmStudioBaseUrl(): string {
  return (process.env.LMSTUDIO_BASE_URL?.trim() || LMSTUDIO_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function parseEmbeddingsOutput(stdout: string): number[][] {
  const parsed = JSON.parse(stdout) as ParsedEmbeddings;
  const fromDirect = parsed.embeddings;
  if (Array.isArray(fromDirect) && fromDirect.every(item => Array.isArray(item))) {
    return fromDirect;
  }

  const fromData = parsed.data?.map(item => item.embedding).filter(
    (item): item is number[] => Array.isArray(item),
  );
  if (fromData && fromData.length > 0) {
    return fromData;
  }

  throw new Error('Invalid embeddings format from model.');
}

async function getLmStudioEmbeddings(
  texts: string[],
  embeddingModelId: string,
): Promise<number[][]> {
  const modelId = embeddingModelId.trim();
  const errors: string[] = [];

  try {
    const base = getLmStudioBaseUrl();
    const response = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        input: texts,
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 240)}`);
    }

    return parseEmbeddingsOutput(raw);
  } catch (error) {
    errors.push(`LM Studio HTTP API failed (${error instanceof Error ? error.message : 'unknown error'})`);
  }

  const payload = JSON.stringify({ texts });
  const attempts: Attempt[] = LMSTUDIO_BINARIES.flatMap(cmd => [
    { cmd, args: ['run', modelId], label: `${cmd} run` },
    { cmd, args: ['remote', 'run', modelId], label: `${cmd} remote run` },
  ]);

  for (const attempt of attempts) {
    const result = await runCommandWithInput(attempt.cmd, attempt.args, payload);
    if (!result.ok) {
      errors.push(`${attempt.label} -> ${result.stderr.trim() || 'failed'}`);
      continue;
    }

    try {
      return parseEmbeddingsOutput(result.stdout);
    } catch (error) {
      errors.push(`${attempt.label} parse -> ${error instanceof Error ? error.message : 'unknown parse error'}`);
    }
  }

  throw new Error(`Failed to get embeddings: ${errors.join(' | ')}`);
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
  if (args.runtime === 'lmstudio') {
    return generateWithLmStudio(modelId, args.prompt, args.timeoutMs ?? 45_000);
  }

  const result = await runCommandWithInput(
    FOUNDRY_BINARIES[0],
    ['model', 'run', modelId],
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

async function generateWithLmStudio(
  modelId: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const errors: string[] = [];

  try {
    const base = getLmStudioBaseUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 240)}`);
    }

    const text = extractGeneratedText(raw);
    if (!text) {
      throw new Error('Empty completion payload');
    }
    return text;
  } catch (error) {
    errors.push(`LM Studio HTTP API failed (${error instanceof Error ? error.message : 'unknown error'})`);
  }

  const attempts: Attempt[] = LMSTUDIO_BINARIES.flatMap(cmd => [
    { cmd, args: ['run', modelId], label: `${cmd} run` },
    { cmd, args: ['remote', 'run', modelId], label: `${cmd} remote run` },
  ]);

  for (const attempt of attempts) {
    const result = await runCommandWithInput(attempt.cmd, attempt.args, prompt, timeoutMs);
    if (!result.ok) {
      errors.push(`${attempt.label} -> ${result.stderr.trim() || 'failed'}`);
      continue;
    }

    const text = extractGeneratedText(result.stdout);
    if (text) return text;
    errors.push(`${attempt.label} -> empty response`);
  }

  throw new Error(errors.join(' | '));
}
