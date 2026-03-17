import { ChromaClient, type Collection } from 'chromadb';
import { getEmbeddings } from './model-runtime';

export type IndexedChunk = {
  id: string;
  source: string;
  page: number | null;
  chunkId: string;
  text: string;
  tokenCount: number;
  createdAt: string;
};

const CHROMA_COLLECTION_NAME = 'rag-studio-collection';

let collection: Collection | null = null;

async function getCollection(): Promise<Collection> {
  if (collection) {
    return collection;
  }

  const client = new ChromaClient({ path: './.chroma_db' });
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
  source: string;
  text: string;
  page?: number | null;
  chunkSize: number;
  chunkOverlap: number;
}) {
  const parts = chunkText(args.text, args.chunkSize, args.chunkOverlap);
  if (parts.length === 0) {
    return [];
  }

  const embeddings = await getEmbeddings(parts);
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
    };
  });

  await collection.add({
    ids: records.map(r => r.id),
    embeddings: embeddings,
    documents: records.map(r => r.text),
    metadatas: records.map(r => ({ source: r.source, page: r.page, createdAt: r.createdAt })),
  });
  
  return records;
}

export async function searchChunks(query: string, topK: number, minScore: number) {
  const queryEmbedding = await getEmbeddings([query]);
  const collection = await getCollection();

  const results = await collection.query({
    queryEmbeddings: queryEmbedding,
    nResults: topK,
  });

  if (!results.ids || results.ids.length === 0 || results.ids[0].length === 0) {
    return [];
  }
  
  const hits = results.ids[0].map((id, index) => {
    const distance = results.distances![0][index];
    const score = 1.0 - distance;
    return {
      id: id,
      chunkId: id,
      source: results.metadatas![0][index]!.source as string,
      page: results.metadatas![0][index]!.page as number | null,
      text: results.documents![0][index]!,
      score: score,
    };
  });

  return hits.filter(h => h.score >= minScore);
}

export async function getIngestStats() {
  const collection = await getCollection();
  const count = await collection.count();
  
  // Note: getting distinct sources is not straightforward in ChromaDB without querying everything.
  // We will return the chunk count for now. A more robust solution could be to store metadata
  // in a separate database or use a different approach.
  return {
    documentsIndexed: 0, // This is now an estimate.
    chunksIndexed: count,
  };
}

export async function deleteAllDocuments() {
  const collection = await getCollection();
  await collection.delete();
}
