import crypto from 'node:crypto';

// Minimal Amazon Bedrock Converse client (SigV4 signed, no SDK dependency).
// On Lambda the credentials come from the function role via environment variables.

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

export class DiscoverError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // network | timeout | access | throttled | model | bedrock
  }
}

export function bedrockConfig() {
  return {
    region: process.env.BEDROCK_REGION || 'us-east-1',
    // Web grounding is only offered with US cross-region profiles of Nova models.
    modelId: process.env.DISCOVER_MODEL_ID || 'us.amazon.nova-2-lite-v1:0',
  };
}

export function hasAwsCredentials() {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

export const signingKey = (secret, date, region, service) =>
  hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');

// Exported for tests: builds the SigV4 headers for a POST request.
export function signRequest({ method = 'POST', host, path, region, service = 'bedrock', body, creds, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20240101T000000Z
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const headers = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'content-type': 'application/json' };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join('');
  const signedHeaders = names.join(';');
  // Non-S3 services double-encode every path segment in the canonical request.
  const canonicalUri = path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = signingKey(creds.secretAccessKey, date, region, service);
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Calls Converse with Amazon Nova web grounding enabled. Returns { text, citations: [{url, domain}] }.
export async function converseWithWebSearch({ system, prompt, maxTokens = 3000, timeoutMs = 45_000 }) {
  if (!hasAwsCredentials()) throw new Error('AWS credentials are not available');
  const { region, modelId } = bedrockConfig();
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/converse`;
  const body = JSON.stringify({
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    toolConfig: { tools: [{ systemTool: { name: 'nova_grounding' } }] },
    inferenceConfig: { maxTokens, temperature: 0.3 },
  });
  const headers = signRequest({
    host, path, region, body,
    creds: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
  });
  delete headers.host; // set by fetch

  let res;
  try {
    res = await fetch(`https://${host}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // No route to the internet from a VPC Lambda looks exactly like this (connect timeout / ENETUNREACH).
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    throw new DiscoverError(timedOut ? 'timeout' : 'network', `Could not reach Bedrock at ${host}: ${e.cause?.code || e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.Message || 'request failed';
    const kind = res.status === 403 ? 'access' : res.status === 429 ? 'throttled' : res.status === 400 || res.status === 404 ? 'model' : 'bedrock';
    throw new DiscoverError(kind, `Bedrock ${res.status}: ${msg}`);
  }

  let text = '';
  const citations = [];
  for (const block of data.output?.message?.content || []) {
    if (block.text) text += block.text;
    const list = Array.isArray(block.citationsContent) ? block.citationsContent : block.citationsContent?.citations || [];
    for (const c of list) {
      const web = c.location?.web;
      if (web?.url) citations.push({ url: web.url, domain: web.domain || null });
    }
  }
  return { text, citations };
}
