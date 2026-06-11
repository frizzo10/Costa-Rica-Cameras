// TheDeck AI — alert-ingest
// Flow: camera emails a motion alert → CloudMailin POSTs it here →
// Claude Vision classifies the snapshot → log to Supabase → WhatsApp via Twilio.
//
// Required env vars (set in Netlify → Site settings → Environment variables):
//   ANTHROPIC_API_KEY        your Anthropic key
//   SUPABASE_URL             https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY     service_role key (server-side only — never in index.html)
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_WHATSAPP_FROM     e.g. whatsapp:+14155238886 (Twilio sandbox or your number)
//   ALERT_WHATSAPP_TO        e.g. whatsapp:+506XXXXXXXX
//   INGEST_SECRET            random string; CloudMailin URL must include ?key=<secret>
// Optional:
//   CLAUDE_MODEL             defaults to claude-sonnet-4-20250514
//   MIN_THREAT_TO_NOTIFY     1–3, default 2 (1=info, 2=attention, 3=urgent)

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const MIN_THREAT = parseInt(process.env.MIN_THREAT_TO_NOTIFY || "2", 10);

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  // --- auth: shared secret in query string ---
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== process.env.INGEST_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let mail;
  try {
    mail = await req.json(); // CloudMailin "JSON (Normalized)" format
  } catch {
    return new Response("Expected JSON body", { status: 400 });
  }

  // --- identify which camera sent this ---
  // Convention: camera name in the email subject, OR plus-addressing
  // (alerts+frontgate@yourdomain → camera "frontgate").
  const subject = mail.headers?.subject || mail.subject || "";
  const toAddr = (mail.envelope?.to || mail.headers?.to || "").toString();
  const plusMatch = toAddr.match(/\+([a-z0-9_-]+)@/i);
  const camera = plusMatch ? plusMatch[1] : guessCameraFromSubject(subject);

  // --- pull the first image attachment ---
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
    const base64 = img.content || img.data; // CloudMailin sends base64 in `content`
    const mediaType = img.content_type || img.contentType || "image/jpeg";

    // 1) Classify with Claude Vision
    try {
      verdict = await classify(base64, mediaType, camera, subject);
    } catch (e) {
      console.error("Claude classify failed:", e.message);
    }

    // 2) Store snapshot in Supabase Storage (public bucket: deck-snapshots)
    try {
      snapshotUrl = await uploadSnapshot(base64, mediaType, camera);
    } catch (e) {
      console.error("Snapshot upload failed:", e.message);
    }
  }

  // 3) Log the event (every event — false alarms included, so the
  //    dashboard shows what the AI filtered out for you)
  const row = {
    camera,
    subject,
    category: verdict.category,
    threat_level: verdict.threat_level,
    summary: verdict.summary,
    snapshot_url: snapshotUrl,
    notified: false,
  };

  // 4) Notify only if it clears the threat bar (kills jungle false alarms)
  if (verdict.threat_level >= MIN_THREAT && verdict.category !== "false_alarm") {
    try {
      await sendWhatsApp(
        `🌴 TheDeck AI — ${camera.toUpperCase()}\n` +
          `${labelFor(verdict.category)} · threat ${verdict.threat_level}/3\n` +
          `${verdict.summary}`,
        snapshotUrl
      );
      row.notified = true;
    } catch (e) {
      console.error("WhatsApp send failed:", e.message);
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
                `This is a motion-alert snapshot from a home security camera ("${camera}") at a rural property in the Costa Rican jungle. ` +
                `Email subject: "${subject}". ` +
                `Vegetation moving in wind, rain, insects near the lens, shifting shadows, and light changes are FALSE ALARMS. ` +
                `Classify what triggered this alert. Respond with ONLY a JSON object, no markdown fences:\n` +
                `{"category":"person|vehicle|animal|false_alarm|unclear","threat_level":1|2|3,"summary":"one short sentence describing what you see"}\n` +
                `threat_level: 1 = routine/no concern (known-looking activity, animals), 2 = worth a look (unexpected person/vehicle in daytime), 3 = urgent (person near house at night, someone at a door/gate, attempted entry).`,
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

// ---------- Twilio WhatsApp ----------
async function sendWhatsApp(body, mediaUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const params = new URLSearchParams({
    From: process.env.TWILIO_WHATSAPP_FROM,
    To: process.env.ALERT_WHATSAPP_TO,
    Body: body,
  });
  if (mediaUrl) params.append("MediaUrl", mediaUrl);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization:
          "Basic " +
          Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params,
    }
  );
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
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

function labelFor(cat) {
  return (
    { person: "🚶 Person", vehicle: "🚗 Vehicle", animal: "🐒 Animal", unclear: "❓ Unclear" }[
      cat
    ] || "⚠️ Alert"
  );
}
