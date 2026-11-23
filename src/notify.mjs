import { setVapidDetails, sendNotification } from 'web-push';
import nodemailer from 'nodemailer';

export function pushReady(publicKey, siteUrl) {
  if (!process.env.VAPID_PRIVATE_KEY) return false;
  // Safari rejects a VAPID subject on localhost; the live site URL is accepted.
  setVapidDetails(siteUrl, publicKey, process.env.VAPID_PRIVATE_KEY);
  return true;
}

export async function sendPush(subscriptions, payload) {
  const dead = [];
  let sent = 0;
  for (const sub of subscriptions) {
    try {
      await sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
      else console.log(`push failed (${e.statusCode ?? e.message})`);
    }
  }
  return { sent, dead };
}

export function emailReady() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.ALERT_EMAIL_TO);
}

export async function sendEmail({ subject, text, html }) {
  const transport = nodemailer.createTransport({
    service: 'Gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({
    from: `Book Watch <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL_TO,
    subject,
    text,
    html,
  });
}
