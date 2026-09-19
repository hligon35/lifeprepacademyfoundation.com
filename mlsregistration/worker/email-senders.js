// Shared email senders:
// - sendEmail: actual outbound email to end users (magic links, newsletters, receipts).
//   Resend is primary, Cloudflare Email Sending is the fallback.
// - sendSystemMessage: inter-system messaging and inbound auto-replies (no end-user
//   deliverability requirement). Cloudflare Email Sending only.

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

async function sendViaCloudflareEmail(env, { to, from, fromName, subject, html, plainText }) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    throw new Error("Cloudflare Email binding (EMAIL) not configured");
  }
  await env.EMAIL.send({
    to,
    from: { email: from, name: fromName },
    subject,
    html,
    text: plainText,
  });
  return { provider: "cloudflare" };
}

async function sendViaResend(env, { to, from, fromName, subject, html, plainText }) {
  const apiKey = text(env.RESEND_API_KEY);
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromName ? `${fromName} <${from}>` : from,
      to: [to],
      subject,
      html,
      text: plainText,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Resend request failed (${response.status}): ${errText || "unknown error"}`);
  }
  return { provider: "resend" };
}

// Tries Resend first, falls back to Cloudflare Email on any failure. Throws only if both fail.
async function sendEmail(env, { to, from, fromName, subject, html, plainText }) {
  const resolvedFrom = from || text(env.RESEND_FROM_EMAIL);
  if (!resolvedFrom) throw new Error("No sender email configured (RESEND_FROM_EMAIL)");

  try {
    return await sendViaResend(env, { to, from: resolvedFrom, fromName, subject, html, plainText });
  } catch (resendError) {
    try {
      return await sendViaCloudflareEmail(env, { to, from: resolvedFrom, fromName, subject, html, plainText });
    } catch (cloudflareError) {
      throw new Error(
        `Email delivery failed via Resend (${resendError.message}) and Cloudflare (${cloudflareError.message})`
      );
    }
  }
}

// Cloudflare Email Sending only — for internal/system messages and inbound auto-replies,
// not end-user-facing sends.
async function sendSystemMessage(env, { to, from, fromName, subject, html, plainText }) {
  const resolvedFrom = from || text(env.RESEND_FROM_EMAIL);
  if (!resolvedFrom) throw new Error("No sender email configured (RESEND_FROM_EMAIL)");
  return sendViaCloudflareEmail(env, { to, from: resolvedFrom, fromName, subject, html, plainText });
}

export { sendEmail, sendSystemMessage };
