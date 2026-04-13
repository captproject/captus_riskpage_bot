// ─── Retry Utility ────────────────────────────────────────────────────────────
// Generic retry wrapper with configurable attempts and delay

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
  label: string = "operation"
): Promise<T | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) {
        console.log(`[Retry] ${label} succeeded on attempt ${attempt}`);
        return result;
      }
    } catch (err) {
      console.log(`[Retry] ${label} attempt ${attempt}/${maxRetries} failed: ${(err as Error).message}`);
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.log(`[Retry] ${label} failed after ${maxRetries} attempts`);
  return null;
}

// ─── Timeout Guard ────────────────────────────────────────────────────────────
// Wraps any async function with a max execution time

export function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Timeout] ${label} exceeded ${timeoutMs / 1000}s limit — killed`));
    }, timeoutMs);

    fn()
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}
