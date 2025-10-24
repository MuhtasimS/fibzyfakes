function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTimeoutError(error) {
  if (!error) {
    return false;
  }

  return error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNABORTED' ||
    error.code === 'ESOCKETTIMEDOUT' ||
    error.name === 'TimeoutError';
}

function isRetriableError(error) {
  if (!error) {
    return false;
  }

  if (isTimeoutError(error)) {
    return true;
  }

  const status = error?.response?.status ?? error?.status;
  if (status === 429) {
    return true;
  }

  return typeof status === 'number' && status >= 500 && status < 600;
}

async function retryWithBackoff(fn, options = {}) {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 8000,
  } = options;

  let attempt = 0;
  let lastError;

  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt += 1;

      if (attempt >= maxAttempts || !isRetriableError(error)) {
        throw error;
      }

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * backoff;
      await delay(jitter);
    }
  }

  throw lastError;
}

export {
  delay,
  retryWithBackoff,
};
