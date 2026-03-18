'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type RuntimeName = 'foundry' | 'lmstudio';

type RuntimeModel = {
  id: string;
  provider: RuntimeName;
  downloaded: boolean;
  size?: string;
  source?: string;
};

type ModelJob = {
  id: string;
  runtime: RuntimeName;
  modelId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  log: string;
  error?: string;
  updatedAt: number;
  commandLabel?: string;
};

type ModelResponse = {
  runtime: RuntimeName;
  models: RuntimeModel[];
  warning?: string;
  jobs: ModelJob[];
};

type IngestResponse = {
  success: boolean;
  documentsIndexed: number;
  chunksIndexed: number;
  skipped: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; message: string }>;
  message?: string;
};

type ChatResponse = {
  answer: string;
  citations: Array<{
    source: string;
    page: number | null;
    chunk_id: string;
    snippet: string;
    score: number;
  }>;
  retrieval: {
    topK: number;
    matched: number;
    latencyMs: number;
  };
  warnings?: string[];
};

type IndexedDocument = {
  source: string;
  chunks: number;
  lastIndexedAt: string | null;
  embeddingModels: string[];
};

type IndexedDocumentsResponse = {
  documents: IndexedDocument[];
  totals: {
    documentsIndexed: number;
    chunksIndexed: number;
  };
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citations?: ChatResponse['citations'];
  warnings?: string[];
  retrieval?: ChatResponse['retrieval'];
};

const SUGGESTED_LM_MODELS = [
  'qwen/qwen3-vl-8b',
  'qwen2.5-7b-instruct',
  'llama-3.1-8b-instruct',
  'qwen2.5-coder-7b-instruct',
];

const SUGGESTED_LM_EMBED_MODELS = [
  'text-embedding-nomic-embed-text-v1.5',
];

const SUGGESTED_FOUNDRY_EMBED_MODELS = [
  'nomic-embed-text-v1',
  'text-embedding-nomic-embed-text-v1.5',
  'nomic-embed-text-v1.5',
];

const SKIPPED_REASON_LABELS: Record<string, string> = {
  unsupported_mime_type: 'Unsupported file type',
  empty_text: 'No extractable text found (common with scanned/image-only PDFs)',
  no_chunks_generated: 'Text found, but no chunks were generated',
};

const STORAGE_KEYS = {
  runtime: 'ragstudio.runtime',
  modelId: 'ragstudio.modelId',
  embeddingRuntime: 'ragstudio.embeddingRuntime',
  embeddingModelId: 'ragstudio.embeddingModelId',
} as const;

async function parseApiResponse<T>(res: Response): Promise<T> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const snippet = raw.slice(0, 220).replace(/\s+/g, ' ').trim();
    throw new Error(
      `Server returned non-JSON response (${res.status} ${res.statusText}). ${snippet || 'No response body.'}`,
    );
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function makeMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function modelIdsMatch(a: string, b: string): boolean {
  const left = normalizeModelKey(a);
  const right = normalizeModelKey(b);
  return left === right || left.includes(right) || right.includes(left);
}

function isFoundryCatalogMissingError(value?: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower.includes('not available in your foundry catalog') ||
    lower.includes('not found in the catalog')
  );
}

