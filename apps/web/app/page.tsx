export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', maxWidth: 640, lineHeight: 1.6 }}>
      <h1>IngestIO</h1>
      <p>Open-source background document operations platform.</p>
      <ul>
        <li>Upload a PDF → Supabase Storage</li>
        <li>BullMQ (Upstash Redis) → Gemini extraction workers</li>
        <li>Job state + metadata → Supabase Postgres</li>
        <li>Webhook notification on completion/failure</li>
      </ul>
      <p>
        Scaffold only — see <code>README.md</code> for the architecture, queue
        pipeline, and DLQ strategy.
      </p>
    </main>
  );
}
