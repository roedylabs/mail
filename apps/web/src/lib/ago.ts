/** Time span until now ("2 hours ago"), e.g. for users, invitations and recently tested mail servers. */
import { m } from '#lib/paraglide/messages.js';

/** "just now", "5 minutes ago", "47 hours ago", from two days on in days. */
export function ago(t: number, now = Date.now()): string {
  const minutes = Math.floor((now - t) / 60000);
  const hours = Math.floor(minutes / 60);
  if (minutes < 1) return m.ago_now();
  if (minutes < 60) return minutes === 1 ? m.ago_minute() : m.ago_minutes({ n: minutes });
  if (hours < 48) return hours === 1 ? m.ago_hour() : m.ago_hours({ n: hours });
  return m.ago_days({ n: Math.floor(hours / 24) });
}
