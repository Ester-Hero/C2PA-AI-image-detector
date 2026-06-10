import { GoogleAuth } from 'google-auth-library';

// Vercel serverless function — keep this file server-side only.
// Required environment variables in Vercel dashboard:
//   GOOGLE_CLOUD_PROJECT_ID  — your GCP project ID
//   GOOGLE_SERVICE_ACCOUNT_JSON — the full JSON key of a service account
//                                 with "Vertex AI User" role

// NOTE: Verify the exact model name in Google Cloud Console → Vertex AI Model Garden.
// Search for "SynthID" or "watermark detection". Update the constant below if needed.
const SYNTHID_MODEL = 'imagewatermark-detection@001';
const LOCATION = 'us-central1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!projectId || !serviceAccountJson) {
    // Not configured — front-end silently skips SynthID
    return res.status(503).json({ configured: false });
  }

  const { imageBase64 } = req.body ?? {};
  if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

  try {
    // Authenticate with service account
    const auth = new GoogleAuth({
      credentials: JSON.parse(serviceAccountJson),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const accessToken = await auth.getAccessToken();

    const endpoint =
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${LOCATION}/publishers/google/models/${SYNTHID_MODEL}:predict`;

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: [{ content: imageBase64 }],
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data });
    }

    // Parse the prediction — exact field names may vary; adjust if Google changes schema
    const prediction = data.predictions?.[0] ?? {};
    const decision = prediction.decision ?? prediction.watermark?.decision ?? null;
    const score =
      prediction.score ??
      prediction.watermark?.score ??
      prediction.scores?.synthid_score ??
      null;

    return res.json({
      configured: true,
      detected: decision === 'WATERMARK_DETECTED' || decision === 'ACCEPT',
      decision,
      score,
    });
  } catch (err) {
    console.error('[SynthID]', err);
    return res.status(500).json({ error: err.message });
  }
}
