import {
  deleteAllDocuments,
  deleteDocumentBySource,
  getIngestStats,
  listIndexedDocuments,
} from '@/lib/rag-store';

export async function GET() {
  try {
    const [documents, totals] = await Promise.all([
      listIndexedDocuments(),
      getIngestStats(),
    ]);
    return Response.json({ documents, totals });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch indexed documents',
      },
      { status: 500 },
    );
  }
}

type DeleteRequest = {
  source?: string;
  deleteAll?: boolean;
};

export async function DELETE(req: Request) {
  try {
    let body: DeleteRequest;

    try {
      body = (await req.json()) as DeleteRequest;
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (body.deleteAll) {
      await deleteAllDocuments();
    } else if (body.source?.trim()) {
      await deleteDocumentBySource(body.source);
    } else {
      return Response.json(
        { error: 'Provide source or set deleteAll=true' },
        { status: 400 },
      );
    }

    const [documents, totals] = await Promise.all([
      listIndexedDocuments(),
      getIngestStats(),
    ]);
    return Response.json({ success: true, documents, totals });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to delete documents',
      },
      { status: 500 },
    );
  }
}
