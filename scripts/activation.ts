import type { Config } from "../src/config/index.js";
import { appOrigin } from "../src/setup/app-url.js";
export class ActivationError extends Error {}
export async function activate(
  c: Config,
  configureScheduler: (origin: string, secret: string) => Promise<void>,
  request: typeof fetch = fetch,
) {
  let origin: string;
  try {
    origin = appOrigin(c.APP_URL);
    if (c.CRON_SECRET.length < 24) throw new Error();
  } catch {
    throw new ActivationError("activation_configuration_invalid");
  }
  try {
    const health = await request(`${origin}/api/health`, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!health.ok) throw new Error();
    const body: any = await health.json();
    if (
      body.alive !== true ||
      body.database !== true ||
      body.configured !== true
    )
      throw new Error();
  } catch {
    throw new ActivationError("production_health_failed");
  }
  try {
    const response = await request(`${origin}/api/setup/telegram`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.CRON_SECRET}` },
      signal: AbortSignal.timeout(90000),
      redirect: "error",
    });
    if (!response.ok) throw new Error();
    const body: any = await response.json();
    if (
      body.ok !== true ||
      body.telegram !== "ok" ||
      body.webhook !== "registered"
    )
      throw new Error();
  } catch {
    throw new ActivationError("production_telegram_setup_failed");
  }
  // No connection or DB writes until the production endpoint confirms success.
  try {
    await configureScheduler(origin, c.CRON_SECRET);
  } catch {
    throw new ActivationError("scheduler_setup_failed");
  }
}