export default function Week2LocalRag() {
  const [runtime, setRuntime] = useState<RuntimeName>('lmstudio');
  const [modelId, setModelId] = useState('qwen/qwen3-vl-8b');
  const [embeddingRuntime, setEmbeddingRuntime] = useState<RuntimeName>('lmstudio');
  const [embeddingModelId, setEmbeddingModelId] = useState('text-embedding-nomic-embed-text-v1.5');
  const [modelsByRuntime, setModelsByRuntime] = useState<Record<RuntimeName, RuntimeModel[]>>({
    foundry: [],
    lmstudio: [],
  });
  const [jobs, setJobs] = useState<ModelJob[]>([]);
  const [warning, setWarning] = useState<string | undefined>();
  const [loadingModels, setLoadingModels] = useState(false);

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [ingestResult, setIngestResult] = useState<IngestResponse | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);

  const [indexedDocuments, setIndexedDocuments] = useState<IndexedDocument[]>([]);
  const [totals, setTotals] = useState<{ documentsIndexed: number; chunksIndexed: number }>({
    documentsIndexed: 0,
    chunksIndexed: 0,
  });
  const [dbError, setDbError] = useState<string | null>(null);
  const [loadingDb, setLoadingDb] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);

  const [query, setQuery] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const chatLogRef = useRef<HTMLDivElement | null>(null);

  const chatModels = useMemo(() => modelsByRuntime[runtime] ?? [], [modelsByRuntime, runtime]);
  const embeddingModels = useMemo(
    () => modelsByRuntime[embeddingRuntime] ?? [],
    [modelsByRuntime, embeddingRuntime],
  );

  const selectedChatModelInfo = useMemo(
    () => chatModels.find(model => modelIdsMatch(model.id, modelId)),
    [chatModels, modelId],
  );
  const selectedEmbeddingModelInfo = useMemo(
    () => embeddingModels.find(model => modelIdsMatch(model.id, embeddingModelId)),
    [embeddingModels, embeddingModelId],
  );
  const isChatModelDownloaded = Boolean(selectedChatModelInfo?.downloaded);
  const isEmbeddingModelDownloaded = Boolean(selectedEmbeddingModelInfo?.downloaded);

  const activeChatJob = useMemo(
    () =>
      jobs.find(
        job =>
          job.runtime === runtime &&
          modelIdsMatch(job.modelId, modelId) &&
          (job.status === 'queued' || job.status === 'running'),
      ),
    [jobs, runtime, modelId],
  );

  const activeEmbeddingJob = useMemo(
    () =>
      jobs.find(
        job =>
          job.runtime === embeddingRuntime &&
          modelIdsMatch(job.modelId, embeddingModelId) &&
          (job.status === 'queued' || job.status === 'running'),
      ),
    [jobs, embeddingRuntime, embeddingModelId],
  );

  const latestChatJob = useMemo(
    () =>
      jobs
        .filter(job => job.runtime === runtime && modelIdsMatch(job.modelId, modelId))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [jobs, runtime, modelId],
  );

  const latestEmbeddingJob = useMemo(
    () =>
      jobs
        .filter(
          job =>
            job.runtime === embeddingRuntime &&
            modelIdsMatch(job.modelId, embeddingModelId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [jobs, embeddingRuntime, embeddingModelId],
  );

  const hasAnyActiveJob = useMemo(
    () => jobs.some(job => job.status === 'queued' || job.status === 'running'),
    [jobs],
  );

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [foundryRes, lmstudioRes] = await Promise.all([
        fetch('/api/models?runtime=foundry', { cache: 'no-store' }),
        fetch('/api/models?runtime=lmstudio', { cache: 'no-store' }),
      ]);
      const [foundryData, lmstudioData] = await Promise.all([
        parseApiResponse<ModelResponse>(foundryRes),
        parseApiResponse<ModelResponse>(lmstudioRes),
      ]);

      setModelsByRuntime({
        foundry: foundryData.models ?? [],
        lmstudio: lmstudioData.models ?? [],
      });
      setJobs([
        ...(foundryData.jobs ?? []),
        ...(lmstudioData.jobs ?? []),
      ]);

      const warnings = [
        runtime === 'foundry' ? foundryData.warning : lmstudioData.warning,
        embeddingRuntime === 'foundry' ? foundryData.warning : lmstudioData.warning,
      ].filter(Boolean);
      setWarning(warnings.length > 0 ? warnings.join(' | ') : undefined);

      const runtimeModels = runtime === 'foundry' ? foundryData.models ?? [] : lmstudioData.models ?? [];
      if (runtimeModels.length > 0) {
        const hasCurrent = runtimeModels.some(item => modelIdsMatch(item.id, modelId));
        if (!hasCurrent) {
          setModelId(runtimeModels[0].id);
        }
      }
      const embeddingRuntimeModels =
        embeddingRuntime === 'foundry' ? foundryData.models ?? [] : lmstudioData.models ?? [];
      if (embeddingRuntimeModels.length > 0) {
        const hasCurrentEmbedding = embeddingRuntimeModels.some(item =>
          modelIdsMatch(item.id, embeddingModelId),
        );
        if (!hasCurrentEmbedding) {
          setEmbeddingModelId(embeddingRuntimeModels[0].id);
        }
      }
    } catch (error) {
      setWarning(error instanceof Error ? error.message : 'Could not fetch models');
    } finally {
      setLoadingModels(false);
    }
  }, [runtime, embeddingRuntime, modelId, embeddingModelId]);

  const refreshDatabase = useCallback(async () => {
    setLoadingDb(true);
    setDbError(null);
    try {
      const res = await fetch('/api/indexed-documents', { cache: 'no-store' });
      const data = await parseApiResponse<IndexedDocumentsResponse & { error?: string }>(res);
      if (!res.ok) {
        setDbError(data.error || 'Failed to load database state');
        return;
      }

      setIndexedDocuments(data.documents ?? []);
      setTotals(
        data.totals ?? {
          documentsIndexed: data.documents?.length ?? 0,
          chunksIndexed: 0,
        },
      );
      setSelectedSources(current =>
        current.filter(source => data.documents.some(item => item.source === source)),
      );
    } catch (error) {
      setDbError(error instanceof Error ? error.message : 'Failed to load database state');
    } finally {
      setLoadingDb(false);
    }
  }, []);

  useEffect(() => {
    try {
      const savedRuntime = window.localStorage.getItem(STORAGE_KEYS.runtime);
      const savedModelId = window.localStorage.getItem(STORAGE_KEYS.modelId);
      const savedEmbeddingRuntime = window.localStorage.getItem(STORAGE_KEYS.embeddingRuntime);
      const savedEmbeddingModelId = window.localStorage.getItem(STORAGE_KEYS.embeddingModelId);

      if (savedRuntime === 'foundry' || savedRuntime === 'lmstudio') {
        setRuntime(savedRuntime);
      }
      if (savedModelId) {
        setModelId(savedModelId);
      }
      if (savedEmbeddingRuntime === 'foundry' || savedEmbeddingRuntime === 'lmstudio') {
        setEmbeddingRuntime(savedEmbeddingRuntime);
      }
      if (savedEmbeddingModelId) {
        setEmbeddingModelId(savedEmbeddingModelId);
      }
    } catch {
      // Ignore localStorage errors and continue with defaults.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.runtime, runtime);
      window.localStorage.setItem(STORAGE_KEYS.modelId, modelId);
      window.localStorage.setItem(STORAGE_KEYS.embeddingRuntime, embeddingRuntime);
      window.localStorage.setItem(STORAGE_KEYS.embeddingModelId, embeddingModelId);
    } catch {
      // Ignore localStorage errors in restricted environments.
    }
  }, [runtime, modelId, embeddingRuntime, embeddingModelId]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    void refreshDatabase();
  }, [refreshDatabase]);

  useEffect(() => {
    if (!hasAnyActiveJob) return;

    const timer = setInterval(() => {
      void refreshModels();
    }, 1800);

    return () => clearInterval(timer);
  }, [hasAnyActiveJob, refreshModels]);

  useEffect(() => {
    const node = chatLogRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chatMessages, chatLoading]);

  const startDownload = async (
    targetRuntime: RuntimeName,
    targetModelId: string,
    alreadyDownloaded: boolean,
  ) => {
    setWarning(undefined);

    if (alreadyDownloaded) {
      setWarning(`Model "${targetModelId}" is already downloaded.`);
      return;
    }

    try {
      const res = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: targetRuntime, modelId: targetModelId }),
      });

      const data = await parseApiResponse<{ job?: ModelJob; error?: string }>(res);
      if (!res.ok) {
        setWarning(data.error || 'Failed to start download');
        return;
      }

      if (data.job) {
        setJobs(current => [data.job as ModelJob, ...current.filter(item => item.id !== data.job?.id)]);
      } else {
        setWarning(`Download request for "${targetModelId}" was accepted, but no job id was returned.`);
      }

      await refreshModels();
    } catch (error) {
      setWarning(error instanceof Error ? error.message : 'Failed to start download');
    }
  };

  const ingest = async () => {
    setIngestError(null);
    setIngestResult(null);

    if (selectedFiles.length === 0) {
      setIngestError('Please select one or more .pdf, .md, or .txt files first.');
      return;
    }

    const filesPayload = await Promise.all(
      selectedFiles.map(async file => {
        const lower = file.name.toLowerCase();
        const mimeType = lower.endsWith('.pdf')
          ? 'application/pdf'
          : lower.endsWith('.md') || file.type === 'text/markdown'
            ? 'text/markdown'
            : 'text/plain';

        const contentBase64 =
          mimeType === 'application/pdf'
            ? await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                  const result = reader.result;
                  if (typeof result !== 'string') {
                    reject(new Error('Could not read PDF file.'));
                    return;
                  }
                  const encoded = result.split(',')[1] || '';
                  resolve(encoded);
                };
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
              })
            : btoa(unescape(encodeURIComponent(await file.text())));

        return {
          name: file.name,
          mimeType,
          contentBase64,
        };
      }),
    );

    const payload = {
      runtime,
      files: filesPayload,
      options: {
        chunkSize: 800,
        chunkOverlap: 120,
        embeddingModelId,
        embeddingRuntime,
      },
    };

    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await parseApiResponse<IngestResponse & { error?: string }>(res);
      if (!res.ok) {
        setIngestError(data.error || 'Ingest failed');
        return;
      }

      setIngestResult(data);
      await refreshDatabase();
    } catch (error) {
      setIngestError(error instanceof Error ? error.message : 'Ingest failed');
    }
  };

  const ask = async () => {
    setChatError(null);

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setChatError('Enter a question first.');
      return;
    }

    const userMessage: ChatMessage = {
      id: makeMessageId(),
      role: 'user',
      text: trimmedQuery,
    };

    setChatMessages(current => [...current, userMessage]);
    setQuery('');
    setChatLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtime,
          modelId,
          query: trimmedQuery,
          options: {
            topK: 5,
            minScore: 0.2,
            temperature: 0.2,
            sourceFilter: selectedSources.length > 0 ? selectedSources : undefined,
            embeddingModelId,
            embeddingRuntime,
          },
        }),
      });

      const data = await parseApiResponse<ChatResponse & { error?: string }>(res);
      if (!res.ok) {
        setChatError(data.error || 'Chat failed');
        return;
      }

      const assistantMessage: ChatMessage = {
        id: makeMessageId(),
        role: 'assistant',
        text: data.answer,
        citations: data.citations,
        warnings: data.warnings,
        retrieval: data.retrieval,
      };
      setChatMessages(current => [...current, assistantMessage]);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Chat failed');
    } finally {
      setChatLoading(false);
    }
  };

  const toggleSource = (source: string) => {
    setSelectedSources(current =>
      current.includes(source)
        ? current.filter(item => item !== source)
        : [...current, source],
    );
  };

  const clearSourceSelection = () => {
    setSelectedSources([]);
  };

  const deleteSource = async (source: string) => {
    setDbError(null);
    try {
      const res = await fetch('/api/indexed-documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });

      const data = await parseApiResponse<IndexedDocumentsResponse & { error?: string }>(res);
      if (!res.ok) {
        setDbError(data.error || 'Delete failed');
        return;
      }

      setIndexedDocuments(data.documents ?? []);
      setTotals(data.totals ?? { documentsIndexed: 0, chunksIndexed: 0 });
      setSelectedSources(current => current.filter(item => item !== source));
    } catch (error) {
      setDbError(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const deleteAll = async () => {
    if (!window.confirm('Delete all indexed documents from Chroma?')) return;

    setDbError(null);
    try {
      const res = await fetch('/api/indexed-documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAll: true }),
      });

      const data = await parseApiResponse<IndexedDocumentsResponse & { error?: string }>(res);
      if (!res.ok) {
        setDbError(data.error || 'Delete all failed');
        return;
      }

      setIndexedDocuments(data.documents ?? []);
      setTotals(data.totals ?? { documentsIndexed: 0, chunksIndexed: 0 });
      setSelectedSources([]);
    } catch (error) {
      setDbError(error instanceof Error ? error.message : 'Delete all failed');
    }
  };

  return (
    <main className="app-shell">
      <div className="ambient-glow" />
      <div className="content-wrap split-layout">
        <aside className="left-pane">
          <header className="hero">
            <p className="eyebrow">Week 2 Local RAG Studio</p>
            <h1>RAG Workspace Controls</h1>
            <p className="hero-copy">
              Configure runtime, ingest documents, and manage indexed data. Use scope selection to chat against specific files.
            </p>
          </header>

          <section className="card">
            <h2>Model Runtime Control</h2>
            <label>
              Runtime
              <select
                value={runtime}
                onChange={event => {
                  const next = event.currentTarget.value as RuntimeName;
                  setRuntime(next);
                  const nextModels = modelsByRuntime[next] ?? [];
                  setModelId(
                    nextModels.length > 0
                      ? nextModels[0].id
                      : next === 'foundry'
                        ? 'phi-4-mini-reasoning'
                        : 'qwen/qwen3-vl-8b',
                  );
                }}
              >
                <option value="foundry">Microsoft Foundry Local</option>
                <option value="lmstudio">LM Studio</option>
              </select>
            </label>
            <label>
              Chat Model ID (used for answer generation)
              {chatModels.length > 0 ? (
                <select value={modelId} onChange={event => setModelId(event.currentTarget.value)}>
                  {chatModels.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.id} {item.downloaded ? '(Downloaded)' : '(Not downloaded)'}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    value={modelId}
                    onChange={event => setModelId(event.currentTarget.value)}
                    list="runtime-models"
                  />
                  <datalist id="runtime-models">
                    {SUGGESTED_LM_MODELS.map(item => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </>
              )}
            </label>
            <div className="actions">
              <button
                className="btn-primary"
                onClick={() => void startDownload(runtime, modelId, isChatModelDownloaded)}
                disabled={Boolean(activeChatJob) || isChatModelDownloaded}
              >
                {activeChatJob
                  ? 'Chat Model Download Running...'
                  : isChatModelDownloaded
                    ? 'Chat Model Already Downloaded'
                    : 'Download Chat Model'}
              </button>
            </div>
            {activeChatJob ? (
              <p className="muted">
                Chat model job `{activeChatJob.id}` using {activeChatJob.commandLabel ?? 'download command'}: {activeChatJob.status} ({activeChatJob.progress}%)
              </p>
            ) : null}
            {latestChatJob?.status === 'failed' ? (
              <p className="panel-error">Chat model download failed: {latestChatJob.error || 'Unknown error'}</p>
            ) : null}
            <label>
              Embedding Runtime (used for ingest and query retrieval)
              <select
                value={embeddingRuntime}
                onChange={event => {
                  const next = event.currentTarget.value as RuntimeName;
                  setEmbeddingRuntime(next);
                  const nextModels = modelsByRuntime[next] ?? [];
                  setEmbeddingModelId(
                    nextModels.length > 0
                      ? nextModels[0].id
                      : next === 'foundry'
                        ? 'nomic-embed-text-v1'
                        : 'text-embedding-nomic-embed-text-v1.5',
                  );
                }}
              >
                <option value="lmstudio">LM Studio</option>
                <option value="foundry">Microsoft Foundry Local</option>
              </select>
            </label>
            <label>
              Embedding Model ID (used for both ingest and query retrieval)
              {embeddingModels.length > 0 ? (
                <select
                  value={embeddingModelId}
                  onChange={event => setEmbeddingModelId(event.currentTarget.value)}
                >
                  {embeddingModels.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.id} {item.downloaded ? '(Downloaded)' : '(Not downloaded)'}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    value={embeddingModelId}
                    onChange={event => setEmbeddingModelId(event.currentTarget.value)}
                    list={
                      embeddingRuntime === 'foundry'
                        ? 'foundry-embedding-models'
                        : 'lm-embedding-models'
                    }
                  />
                  <datalist id="lm-embedding-models">
                    {SUGGESTED_LM_EMBED_MODELS.map(item => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                  <datalist id="foundry-embedding-models">
                    {SUGGESTED_FOUNDRY_EMBED_MODELS.map(item => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </>
              )}
            </label>
            <div className="actions">
              <button
                className="btn-primary"
                onClick={() =>
                  void startDownload(
                    embeddingRuntime,
                    embeddingModelId,
                    isEmbeddingModelDownloaded,
                  )
                }
                disabled={Boolean(activeEmbeddingJob) || isEmbeddingModelDownloaded}
              >
                {activeEmbeddingJob
                  ? 'Embedding Model Download Running...'
                  : isEmbeddingModelDownloaded
                    ? 'Embedding Model Already Downloaded'
                    : 'Download Embedding Model'}
              </button>
            </div>
            {activeEmbeddingJob ? (
              <p className="muted">
                Embedding model job `{activeEmbeddingJob.id}` using {activeEmbeddingJob.commandLabel ?? 'download command'}: {activeEmbeddingJob.status} ({activeEmbeddingJob.progress}%)
              </p>
            ) : null}
            {latestEmbeddingJob?.status === 'failed' ? (
              <p className="panel-error">Embedding model download failed: {latestEmbeddingJob.error || 'Unknown error'}</p>
            ) : null}
            {embeddingRuntime === 'foundry' &&
            isFoundryCatalogMissingError(latestEmbeddingJob?.error) ? (
              <p className="muted">
                Foundry catalog does not provide this embedding model on your machine. Use LM Studio embedding model `text-embedding-nomic-embed-text-v1.5` for ingest and retrieval.
              </p>
            ) : null}

            <div className="actions">
              <button className="btn-secondary" onClick={refreshModels} disabled={loadingModels}>
                {loadingModels ? 'Refreshing...' : 'Refresh Models'}
              </button>
            </div>
            {warning ? <p className="panel-error">{warning}</p> : null}
          </section>

          <section className="card">
            <h2>Manual Download & Docs</h2>
            <p className="muted">
              If auto download fails, run manual commands and refresh models.
            </p>
            <h3>Foundry Local</h3>
            <pre className="code-block">foundry model download phi-4-mini-reasoning</pre>
            <h3>LM Studio CLI</h3>
            <pre className="code-block">lms get qwen/qwen3-vl-8b --yes</pre>
            <ul>
              <li>
                <a href="https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/get-started" target="_blank" rel="noreferrer">
                  Foundry Local - Get Started
                </a>
              </li>
              <li>
                <a href="https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/reference/reference-sdk" target="_blank" rel="noreferrer">
                  Foundry Local - SDK/Reference
                </a>
              </li>
              <li>
                <a href="https://lmstudio.ai/docs" target="_blank" rel="noreferrer">
                  LM Studio Documentation
                </a>
              </li>
            </ul>
          </section>

          <section className="card">
            <h2>Document Ingestion</h2>
            <label>
              Select files (.pdf, .md, .txt) - multiple allowed
              <input
                type="file"
                multiple
                accept=".pdf,.md,.txt,application/pdf,text/markdown,text/plain"
                onChange={event => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  setSelectedFiles(files);
                }}
              />
            </label>

            {selectedFiles.length > 0 ? (
              <div className="list-block">
                <h3>Selected files</h3>
                <ul>
                  {selectedFiles.map(file => (
                    <li key={`${file.name}-${file.size}`}>
                      {file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="actions">
              <button className="btn-primary" onClick={ingest}>Ingest</button>
            </div>
            {ingestError ? <p className="panel-error">{ingestError}</p> : null}
            {ingestResult ? (
              <div className="list-block">
                <p className={ingestResult.success ? 'muted' : 'panel-error'}>
                  Indexed {ingestResult.documentsIndexed} document(s), {ingestResult.chunksIndexed} chunk(s).
                </p>
                {ingestResult.message ? <p className="panel-error">{ingestResult.message}</p> : null}
                {ingestResult.skipped.length > 0 ? (
                  <>
                    <h3>Skipped files</h3>
                    <ul>
                      {ingestResult.skipped.map(item => (
                        <li key={`${item.name}-${item.reason}`}>
                          {item.name}: {SKIPPED_REASON_LABELS[item.reason] ?? item.reason}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {ingestResult.errors.length > 0 ? (
                  <>
                    <h3>Errors</h3>
                    <ul>
                      {ingestResult.errors.map(item => (
                        <li key={`${item.name}-${item.message}`}>
                          {item.name}: {item.message}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Indexed Documents (Chroma)</h2>
            <p className="muted">
              Total: {totals.documentsIndexed} document(s), {totals.chunksIndexed} chunk(s)
            </p>
            <p className="muted">
              Current embedding runtime/model (ingest + retrieval): {embeddingRuntime} / {embeddingModelId}
            </p>
            <div className="actions">
              <button className="btn-secondary" onClick={refreshDatabase} disabled={loadingDb}>
                {loadingDb ? 'Refreshing...' : 'Refresh DB'}
              </button>
              <button className="btn-secondary" onClick={clearSourceSelection} disabled={selectedSources.length === 0}>
                Clear Scope
              </button>
              <button className="btn-secondary" onClick={deleteAll} disabled={indexedDocuments.length === 0}>
                Delete All
              </button>
            </div>

            {dbError ? <p className="panel-error">{dbError}</p> : null}

            {indexedDocuments.length === 0 ? (
              <p className="muted">No indexed documents yet.</p>
            ) : (
              <ul className="doc-list">
                {indexedDocuments.map(item => {
                  const checked = selectedSources.includes(item.source);
                  return (
                    <li key={item.source} className="doc-item">
                      <label className="doc-checkbox">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSource(item.source)}
                        />
                        <span>
                          <strong>{item.source}</strong>
                          <small>
                            {item.chunks} chunk(s), last indexed {formatDateTime(item.lastIndexedAt)}
                          </small>
                          <small>
                            Embedding model(s): {item.embeddingModels?.join(', ') || 'unknown'}
                          </small>
                        </span>
                      </label>
                      <button
                        className="btn-secondary"
                        onClick={() => void deleteSource(item.source)}
                      >
                        Delete
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>

        <section className="right-pane">
          <div className="chat-shell">
            <header className="chat-header">
              <h2>Grounded Chat</h2>
              <p className="muted">
                Scope: {selectedSources.length > 0 ? `${selectedSources.length} selected document(s)` : 'All indexed documents'}
              </p>
            </header>

            <div className="chat-log" ref={chatLogRef}>
              {chatMessages.length === 0 ? (
                <p className="muted empty-chat">
                  Ask a question. Answers will appear here with citations.
                </p>
              ) : (
                <>
                  {chatMessages.map(message => (
                    <article
                      key={message.id}
                      className={`chat-message ${message.role === 'user' ? 'chat-user' : 'chat-assistant'}`}
                    >
                      <p className="chat-role">{message.role === 'user' ? 'You' : 'Assistant'}</p>
                      <p className="answer">{message.text}</p>
                      {message.citations && message.citations.length > 0 ? (
                        <div className="citation-block">
                          <h3>Citations</h3>
                          <ul>
                            {message.citations.map(item => (
                              <li key={item.chunk_id}>
                                {item.source} {item.page !== null ? `(page ${item.page})` : ''} - {item.chunk_id} (score {item.score.toFixed(3)})
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {message.warnings && message.warnings.length > 0 ? (
                        <p className="muted">Warnings: {message.warnings.join(' | ')}</p>
                      ) : null}
                      {message.retrieval ? (
                        <p className="muted">
                          Retrieval: {message.retrieval.matched} hit(s), topK {message.retrieval.topK}, {message.retrieval.latencyMs} ms
                        </p>
                      ) : null}
                    </article>
                  ))}
                  {chatLoading ? (
                    <article className="chat-message chat-assistant chat-pending">
                      <p className="chat-role">Assistant</p>
                      <p className="answer">
                        Finding answer
                        <span className="thinking-dots" aria-hidden="true">
                          <span>.</span>
                          <span>.</span>
                          <span>.</span>
                        </span>
                      </p>
                    </article>
                  ) : null}
                </>
              )}
            </div>

            <div className="chat-composer">
              <label>
                Ask a question
                <textarea
                  rows={4}
                  value={query}
                  onChange={event => setQuery(event.currentTarget.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      if (!chatLoading) {
                        void ask();
                      }
                    }
                  }}
                  placeholder="Ask about your indexed files..."
                />
              </label>
              <div className="actions">
                <button className="btn-primary" onClick={ask} disabled={chatLoading}>
                  {chatLoading ? 'Asking...' : 'Ask'}
                </button>
              </div>
              {chatError ? <p className="panel-error">{chatError}</p> : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
