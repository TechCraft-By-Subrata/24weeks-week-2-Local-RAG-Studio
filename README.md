# Chapter 2: Building a Local RAG System with Next.js and Foundry

Welcome to the second chapter of our journey into building practical, local-first AI applications. In this chapter, we will architect and build a complete Retrieval Augmented Generation (RAG) system from the ground up. Our goal is to create an application that can answer questions based on documents you provide, running entirely on your local machine.

## The "Why": The Power of Local RAG

Large Language Models (LLMs) are incredibly powerful, but their knowledge is limited to the data they were trained on. What if you want to ask questions about your own documents—your notes, research papers, or manuals? This is where Retrieval Augmented Generation (RAG) comes in.

In simple terms, RAG is a technique that "grounds" an LLM in a specific set of data. Instead of relying on its general knowledge, the model is given relevant snippets from your documents to formulate an answer. This has several advantages:
- **Reduces Hallucinations:** The model is less likely to make things up, as it must base its answers on the provided context.
- **Uses Up-to-Date Information:** You can query documents that were created long after the LLM was trained.
- **Private:** By running the entire system locally, your data never leaves your machine.

For this project, we are using a powerful stack of modern technologies:
- **Next.js:** A React framework that provides a robust foundation for both our frontend UI and our backend APIs.
- **Foundry Local:** A runtime for executing LLMs on your local machine. We will use it to power our embedding model.
- **ChromaDB:** A popular, open-source vector database that will store our document chunks and their embeddings.

## The "How": System Architecture

Before we dive into the code, let's take a high-level look at the architecture of our application. The process is split into two main phases: **Ingestion** and **Retrieval/Chat**.

### Phase 1: Ingestion

This is the process of "teaching" our application about a new document.

1.  **File Upload:** The user selects a file (PDF, Markdown, or text) through the Next.js frontend.
2.  **API Request:** The frontend sends the file content to our `/api/ingest` endpoint.
3.  **Text Extraction & Chunking:** The backend extracts the raw text from the file and splits it into smaller, manageable "chunks". This is crucial because LLMs have a limited context window.
4.  **Embedding Generation:** Each chunk of text is converted into a numerical representation called an "embedding" using the `nomic-embed-text-v1` model running via Foundry Local. These embeddings capture the semantic meaning of the text.
5.  **Storage:** The chunks and their corresponding embeddings are stored in our Chroma vector database.

### Phase 2: Retrieval & Chat

This is the process of asking a question and getting an answer.

1.  **User Query:** The user asks a question in the chat interface.
2.  **API Request:** The frontend sends the query to our `/api/chat` endpoint.
3.  **Query Embedding:** The user's query is also converted into an embedding using the same model.
4.  **Vector Search:** We use this query embedding to search our Chroma database. Chroma finds the text chunks with embeddings that are most similar to the query's embedding. These are the chunks that are most semantically related to the question.
5.  **Response Generation:** The retrieved chunks are then presented to the user. *(In a full-fledged RAG system, these chunks would be passed to a generative LLM to synthesize a final answer. Our current implementation is a prototype that shows the retrieved context directly).*

## The "What": A Deep Dive into the Code

Now, let's explore the key parts of our codebase that bring this architecture to life.

### The Heart of the RAG Pipeline: `src/lib/rag-store.ts`

This file is the engine of our RAG system. It handles chunking, embedding, and interacting with our Chroma vector store.

#### Connecting to ChromaDB

First, we initialize our connection to ChromaDB. We're running it in-process, and it will store its data in a local `.chroma_db` directory.

```typescript
// src/lib/rag-store.ts
import { ChromaClient, type Collection } from 'chromadb';

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
```

#### Ingesting a Document

The `ingestDocument` function orchestrates the ingestion process. It chunks the text, generates embeddings, and adds the data to Chroma.

```typescript
// src/lib/rag-store.ts
import { getEmbeddings } from './model-runtime';

// ...

export async function ingestDocument(args: {
  source: string;
  text: string;
  chunkSize: number;
  chunkOverlap: number;
}) {
  const parts = chunkText(args.text, args.chunkSize, args.chunkOverlap);
  if (parts.length === 0) {
    return [];
  }

  // 1. Generate embeddings for all chunks in parallel
  const embeddings = await getEmbeddings(parts);
  const collection = await getCollection();

  const records = parts.map((part, index) => {
    // ... create metadata records ...
  });

  // 2. Add the chunks, embeddings, and metadata to Chroma
  await collection.add({
    ids: records.map(r => r.id),
    embeddings: embeddings,
    documents: records.map(r => r.text),
    metadatas: /* ... */,
  });
  
  return records;
}
```

### Generating Embeddings: `src/lib/model-runtime.ts`

This file is our bridge to the local model runtime. The `getEmbeddings` function is responsible for calling the Foundry CLI to run our embedding model.

```typescript
// src/lib/model-runtime.ts
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const modelId = 'nomic-embed-text-v1';
  const payload = JSON.stringify({ texts });

  // We assume the 'foundry' command is in the system's PATH
  const foundryPath = 'foundry';

  const result = await runCommandWithInput(foundryPath, ['model', 'run', modelId], payload);

  if (!result.ok) {
    throw new Error(`Failed to get embeddings: ${result.stderr}`);
  }
  // ... parse and return embeddings ...
}
```
*For more details on the embedding model, see the [nomic-embed-text-v1 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1).*

### Searching for Answers: The Chat API

The chat process starts at `/api/chat/route.ts` and uses the `searchChunks` function in our `rag-store`.

```typescript
// src/app/api/chat/route.ts
import { searchChunks } from '@/lib/rag-store';

// ...
export async function POST(req: Request) {
  // ... get query from request ...
  
  const hits = await searchChunks(query, topK, minScore);

  // ... format and return the results ...
}
```

The `searchChunks` function completes the RAG loop. It generates an embedding for the user's query and uses it to find the most relevant documents in Chroma.

```typescript
// src/lib/rag-store.ts
export async function searchChunks(query: string, topK: number, minScore: number) {
  const queryEmbedding = await getEmbeddings([query]);
  const collection = await getCollection();

  const results = await collection.query({
    queryEmbeddings: queryEmbedding,
    nResults: topK,
  });
  
  // ... process and return the search results ...
}
```
The `collection.query` method is the core of the retrieval step. It performs a vector similarity search to find the chunks that are semantically closest to the user's question.

## Getting Started

To run this project on your machine, you'll need a few prerequisites.

### Prerequisites
- **Node.js:** [Download and install Node.js](https://nodejs.org/).
- **Foundry Local:** Follow the [official Foundry Local installation guide](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/get-started).
- **An Embedding Model:** You need to have the `nomic-embed-text-v1` model available in your Foundry Local runtime. You can typically download it by running:
  ```bash
  foundry model download nomic-embed-text-v1
  ```

### Installation and Running
1.  **Clone the repository and install dependencies:**
    ```bash
    git clone <repository-url>
    cd <repository-directory>
    npm install
    ```
2.  **Run the development server:**
    ```bash
    npm run dev
    ```
3.  **Open the application:** Open [http://localhost:3000](http://localhost:3000) in your browser.

You can now ingest your own documents and start asking questions!

## Further Reading
- [ChromaDB Documentation](https://docs.trychroma.com/)
- [Microsoft Foundry Local Documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/)
- [Introduction to Retrieval Augmented Generation](https://research.ibm.com/blog/retrieval-augmented-generation)
