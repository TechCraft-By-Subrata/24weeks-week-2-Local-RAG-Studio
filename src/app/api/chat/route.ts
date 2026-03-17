import { searchChunks } from '@/lib/rag-store';

type ChatRequest = {
  query: string;
  options?: {
    topK?: number;
    minScore?: number;
    temperature?: number;
    systemPrompt?: string;
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

  const topK = body.options?.topK ?? 5;
  const minScore = body.options?.minScore ?? 0.2;
  const start = Date.now();

  const hits = await searchChunks(query, topK, minScore);

  if (hits.length === 0) {
    return Response.json({
      answer:
        'No indexed documents found. Ingest files first, then retry your question.',
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

  const answer = [
    'Grounded answer (prototype):',
    ...hits.map(
      (item, index) =>
        `[${index + 1}] ${item.text.slice(0, 260).trim()} (${item.source})`,
    ),
  ].join('\n\n');

  return Response.json({
    answer,
    citations,
    retrieval: {
      topK,
      matched: hits.length,
      latencyMs: Date.now() - start,
    },
    warnings:
      hits.length < 2
        ? ['low_retrieval_confidence_only_one_chunk_matched']
        : undefined,
  });
}
