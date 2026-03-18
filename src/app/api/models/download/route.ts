import { startDownloadJob } from '@/lib/model-jobs';
import type { RuntimeName } from '@/lib/model-runtime';

type DownloadRequest = {
  runtime: RuntimeName;
  modelId: string;
};

export async function POST(req: Request) {
  let body: DownloadRequest;

  try {
    body = (await req.json()) as DownloadRequest;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.modelId?.trim()) {
    return Response.json({ error: 'modelId is required' }, { status: 400 });
  }

  if (body.runtime !== 'foundry' && body.runtime !== 'lmstudio' && body.runtime !== 'openai') {
    return Response.json({ error: 'runtime must be foundry, lmstudio, or openai' }, { status: 400 });
  }

  if (body.runtime === 'openai') {
    return Response.json(
      {
        error: 'Cloud/OpenAI runtime does not support local model downloads. Use provider-managed models by ID.',
      },
      { status: 400 },
    );
  }

  const job = startDownloadJob(body.runtime, body.modelId.trim());
  return Response.json({ job });
}
