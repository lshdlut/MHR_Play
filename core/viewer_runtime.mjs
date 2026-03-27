const LOG_PREFIX = '[mhr-play]';

export function logStatus(message, detail = null) {
  if (detail == null) {
    console.info(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.info(`${LOG_PREFIX} ${message}`, detail);
}

export function logWarn(message, detail = null) {
  if (detail == null) {
    console.warn(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${LOG_PREFIX} ${message}`, detail);
}

export function logError(message, detail = null) {
  if (detail == null) {
    console.error(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.error(`${LOG_PREFIX} ${message}`, detail);
}

export function strictCatch(error, label) {
  logError(label, error);
  throw error;
}
