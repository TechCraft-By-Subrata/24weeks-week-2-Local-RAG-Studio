# Project Progress: Local RAG Studio

This document outlines the progress of the Local RAG Studio project, comparing the current implementation against the plan described in the [Week 2 blog post](https://subraatakumar.com/24weeks/week-2/).

## Overall Summary

The project has a functional UI and API structure, but the core RAG pipeline is a simplified prototype. Key components like the vector store (Chroma), embeddings, and the generative model have not been implemented yet. The current implementation uses an in-memory array for storing chunks and a basic keyword search for retrieval.

## Feature Breakdown

###  Frontend UI (Next.js)

- **Status:** ✅ Mostly Complete
- **Details:** A comprehensive UI exists for managing models, ingesting documents, and asking questions. It is fully connected to the backend APIs.

### Ingest API (`/api/ingest`)

- **Status:** ✅ Mostly Complete
- **Details:** The API can receive files, extract text from PDFs, Markdown, and plain text, and chunk the text.
- **Deviation:** Instead of generating embeddings and storing them in Chroma, it stores the raw text chunks in an in-memory array.

### Chat API (`/api/chat`)

- **Status:** ⚠️ Partially Complete
- **Details:** The API can receive a query and return a response.
- **Deviation:**
    - It uses a simple keyword-based search on the in-memory chunks instead of a vector similarity search.
    - It does not use a generative AI model. The "answer" is a formatted string of the retrieved chunks.

### Vector Store (Chroma)

- **Status:** ❌ Not Started
- **Details:** The project uses a simple in-memory array (`rag-store.ts`) to store indexed chunks. ChromaDB has not been integrated.

### Embeddings

- **Status:** ❌ Not Started
- **Details:** The current retrieval mechanism is based on a simple `scoreChunk` function that does keyword matching. No embedding models are used.

### Model Runtime

- **Status:** ✅ Mostly Complete
- **Details:** The application can list models from both Foundry and LM Studio, and it can trigger download jobs. This part of the application is well-developed.

## Pending Work

The following items from the original plan are still pending:

- **Integrate ChromaDB:** Replace the in-memory `indexedChunks` array with ChromaDB for persistent and scalable vector storage.
- **Generate Embeddings:** During ingestion, generate embeddings for each text chunk using a model from the selected runtime (Foundry or LM Studio).
- **Implement Vector Search:** In the chat API, use vector similarity search (via Chroma) to retrieve relevant chunks.
- **Integrate a Generative Model:** Use the selected language model to generate a natural language answer based on the retrieved context.
- **Improve Citations:** The citation format is basic and could be improved to be more user-friendly.
