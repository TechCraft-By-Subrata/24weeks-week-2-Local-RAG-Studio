import { NextRequest } from 'next/server';
import { listJobs } from '@/lib/model-jobs';
import { listModels, type RuntimeName } from '@/lib/model-runtime';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const runtime =
    (req.nextUrl.searchParams.get('runtime') as RuntimeName | null) ?? 'lmstudio';

  if (runtime !== 'foundry' && runtime !== 'lmstudio') {
    return Response.json({ error: 'runtime must be foundry or lmstudio' }, { status: 400 });
  }

  const result = await listModels(runtime);

  return Response.json({
    runtime,
    models: result.models,
    warning: result.warning,
    jobs: listJobs().filter(job => job.runtime === runtime),
  });
}
