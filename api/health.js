export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "mn-automation-hub",
    checks: {
      apolloKeySet: !!process.env.APOLLO_API_KEY,
      pipedriveTokenSet: !!process.env.PIPEDRIVE_API_TOKEN,
      instantlyKeySet: !!process.env.INSTANTLY_API_KEY,
      instantlyCampaignSet: !!process.env.INSTANTLY_CAMPAIGN_ID,
      resendKeySet: !!process.env.RESEND_API_KEY,
      kvConfigured: !!process.env.KV_REST_API_URL,
    },
    timestamp: new Date().toISOString(),
  });
}
