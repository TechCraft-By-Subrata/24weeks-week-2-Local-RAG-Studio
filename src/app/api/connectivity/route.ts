import { getEmbeddingsWithModel, generateGroundedAnswer } from '@/lib/model-runtime';
import { getIngestStats } from '@/lib/rag-store';

type ConnectivityRequest =
  | {
      target: 'chat';
      baseUrl?: string;
      apiKey?: string;
      modelId?: string;
    }
  | {
      target: 'embedding';
      baseUrl?: string;
      apiKey?: string;
      modelId?: string;
    }
  | {
      target: 'vector';
      vectorDbUrl?: string;
    };

export async function POST(req: Request) {
  let body: ConnectivityRequest;

  try {
    body = (await req.json()) as ConnectivityRequest;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (body.target === 'chat') {
    const baseUrl = body.baseUrl?.trim();
    const modelId = body.modelId?.trim();

    if (!baseUrl || !modelId) {
      return Response.json(
        { error: 'baseUrl and modelId are required for chat test' },
        { status: 400 },
      );
    }

    try {
      const output = await generateGroundedAnswer({
        runtime: 'openai',
        modelId,
        prompt: 'Reply with exactly: ok',
        timeoutMs: 20_000,
        remote: {
          baseUrl,
          apiKey: body.apiKey?.trim(),
        },
      });

      return Response.json({
        success: true,
        message: `Chat test passed. Model responded: ${output.slice(0, 140)}`,
      });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : 'Chat connectivity test failed',
        },
        { status: 400 },
      );
    }
  }

  if (body.target === 'embedding') {
    const baseUrl = body.baseUrl?.trim();
    const modelId = body.modelId?.trim();

    if (!baseUrl || !modelId) {
      return Response.json(
        { error: 'baseUrl and modelId are required for embedding test' },
        { status: 400 },
      );
    }

    try {
      const result = await getEmbeddingsWithModel(
        'openai',
        ['connectivity probe'],
        modelId,
        {
          baseUrl,
          apiKey: body.apiKey?.trim(),
        },
      );

      const dimensions = result.embeddings[0]?.length ?? 0;
      return Response.json({
        success: true,
        message: `Embedding test passed. Vector dimensions: ${dimensions}`,
      });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : 'Embedding connectivity test failed',
        },
        { status: 400 },
      );
    }
  }

  if (body.target === 'vector') {
    const vectorDbUrl = body.vectorDbUrl?.trim();
    if (!vectorDbUrl) {
      return Response.json({ error: 'vectorDbUrl is required for vector test' }, { status: 400 });
    }

    try {
      const totals = await getIngestStats(vectorDbUrl);
      return Response.json({
        success: true,
        message: `Chroma test passed. Current totals: ${totals.documentsIndexed} docs, ${totals.chunksIndexed} chunks.`,
      });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : 'Chroma connectivity test failed',
        },
        { status: 400 },
      );
    }
  }

  return Response.json(
    { error: 'target must be one of: chat, embedding, vector' },
    { status: 400 },
  );
}
