import { searchChunks } from '@/lib/rag-store';
import { generateGroundedAnswer, type RuntimeName } from '@/lib/model-runtime';

type ChatRequest = {
  runtime: RuntimeName;
  modelId?: string;
  query: string;
  options?: {
    topK?: number;
    minScore?: number;
    temperature?: number;
    systemPrompt?: string;
    sourceFilter?: string[];
    embeddingModelId?: string;
    embeddingRuntime?: RuntimeName;
  };
};

export async function POST(req: Request) {
  let body: ChatRequest;

  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const query = body.query?.trim();
  if (!query) {
    return Response.json({ error: 'query is required' }, { status: 400 });
  }

  const runtime = body.runtime || 'lmstudio';
  const modelId = body.modelId?.trim();
  const topK = body.options?.topK ?? 5;
  const minScore = body.options?.minScore ?? 0.2;
  const sourceFilter =
    body.options?.sourceFilter?.map(item => item.trim()).filter(Boolean) ?? [];
  const embeddingModelId = body.options?.embeddingModelId?.trim();
  const embeddingRuntime = body.options?.embeddingRuntime;
  const start = Date.now();

  let hits: Awaited<ReturnType<typeof searchChunks>>;
  try {
    hits = await searchChunks(
      runtime,
      query,
      topK,
      minScore,
      sourceFilter,
      embeddingModelId,
      embeddingRuntime,
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? `Retrieval failed: ${error.message}`
            : 'Retrieval failed',
      },
      { status: 400 },
    );
  }

  if (hits.length === 0) {
    return Response.json({
      answer:
        sourceFilter.length > 0
          ? 'No matches found in the selected document scope. Broaden the scope or ingest more files.'
          : 'No indexed documents found. Ingest files first, then retry your question.',
      citations: [],
      retrieval: {
        topK,
        matched: 0,
        latencyMs: Date.now() - start,
      },
      warnings: ['no_indexed_chunks'],
    });
  }

  const citations = hits.map(item => ({
    source: item.source,
    page: item.page,
    chunk_id: item.id,
    snippet: item.text.slice(0, 220),
    score: item.score,
  }));

  const context = hits
    .map(
      (item, index) =>
        `[${index + 1}] Source: ${item.source}${item.page !== null ? ` (page ${item.page})` : ''}\n${item.text}`,
    )
    .join('\n\n---\n\n');

  const systemPrompt =
    body.options?.systemPrompt?.trim() ||
    'Answer only from the provided context. If the context is insufficient, explicitly say what is missing. Include citations like [1], [2].';

  let answer: string;
  let generationWarning: string | undefined;
  try {
    answer = await generateGroundedAnswer({
      runtime,
      modelId,
      prompt: `${systemPrompt}\n\nQuestion:\n${query}\n\nContext:\n${context}\n\nReturn a concise answer with citations.`,
      timeoutMs: 45_000,
    });
  } catch (error) {
    generationWarning =
      error instanceof Error ? `generation_failed: ${error.message}` : 'generation_failed';

    answer = [
      'Model generation unavailable. Returning retrieved context excerpts:',
      ...hits.map(
        (item, index) =>
          `[${index + 1}] ${item.text.slice(0, 260).trim()} (${item.source})`,
      ),
    ].join('\n\n');
  }

  return Response.json({
    answer,
    citations,
    retrieval: {
      topK,
      matched: hits.length,
      latencyMs: Date.now() - start,
    },
    warnings: [
      ...(hits.length < 2
        ? ['low_retrieval_confidence_only_one_chunk_matched']
        : []),
      ...(generationWarning ? [generationWarning] : []),
    ],
  });
}
