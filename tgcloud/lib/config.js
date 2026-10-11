// Deployment-time constants.

/**
 * The Mini App's URL. `npx tgcloud push` prints it (https://app<id>.tgcloud.ai/)
 * — paste it here and push again to light up /app and the dashboard button.
 * Left null, the bot simply says the dashboard is not wired up yet.
 */
export const MINIAPP_URL = null;

/** Bot API caps `getFile` downloads at 20 MB; stay a little under it. */
export const MAX_DOWNLOAD_BYTES = 19 * 1024 * 1024;

/** A book untouched for this long gets the quarantine question. */
export const QUARANTINE_IDLE_DAYS = 14;

/** Hour (local) at which the Monday digest goes out. */
export const DIGEST_HOUR = 10;

/** How late a reminder may still be sent, if a tick was missed. */
export const REMINDER_GRACE_MINUTES = 90;

/** Default length of a /commit contract. */
export const CONTRACT_DAYS = 30;
