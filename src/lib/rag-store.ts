import { ChromaClient, type Collection } from 'chromadb';
import { getEmbeddingsWithModel, type RuntimeName } from './model-runtime';

export type IndexedChunk = {
  id: string;
  source: string;
  page: number | null;
  chunkId: string;
  text: string;
  tokenCount: number;
  createdAt: string;
  embeddingModel: string;
};

export type IndexedDocumentSummary = {
  source: string;
  chunks: number;
  lastIndexedAt: string | null;
  embeddingModels: string[];
};

const CHROMA_COLLECTION_NAME = 'rag-studio-collection';

let collection: Collection | null = null;

async function getCollection(): Promise<Collection> {
  if (collection) {
    return collection;
  }

  const chromaUrl = process.env.CHROMA_URL?.trim() || 'http://localhost:8000';
  let client: ChromaClient;
  try {
    const parsed = new URL(chromaUrl);
    client = new ChromaClient({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
      ssl: parsed.protocol === 'https:',
    });
  } catch {
    throw new Error(
      `Invalid CHROMA_URL value: "${chromaUrl}". Expected a full URL like http://localhost:8000`,
    );
  }

  collection = await client.getOrCreateCollection({ name: CHROMA_COLLECTION_NAME });
  return collection;
}


function normalizeText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function chunkText(
  input: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  const text = normalizeText(input);
  if (!text) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - chunkOverlap, start + 1);
  }

  return chunks;
}

export async function ingestDocument(args: {
  runtime: RuntimeName;
  source: string;
  text: string;
  page?: number | null;
  chunkSize: number;
  chunkOverlap: number;
  embeddingModelId?: string;
}) {
  const parts = chunkText(args.text, args.chunkSize, args.chunkOverlap);
  if (parts.length === 0) {
    return [];
  }

  const embeddingResult = await getEmbeddingsWithModel(
    args.runtime,
    parts,
    args.embeddingModelId,
  );
  const embeddings = embeddingResult.embeddings;
  const collection = await getCollection();

  const records = parts.map((part, index) => {
    const chunkId = `${args.source}::${index + 1}`;
    return {
      id: chunkId,
      source: args.source,
      page: args.page ?? null,
      text: part,
      tokenCount: Math.ceil(part.length / 4),
      createdAt: new Date().toISOString(),
      embeddingModel: embeddingResult.modelId,
    };
  });

  await collection.add({
    ids: records.map(r => r.id),
    embeddings: embeddings,
    documents: records.map(r => r.text),
    metadatas: records.map(r => ({
      source: r.source,
      page: r.page,
      createdAt: r.createdAt,
      embeddingModel: r.embeddingModel,
    })),
  });
  
  return records;
}

export async function searchChunks(
  runtime: RuntimeName,
  query: string,
  topK: number,
  minScore: number,
  sourceFilter?: string[],
  embeddingModelId?: string,
) {
  const queryEmbedding = (
    await getEmbeddingsWithModel(runtime, [query], embeddingModelId)
  ).embeddings;
  const collection = await getCollection();
  const cleanSourceFilter = (sourceFilter ?? []).map(item => item.trim()).filter(Boolean);

  const results = await collection.query({
    queryEmbeddings: queryEmbedding,
    nResults: topK,
    include: ['documents', 'metadatas', 'distances'],
    where:
      cleanSourceFilter.length > 0
        ? { source: { $in: cleanSourceFilter } }
        : undefined,
  });

  const rows = results.rows();
  if (!rows || rows.length === 0 || rows[0].length === 0) {
    return [];
  }
  
  const hits = rows[0].flatMap(row => {
    if (!row.id || !row.document) {
      return [];
    }

    const distance = typeof row.distance === 'number' ? row.distance : null;
    // Chroma distance semantics vary by metric; 1/(1+d) keeps score in [0,1]
    // and avoids dropping valid hits when raw distance is > 1 (common with L2).
    const score = distance === null ? 0.5 : 1 / (1 + Math.max(0, distance));
    const metadata = row.metadata as
      | { source?: string; page?: number | null }
      | null
      | undefined;

    return {
      id: row.id,
      chunkId: row.id,
      source: metadata?.source || 'unknown-source',
      page: metadata?.page ?? null,
      text: row.document,
      score,
    };
  });

  const filtered = hits.filter(h => h.score >= minScore);
  // Fallback: if retrieval found rows but threshold removed all, return top rows
  // instead of an empty result to avoid false "no indexed documents" UX.
  return filtered.length > 0 ? filtered : hits;
}

export async function listIndexedDocuments(): Promise<IndexedDocumentSummary[]> {
  const collection = await getCollection();
  const rows = await collection.get({ include: ['metadatas'], limit: 10_000 });
  const bySource = new Map<string, IndexedDocumentSummary>();

  for (let index = 0; index < rows.ids.length; index += 1) {
    const metadata = rows.metadatas[index] as
      | { source?: string; createdAt?: string; embeddingModel?: string }
      | null
      | undefined;
    const source = metadata?.source;
    if (!source) continue;

    const createdAt = metadata?.createdAt ?? null;
    const embeddingModel = metadata?.embeddingModel?.trim() || 'unknown';
    const current = bySource.get(source);
    if (!current) {
      bySource.set(source, {
        source,
        chunks: 1,
        lastIndexedAt: createdAt,
        embeddingModels: [embeddingModel],
      });
      continue;
    }

    current.chunks += 1;
    if (createdAt && (!current.lastIndexedAt || createdAt > current.lastIndexedAt)) {
      current.lastIndexedAt = createdAt;
    }
    if (!current.embeddingModels.includes(embeddingModel)) {
      current.embeddingModels.push(embeddingModel);
    }
  }

  return Array.from(bySource.values())
    .map(item => ({
      ...item,
      embeddingModels: [...item.embeddingModels].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    }))
    .sort((a, b) =>
      a.source.localeCompare(b.source, undefined, { sensitivity: 'base' }),
    );
}

export async function getIngestStats() {
  const collection = await getCollection();
  const rows = await collection.get({ include: ['metadatas'] });
  const uniqueSources = new Set<string>();

  for (const metadata of rows.metadatas) {
    const source = (metadata as { source?: string } | null)?.source;
    if (source) uniqueSources.add(source);
  }

  return {
    documentsIndexed: uniqueSources.size,
    chunksIndexed: rows.ids.length,
  };
}

export async function deleteAllDocuments() {
  const collection = await getCollection();
  const rows = await collection.get({ include: [] });
  if (rows.ids.length === 0) return;
  await collection.delete({ ids: rows.ids });
}

export async function deleteDocumentBySource(source: string) {
  const clean = source.trim();
  if (!clean) return;
  const collection = await getCollection();
  await collection.delete({ where: { source: clean } });
}
