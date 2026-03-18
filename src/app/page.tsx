'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

type ConnectivityResponse = {
  success: boolean;
  message: string;
};

const SUGGESTED_CHAT_MODELS = [
  'qwen/qwen3-vl-8b',
  'gpt-4o-mini',
  'gemini-2.0-flash',
  'claude-3-5-sonnet-latest',
];

const SUGGESTED_EMBEDDING_MODELS = [
  'text-embedding-nomic-embed-text-v1.5',
  'text-embedding-3-small',
  'text-embedding-3-large',
  'gemini-embedding-001',
];

const SKIPPED_REASON_LABELS: Record<string, string> = {
  unsupported_mime_type: 'Unsupported file type',
  empty_text: 'No extractable text found (common with scanned/image-only PDFs)',
  no_chunks_generated: 'Text found, but no chunks were generated',
};

const STORAGE_KEYS = {
  chatBaseUrl: 'ragstudio.chatBaseUrl',
  chatModelId: 'ragstudio.chatModelId',
  embeddingBaseUrl: 'ragstudio.embeddingBaseUrl',
  embeddingModelId: 'ragstudio.embeddingModelId',
  vectorDbUrl: 'ragstudio.vectorDbUrl',
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

export default function Week2LocalRag() {
  const [chatBaseUrl, setChatBaseUrl] = useState('http://127.0.0.1:1234');
  const [chatApiKey, setChatApiKey] = useState('');
  const [chatModelId, setChatModelId] = useState('qwen/qwen3-vl-8b');

  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('http://127.0.0.1:1234');
  const [embeddingApiKey, setEmbeddingApiKey] = useState('');
  const [embeddingModelId, setEmbeddingModelId] = useState('text-embedding-nomic-embed-text-v1.5');

  const [vectorDbUrl, setVectorDbUrl] = useState('http://localhost:8000');

  const [chatTestLoading, setChatTestLoading] = useState(false);
  const [chatTestMessage, setChatTestMessage] = useState<string | null>(null);
  const [chatTestError, setChatTestError] = useState<string | null>(null);

  const [embeddingTestLoading, setEmbeddingTestLoading] = useState(false);
  const [embeddingTestMessage, setEmbeddingTestMessage] = useState<string | null>(null);
  const [embeddingTestError, setEmbeddingTestError] = useState<string | null>(null);

  const [vectorTestLoading, setVectorTestLoading] = useState(false);
  const [vectorTestMessage, setVectorTestMessage] = useState<string | null>(null);
  const [vectorTestError, setVectorTestError] = useState<string | null>(null);

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

  const refreshDatabase = useCallback(async () => {
    setLoadingDb(true);
    setDbError(null);
    try {
      const params = new URLSearchParams();
      if (vectorDbUrl.trim()) params.set('vectorDbUrl', vectorDbUrl.trim());
      const res = await fetch(`/api/indexed-documents?${params.toString()}`, {
        cache: 'no-store',
      });
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
  }, [vectorDbUrl]);

  useEffect(() => {
    try {
      const savedChatBaseUrl = window.localStorage.getItem(STORAGE_KEYS.chatBaseUrl);
      const savedChatModelId = window.localStorage.getItem(STORAGE_KEYS.chatModelId);
      const savedEmbeddingBaseUrl = window.localStorage.getItem(STORAGE_KEYS.embeddingBaseUrl);
      const savedEmbeddingModelId = window.localStorage.getItem(STORAGE_KEYS.embeddingModelId);
      const savedVectorDbUrl = window.localStorage.getItem(STORAGE_KEYS.vectorDbUrl);

      if (savedChatBaseUrl) setChatBaseUrl(savedChatBaseUrl);
      if (savedChatModelId) setChatModelId(savedChatModelId);
      if (savedEmbeddingBaseUrl) setEmbeddingBaseUrl(savedEmbeddingBaseUrl);
      if (savedEmbeddingModelId) setEmbeddingModelId(savedEmbeddingModelId);
      if (savedVectorDbUrl) setVectorDbUrl(savedVectorDbUrl);
    } catch {
      // Ignore localStorage errors.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.chatBaseUrl, chatBaseUrl);
      window.localStorage.setItem(STORAGE_KEYS.chatModelId, chatModelId);
      window.localStorage.setItem(STORAGE_KEYS.embeddingBaseUrl, embeddingBaseUrl);
      window.localStorage.setItem(STORAGE_KEYS.embeddingModelId, embeddingModelId);
      window.localStorage.setItem(STORAGE_KEYS.vectorDbUrl, vectorDbUrl);
    } catch {
      // Ignore localStorage errors.
    }
  }, [chatBaseUrl, chatModelId, embeddingBaseUrl, embeddingModelId, vectorDbUrl]);

  useEffect(() => {
    void refreshDatabase();
  }, [refreshDatabase]);

  useEffect(() => {
    const node = chatLogRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chatMessages, chatLoading]);

  const testConnection = async (target: 'chat' | 'embedding' | 'vector') => {
    const setLoading =
      target === 'chat'
        ? setChatTestLoading
        : target === 'embedding'
          ? setEmbeddingTestLoading
          : setVectorTestLoading;
    const setMessage =
      target === 'chat'
        ? setChatTestMessage
        : target === 'embedding'
          ? setEmbeddingTestMessage
          : setVectorTestMessage;
    const setError =
      target === 'chat'
        ? setChatTestError
        : target === 'embedding'
          ? setEmbeddingTestError
          : setVectorTestError;

    setLoading(true);
    setMessage(null);
    setError(null);

    try {
      const payload =
        target === 'chat'
          ? {
              target,
              baseUrl: chatBaseUrl,
              apiKey: chatApiKey,
              modelId: chatModelId,
            }
          : target === 'embedding'
            ? {
                target,
                baseUrl: embeddingBaseUrl,
                apiKey: embeddingApiKey,
                modelId: embeddingModelId,
              }
            : {
                target,
                vectorDbUrl,
              };

      const res = await fetch('/api/connectivity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseApiResponse<ConnectivityResponse & { error?: string }>(res);
      if (!res.ok) {
        setError(data.error || `${target} test failed`);
        return;
      }

      setMessage(data.message);
      if (target === 'vector') {
        await refreshDatabase();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : `${target} test failed`);
    } finally {
      setLoading(false);
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
      runtime: 'openai',
      files: filesPayload,
      options: {
        chunkSize: 800,
        chunkOverlap: 120,
        embeddingModelId,
        embeddingRuntime: 'openai',
        embeddingBaseUrl,
        embeddingApiKey,
        vectorDbUrl,
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
          runtime: 'openai',
          modelId: chatModelId,
          query: trimmedQuery,
          options: {
            topK: 5,
            minScore: 0.2,
            temperature: 0.2,
            sourceFilter: selectedSources.length > 0 ? selectedSources : undefined,
            embeddingModelId,
            embeddingRuntime: 'openai',
            llmBaseUrl: chatBaseUrl,
            llmApiKey: chatApiKey,
            embeddingBaseUrl,
            embeddingApiKey,
            vectorDbUrl,
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
        body: JSON.stringify({ source, vectorDbUrl }),
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
    if (!window.confirm('Delete all indexed documents from configured vector DB?')) return;

    setDbError(null);
    try {
      const res = await fetch('/api/indexed-documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAll: true, vectorDbUrl }),
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
              Configure chat, embedding, and vector DB endpoints. Test each connection before ingest and chat.
            </p>
          </header>

          <section className="card">
            <h2>Connections</h2>

            <h3>Chat Model</h3>
            <label>
              Chat Base URL
              <input
                value={chatBaseUrl}
                onChange={event => setChatBaseUrl(event.currentTarget.value)}
                placeholder="http://127.0.0.1:1234 or https://..."
              />
            </label>
            <label>
              Chat API Key (optional for localhost)
              <input
                value={chatApiKey}
                onChange={event => setChatApiKey(event.currentTarget.value)}
                placeholder="sk-..."
                type="password"
              />
            </label>
            <label>
              Chat Model ID
              <input
                value={chatModelId}
                onChange={event => setChatModelId(event.currentTarget.value)}
                list="chat-models"
              />
              <datalist id="chat-models">
                {SUGGESTED_CHAT_MODELS.map(item => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
            <div className="actions">
              <button className="btn-secondary" onClick={() => void testConnection('chat')} disabled={chatTestLoading}>
                {chatTestLoading ? 'Testing Chat...' : 'Test Chat Model'}
              </button>
            </div>
            {chatTestMessage ? <p className="muted">{chatTestMessage}</p> : null}
            {chatTestError ? <p className="panel-error">{chatTestError}</p> : null}

            <h3>Embedding Model</h3>
            <label>
              Embedding Base URL
              <input
                value={embeddingBaseUrl}
                onChange={event => setEmbeddingBaseUrl(event.currentTarget.value)}
                placeholder="http://127.0.0.1:1234 or https://..."
              />
            </label>
            <label>
              Embedding API Key (optional for localhost)
              <input
                value={embeddingApiKey}
                onChange={event => setEmbeddingApiKey(event.currentTarget.value)}
                placeholder="sk-..."
                type="password"
              />
            </label>
            <label>
              Embedding Model ID
              <input
                value={embeddingModelId}
                onChange={event => setEmbeddingModelId(event.currentTarget.value)}
                list="embedding-models"
              />
              <datalist id="embedding-models">
                {SUGGESTED_EMBEDDING_MODELS.map(item => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
            <div className="actions">
              <button className="btn-secondary" onClick={() => void testConnection('embedding')} disabled={embeddingTestLoading}>
                {embeddingTestLoading ? 'Testing Embedding...' : 'Test Embedding Model'}
              </button>
            </div>
            {embeddingTestMessage ? <p className="muted">{embeddingTestMessage}</p> : null}
            {embeddingTestError ? <p className="panel-error">{embeddingTestError}</p> : null}

            <h3>Chroma DB</h3>
            <label>
              Vector DB URL (Chroma)
              <input
                value={vectorDbUrl}
                onChange={event => setVectorDbUrl(event.currentTarget.value)}
                placeholder="http://localhost:8000"
              />
            </label>
            <div className="actions">
              <button className="btn-secondary" onClick={() => void testConnection('vector')} disabled={vectorTestLoading}>
                {vectorTestLoading ? 'Testing Chroma...' : 'Test Chroma DB'}
              </button>
            </div>
            {vectorTestMessage ? <p className="muted">{vectorTestMessage}</p> : null}
            {vectorTestError ? <p className="panel-error">{vectorTestError}</p> : null}
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
            <h2>Indexed Documents (Vector DB)</h2>
            <p className="muted">
              Total: {totals.documentsIndexed} document(s), {totals.chunksIndexed} chunk(s)
            </p>
            <p className="muted">
              Current embedding base/model: {embeddingBaseUrl} / {embeddingModelId}
            </p>
            <p className="muted">Vector DB URL: {vectorDbUrl}</p>
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
