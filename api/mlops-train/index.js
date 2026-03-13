/* global module, process, globalThis */

function buildCorsHeaders(req) {
  const configuredOrigins = String(process.env.AZURE_MLOPS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const requestOrigin = String(req?.headers?.origin || '').trim();
  const allowAnyOrigin = configuredOrigins.length === 0 || configuredOrigins.includes('*');
  const allowedOrigin = allowAnyOrigin
    ? '*'
    : (configuredOrigins.includes(requestOrigin) ? requestOrigin : configuredOrigins[0]);

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function safeJson(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string') return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function normalizeAction(req) {
  const actionFromRoute = String(req?.params?.action || '').trim().toLowerCase();
  const actionFromQuery = String(req?.query?.action || '').trim().toLowerCase();
  return actionFromRoute || actionFromQuery || 'status';
}

function getJobStore() {
  if (!globalThis.__vetorizadorMlopsJobs) {
    globalThis.__vetorizadorMlopsJobs = new Map();
  }
  return globalThis.__vetorizadorMlopsJobs;
}

function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeDataset(dataset = {}) {
  const runs = Array.isArray(dataset?.runs) ? dataset.runs : [];
  const feedback = Array.isArray(dataset?.feedback) ? dataset.feedback : [];
  return {
    runs: runs.length,
    feedback: feedback.length,
    exportedAt: dataset?.exportedAt || dataset?.exportDate || new Date().toISOString()
  };
}

function inferDryRunState(job) {
  const elapsedMs = Date.now() - Number(job?.createdAtMs || Date.now());
  if (job?.status === 'promoted') return 'promoted';
  if (elapsedMs < 15000) return 'queued';
  if (elapsedMs < 60000) return 'running';
  return 'succeeded';
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body || {})
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
    text
  };
}

function getRequestApiKey(req) {
  return String(req?.headers?.['x-api-key'] || req?.headers?.['X-API-KEY'] || '').trim();
}

function isRequestAuthorized(req) {
  const expected = String(process.env.AZURE_MLOPS_TRIGGER_KEY || '').trim();
  if (!expected) return true;
  return getRequestApiKey(req) === expected;
}

module.exports = async function handler(context, req) {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: corsHeaders, body: '' };
    return;
  }

  if (!isRequestAuthorized(req)) {
    context.res = {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: { error: 'Unauthorized trigger key.' }
    };
    return;
  }

  const action = normalizeAction(req);
  const body = safeJson(req.body);
  const startUrl = String(process.env.AZURE_MLOPS_START_URL || '').trim();
  const statusUrl = String(process.env.AZURE_MLOPS_STATUS_URL || '').trim();
  const promoteUrl = String(process.env.AZURE_MLOPS_PROMOTE_URL || '').trim();
  const apiKey = String(process.env.AZURE_MLOPS_API_KEY || '').trim();
  const proxyHeaders = apiKey ? { 'x-api-key': apiKey } : {};

  try {
    if (action === 'start') {
      const dataset = body?.dataset || {};
      const options = body?.options || {};
      const summary = summarizeDataset(dataset);
      const jobId = createJobId();

      if (startUrl) {
        const upstream = await postJson(startUrl, {
          jobId,
          summary,
          dataset,
          options,
          source: 'vetorizador-ui'
        }, proxyHeaders);

        if (!upstream.ok) {
          context.res = {
            status: upstream.status || 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: {
              ok: false,
              error: 'MLOps start upstream failed.',
              details: upstream.payload || upstream.text || null
            }
          };
          return;
        }

        context.res = {
          status: 202,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: {
            ok: true,
            mode: 'remote',
            jobId: upstream.payload?.jobId || jobId,
            summary,
            status: upstream.payload?.status || 'queued'
          }
        };
        return;
      }

      const store = getJobStore();
      store.set(jobId, {
        jobId,
        summary,
        status: 'queued',
        createdAtMs: Date.now(),
        promoted: false,
        mode: 'dry-run'
      });

      context.res = {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: {
          ok: true,
          mode: 'dry-run',
          jobId,
          summary,
          status: 'queued',
          note: 'Configure AZURE_MLOPS_START_URL to acionar treino real no Azure sem portal.'
        }
      };
      return;
    }

    if (action === 'status') {
      const jobId = String(req?.query?.jobId || body?.jobId || '').trim();
      if (!jobId) {
        context.res = {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: { ok: false, error: 'jobId is required.' }
        };
        return;
      }

      if (statusUrl) {
        const resolved = statusUrl.replace('{jobId}', encodeURIComponent(jobId));
        const upstream = await fetch(resolved, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...proxyHeaders
          }
        });
        const text = await upstream.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }

        context.res = {
          status: upstream.status || 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: payload || { ok: upstream.ok, raw: text }
        };
        return;
      }

      const store = getJobStore();
      const job = store.get(jobId);
      if (!job) {
        context.res = {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: { ok: false, error: 'Job not found.' }
        };
        return;
      }

      const status = inferDryRunState(job);
      if (status === 'succeeded') {
        job.status = 'succeeded';
      }

      context.res = {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: {
          ok: true,
          mode: 'dry-run',
          jobId,
          status,
          summary: job.summary,
          promoted: job.promoted || false
        }
      };
      return;
    }

    if (action === 'promote') {
      const jobId = String(body?.jobId || req?.query?.jobId || '').trim();
      if (!jobId) {
        context.res = {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: { ok: false, error: 'jobId is required.' }
        };
        return;
      }

      if (promoteUrl) {
        const upstream = await postJson(promoteUrl, { jobId, source: 'vetorizador-ui' }, proxyHeaders);
        context.res = {
          status: upstream.status || 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: upstream.payload || { ok: upstream.ok, raw: upstream.text }
        };
        return;
      }

      const store = getJobStore();
      const job = store.get(jobId);
      if (!job) {
        context.res = {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: { ok: false, error: 'Job not found.' }
        };
        return;
      }

      job.promoted = true;
      job.status = 'promoted';

      context.res = {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: {
          ok: true,
          mode: 'dry-run',
          jobId,
          status: 'promoted',
          note: 'Configure AZURE_MLOPS_PROMOTE_URL para promoção real de modelo no Azure ML.'
        }
      };
      return;
    }

    context.res = {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: { ok: false, error: 'Ação inválida. Use start, status ou promote.' }
    };
  } catch (error) {
    context.res = {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: {
        ok: false,
        error: 'Falha na orquestração de treino MLOps.',
        details: String(error?.message || error)
      }
    };
  }
};
