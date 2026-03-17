'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

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

const SUGGESTED_LM_MODELS = [
  'qwen2.5-7b-instruct',
  'llama-3.1-8b-instruct',
  'qwen2.5-coder-7b-instruct',
];

const SKIPPED_REASON_LABELS: Record<string, string> = {
  unsupported_mime_type: 'Unsupported file type',
  empty_text: 'No extractable text found (common with scanned/image-only PDFs)',
  no_chunks_generated: 'Text found, but no chunks were generated',
};

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

export default function Week2LocalRag() {
  const [runtime, setRuntime] = useState<RuntimeName>('foundry');
  const [modelId, setModelId] = useState('phi-4-mini-reasoning');
  const [models, setModels] = useState<RuntimeModel[]>([]);
  const [jobs, setJobs] = useState<ModelJob[]>([]);
  const [warning, setWarning] = useState<string | undefined>();
  const [loadingModels, setLoadingModels] = useState(false);

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [ingestResult, setIngestResult] = useState<IngestResponse | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [chatResult, setChatResult] = useState<ChatResponse | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);

  const selectedModelInfo = useMemo(
    () => models.find(model => model.id === modelId),
    [models, modelId],
  );
  const isAlreadyDownloaded = Boolean(selectedModelInfo?.downloaded);

  const activeJob = useMemo(
    () =>
      jobs.find(
        job =>
          job.modelId === modelId &&
          (job.status === 'queued' || job.status === 'running'),
      ),
    [jobs, modelId],
  );

  const latestJobForModel = useMemo(
    () => jobs.find(job => job.modelId === modelId),
    [jobs, modelId],
  );

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const res = await fetch(`/api/models?runtime=${runtime}`, { cache: 'no-store' });
      const data = await parseApiResponse<ModelResponse>(res);
      setModels(data.models ?? []);
      setJobs(data.jobs ?? []);
      setWarning(data.warning);

      if (runtime === 'foundry' && data.models?.length) {
        const hasCurrent = data.models.some(item => item.id === modelId);
        if (!hasCurrent) {
          setModelId(data.models[0].id);
        }
      }
    } catch (error) {
      setWarning(error instanceof Error ? error.message : 'Could not fetch models');
    } finally {
      setLoadingModels(false);
    }
  }, [runtime, modelId]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    if (!activeJob) return;

    const timer = setInterval(() => {
      void refreshModels();
    }, 1800);

    return () => clearInterval(timer);
  }, [activeJob, refreshModels]);

  const startDownload = async () => {
    setWarning(undefined);

    if (isAlreadyDownloaded) {
      setWarning('This model is already downloaded. Select a model marked Not downloaded.');
      return;
    }

    try {
      const res = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime, modelId }),
      });

      const data = await parseApiResponse<{ job?: ModelJob; error?: string }>(res);
      if (!res.ok) {
        setWarning(data.error || 'Failed to start download');
        return;
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
      files: filesPayload,
      options: {
        chunkSize: 800,
        chunkOverlap: 120,
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
    } catch (error) {
      setIngestError(error instanceof Error ? error.message : 'Ingest failed');
    }
  };

  const ask = async () => {
    setChatError(null);
    setChatResult(null);

    if (!query.trim()) {
      setChatError('Enter a question first.');
      return;
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          options: { topK: 5, minScore: 0.2, temperature: 0.2 },
        }),
      });

      const data = await parseApiResponse<ChatResponse & { error?: string }>(res);
      if (!res.ok) {
        setChatError(data.error || 'Chat failed');
        return;
      }

      setChatResult(data);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Chat failed');
    }
  };

  return (
    <main className="app-shell">
      <div className="ambient-glow" />
      <div className="content-wrap">
        <header className="hero">
          <p className="eyebrow">Week 2 Local RAG Studio</p>
          <h1>Model control + ingestion + grounded Q&A (Foundry-first).</h1>
          <p className="hero-copy">
            Foundry runtime shows only project-required models with downloaded status.
          </p>
        </header>

        <section className="card">
          <h2>Model Runtime Control</h2>
          <div className="grid2">
            <label>
              Runtime
              <select
                value={runtime}
                onChange={event => {
                  const next = event.currentTarget.value as RuntimeName;
                  setRuntime(next);
                  setModelId(next === 'foundry' ? 'phi-4-mini-reasoning' : 'qwen2.5-7b-instruct');
                }}
              >
                <option value="foundry">Microsoft Foundry Local (project default)</option>
                <option value="lmstudio">LM Studio (alternate)</option>
              </select>
            </label>

            <label>
              Model ID
              {runtime === 'foundry' ? (
                <select value={modelId} onChange={event => setModelId(event.currentTarget.value)}>
                  {models.map(item => (
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
          </div>

          <div className="actions">
            <button
              className="btn-primary"
              onClick={startDownload}
              disabled={Boolean(activeJob) || isAlreadyDownloaded}
            >
              {activeJob ? 'Download Running...' : isAlreadyDownloaded ? 'Already Downloaded' : 'Download Model'}
            </button>
            <button className="btn-secondary" onClick={refreshModels} disabled={loadingModels}>
              {loadingModels ? 'Refreshing...' : 'Refresh Models'}
            </button>
          </div>

          {activeJob ? (
            <p className="muted">
              Active job `{activeJob.id}` using {activeJob.commandLabel ?? 'download command'}: {activeJob.status} ({activeJob.progress}%)
            </p>
          ) : null}

          {latestJobForModel?.status === 'failed' ? (
            <p className="panel-error">Download failed: {latestJobForModel.error || 'Unknown error'}</p>
          ) : null}

          {warning ? <p className="panel-error">{warning}</p> : null}

          <div className="list-block">
            <h3>
              {runtime === 'foundry' ? 'Project-required Foundry models' : 'Detected LM Studio models'}
            </h3>
            {models.length === 0 ? (
              <p className="muted">No models available for this runtime yet.</p>
            ) : (
              <ul>
                {models.map(item => (
                  <li key={item.id}>
                    <strong>{item.id}</strong> {item.downloaded ? '✅ Downloaded' : '⬇️ Not downloaded'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Manual Download & Documentation</h2>
          <p className="muted">
            If automatic download fails, run manual command in terminal and click <strong>Refresh Models</strong>.
          </p>
          <h3>Foundry Local (project default)</h3>
          <pre className="code-block">foundry model download phi-4-mini-reasoning</pre>
          <h3>LM Studio CLI</h3>
          <pre className="code-block">lms get qwen2.5-7b-instruct --yes</pre>
          <h3>Official docs</h3>
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
          <h2>Document Ingestion (Prototype)</h2>
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
          <h2>Grounded Chat (Prototype)</h2>
          <label>
            Ask a question
            <textarea
              rows={4}
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
              placeholder="Ask a question based on indexed text..."
            />
          </label>
          <div className="actions">
            <button className="btn-primary" onClick={ask}>Ask</button>
          </div>
          {chatError ? <p className="panel-error">{chatError}</p> : null}

          {chatResult ? (
            <div className="result-block">
              <p className="answer">{chatResult.answer}</p>
              <h3>Citations</h3>
              <ul>
                {chatResult.citations.map(item => (
                  <li key={item.chunk_id}>
                    {item.source} {item.page !== null ? `(page ${item.page})` : ''} - {item.chunk_id} (score {item.score})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
