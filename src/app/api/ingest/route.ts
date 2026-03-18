import { getIngestStats, ingestDocument } from '@/lib/rag-store';
import { type RuntimeName } from '@/lib/model-runtime';

export const runtime = 'nodejs';

type IngestRequest = {
  runtime: RuntimeName;
  files: Array<{
    name: string;
    mimeType: 'text/markdown' | 'application/pdf' | 'text/plain';
    contentBase64: string;
  }>;
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
    embeddingModelId?: string;
    embeddingRuntime?: RuntimeName;
    embeddingBaseUrl?: string;
    embeddingApiKey?: string;
    vectorDbUrl?: string;
  };
};

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf-8');
}

async function extractTextFromFile(file: {
  mimeType: 'text/markdown' | 'application/pdf' | 'text/plain';
  contentBase64: string;
}): Promise<string> {
  if (file.mimeType === 'application/pdf') {
    const bytes = Buffer.from(file.contentBase64, 'base64');
    const pdfModule = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = (pdfModule.default ?? pdfModule) as (buffer: Buffer) => Promise<{ text?: string }>;
    const result = await pdfParse(bytes);
    return result.text?.trim() ?? '';
  }

  return decodeBase64(file.contentBase64).trim();
}

export async function POST(req: Request) {
  try {
    let body: IngestRequest;

    try {
      body = (await req.json()) as IngestRequest;
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (!Array.isArray(body.files) || body.files.length === 0) {
      return Response.json({ error: 'files[] is required' }, { status: 400 });
    }

    const runtime = body.runtime || 'lmstudio';
    if (runtime !== 'foundry' && runtime !== 'lmstudio' && runtime !== 'openai') {
      return Response.json({ error: 'runtime must be foundry, lmstudio, or openai' }, { status: 400 });
    }
    const chunkSize = body.options?.chunkSize ?? 800;
    const chunkOverlap = body.options?.chunkOverlap ?? 120;
    const embeddingModelId = body.options?.embeddingModelId?.trim();
    const embeddingRuntime = body.options?.embeddingRuntime;
    const embeddingBaseUrl = body.options?.embeddingBaseUrl?.trim();
    const embeddingApiKey = body.options?.embeddingApiKey?.trim();
    const vectorDbUrl = body.options?.vectorDbUrl?.trim();

    const skipped: Array<{ name: string; reason: string }> = [];
    const errors: Array<{ name: string; message: string }> = [];
    let chunksIndexed = 0;
    let documentsIndexed = 0;

    for (const file of body.files) {
      if (
        file.mimeType !== 'text/markdown' &&
        file.mimeType !== 'text/plain' &&
        file.mimeType !== 'application/pdf'
      ) {
        skipped.push({ name: file.name, reason: 'unsupported_mime_type' });
        continue;
      }

      try {
        const text = await extractTextFromFile(file);
        if (!text) {
          skipped.push({ name: file.name, reason: 'empty_text' });
          continue;
        }

        const records = await ingestDocument({
          runtime,
          source: file.name,
          text,
          chunkSize,
          chunkOverlap,
          embeddingModelId,
          embeddingRuntime,
          embeddingBaseUrl,
          embeddingApiKey,
          vectorDbUrl,
        });

        if (records.length === 0) {
          skipped.push({ name: file.name, reason: 'no_chunks_generated' });
          continue;
        }

        documentsIndexed += 1;
        chunksIndexed += records.length;
      } catch (error) {
        errors.push({
          name: file.name,
          message: error instanceof Error ? error.message : 'Unknown ingest error',
        });
      }
    }

    const totals = await getIngestStats(vectorDbUrl);
    const success = documentsIndexed > 0 && errors.length === 0;

    return Response.json({
      success,
      documentsIndexed,
      chunksIndexed,
      skipped,
      errors,
      message:
        documentsIndexed === 0
          ? 'No documents were indexed. This usually means empty/unsupported text extraction (common with scanned PDFs).'
          : undefined,
      totals,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Unexpected ingest error',
      },
      { status: 500 },
    );
  }
}
