// Costa Rica Cameras — alert-ingest
// Camera email → CloudMailin POST → Claude Vision classify → Supabase log + email alert
//
// Required env vars (Netlify → Site settings → Environment variables):
//   ANTHROPIC_API_KEY
//   SUPABASE_URL             https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY     service_role key
//   INGEST_SECRET            random string; CloudMailin URL includes ?key=<secret>
//   ALERT_EMAIL              your email address for notifications (e.g. frizzo1@gmail.com)
// Optional:
//   CLAUDE_MODEL             defaults to claude-sonnet-4-20250514
//   MIN_THREAT_TO_NOTIFY     1–3, default 2

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const MIN_THREAT = parseInt(process.env.MIN_THREAT_TO_NOTIFY || "2", 10);

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const url = new URL(req.url);
  if (url.searchParams.get("key") !== process.env.INGEST_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let mail;
  try {
    mail = await req.json();
  } catch {
    return new Response("Expected JSON body", { status: 400 });
  }

  const subject = mail.headers?.subject || mail.subject || "";
  const toAddr = (mail.envelope?.to || mail.headers?.to || "").toString();
  const plusMatch = toAddr.match(/\+([a-z0-9_-]+)@/i);
  const camera = plusMatch ? plusMatch[1] : guessCameraFromSubject(subject);

  const attachments = mail.attachments || [];
  const img = attachments.find((a) =>
    (a.content_type || a.contentType || "").startsWith("image/")
  );

  let verdict = {
    category: "unknown",
    threat_level: 2,
    summary: "Motion alert received (no snapshot attached).",
  };
  let snapshotUrl = null;

  if (img) {
    const base64 = img.content || img.data;
    const mediaType = img.content_type || img.contentType || "image/jpeg";

    try {
      verdict = await classify(base64, mediaType, camera, subject);
    } catch (e) {
      console.error("Claude classify failed:", e.message);
    }

    try {
      snapshotUrl = await uploadSnapshot(base64, mediaType, camera);
    } catch (e) {
      console.error("Snapshot upload failed:", e.message);
    }
  }

  const row = {
    camera,
    subject,
    category: verdict.category,
    threat_level: verdict.threat_level,
    summary: verdict.summary,
    snapshot_url: snapshotUrl,
    notified: false,
  };

  // Notify via email if threat clears the bar
  if (verdict.threat_level >= MIN_THREAT && verdict.category !== "false_alarm") {
    try {
      await sendEmailAlert(camera, verdict, snapshotUrl);
      row.notified = true;
    } catch (e) {
      console.error("Email alert failed:", e.message);
    }
  }

  try {
    await insertAlert(row);
  } catch (e) {
    console.error("Supabase insert failed:", e.message);
  }

  return Response.json({ ok: true, camera, verdict, notified: row.notified });
};

// ---------- Claude Vision ----------
async function classify(base64, mediaType, camera, subject) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text:
                `This is a motion-alert snapshot from a security camera ("${camera}") at a rural property in the Costa Rican jungle near Tinamastes. ` +
                `Email subject: "${subject}". ` +
                `Vegetation moving in wind, rain, insects near the lens, shifting shadows, and light changes are FALSE ALARMS — very common here. ` +
                `Classify what triggered this alert. Respond with ONLY a JSON object, no markdown fences:\n` +
                `{"category":"person|vehicle|animal|false_alarm|unclear","threat_level":1|2|3,"summary":"one short sentence describing what you see"}\n` +
                `threat_level: 1 = routine/no concern (animals, known activity), 2 = worth a look (unexpected person/vehicle daytime), 3 = urgent (person near house at night, attempted entry, someone at door/gate).`,
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content?.find((c) => c.type === "text")?.text || "")
    .replace(/```json|```/g, "")
    .trim();
  const parsed = JSON.parse(text);
  return {
    category: parsed.category || "unclear",
    threat_level: Math.min(3, Math.max(1, parseInt(parsed.threat_level, 10) || 2)),
    summary: parsed.summary || "No description.",
  };
}

// ---------- Supabase ----------
async function uploadSnapshot(base64, mediaType, camera) {
  const ext = mediaType.includes("png") ? "png" : "jpg";
  const path = `${camera}/${Date.now()}.${ext}`;
  const bytes = Buffer.from(base64, "base64");
  const res = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/deck-snapshots/${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "content-type": mediaType,
      },
      body: bytes,
    }
  );
  if (!res.ok) throw new Error(`Storage ${res.status}: ${await res.text()}`);
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/deck-snapshots/${path}`;
}

async function insertAlert(row) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/deck_alerts`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// ---------- Email via Supabase Edge (uses project's built-in SMTP) ----------
async function sendEmailAlert(camera, verdict, snapshotUrl) {
  const to = process.env.ALERT_EMAIL;
  if (!to) return;

  const label = { person: "Person", vehicle: "Vehicle", animal: "Animal", unclear: "Unclear" }[verdict.category] || "Alert";
  const threatLabel = ["", "Routine", "Attention", "URGENT"][verdict.threat_level] || "";

  // Use Supabase Auth admin to send a simple email via the project's SMTP
  // Alternative: swap this for Resend, SendGrid, or any email API
  const html = `
    <h2>🌴 ${camera.toUpperCase()} — ${label}</h2>
    <p><strong>Threat:</strong> ${threatLabel} (${verdict.threat_level}/3)</p>
    <p>${verdict.summary}</p>
    ${snapshotUrl ? `<p><a href="${snapshotUrl}">View snapshot</a></p><img src="${snapshotUrl}" style="max-width:400px;border-radius:8px">` : ""}
    <hr><p style="color:#888;font-size:12px"><a href="https://thedeckai.netlify.app">Open dashboard</a></p>
  `;

  // Simple approach: use Supabase's pg_net or http extension to send email
  // For now, log that we would send — swap in your preferred email service
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/send_alert_email`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to_email: to, subject_line: `🌴 ${threatLabel}: ${label} at ${camera}`, html_body: html }),
  });

  // If the Supabase function doesn't exist yet, that's OK — alert still logs to dashboard
  if (!res.ok) {
    console.log(`Email function not set up yet (${res.status}). Alert logged to dashboard.`);
  }
}

// ---------- helpers ----------
function guessCameraFromSubject(subject) {
  const s = subject.toLowerCase();
  const known = [
    "front", "gate", "deck", "pool", "drive", "garage",
    "back", "side", "kitchen", "terrace", "jungle", "cafe",
  ];
  for (const k of known) if (s.includes(k)) return k;
  return "camera";
}
