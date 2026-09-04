/**
 * Layer 2 tests for clockService.withRetry.
 *
 * Verifies the retry wrapper that protects punch writes against transient
 * network failures (root cause of the employee's stuck open shifts on
 * 06-15/06-24/06-25/07-10). Validation errors must NOT be retried (they're
 * deterministic); network-class errors must be retried with backoff.
 */
jest.mock('../app/lib/firebase', () => ({ db: {} }));

import { withRetry } from './clockService';

describe('withRetry — Layer 2 write retry', () => {
  it('returns the result on first success (no retry)', async () => {
    const op = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(op, { label: 'test' });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on transient network errors and succeeds on a later attempt', async () => {
    const op = jest
      .fn()
      .mockRejectedValueOnce(new Error('network request failed'))
      .mockRejectedValueOnce(new Error('OFFLINE'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(op, { label: 'test', retries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry deterministic validation errors (e.g. "No open shift")', async () => {
    const op = jest.fn().mockRejectedValue(new Error('No open shift to clock out of. Clock in first.'));
    await expect(withRetry(op, { label: 'test', retries: 3, baseDelayMs: 1 })).rejects.toThrow(
      'No open shift',
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting retries on persistent network failure', async () => {
    const op = jest.fn().mockRejectedValue(new Error('deadline-exceeded'));
    await expect(withRetry(op, { label: 'test', retries: 2, baseDelayMs: 1 })).rejects.toThrow(
      'deadline-exceeded',
    );
    expect(op).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('retries on "failed to fetch" (browser fetch failure pattern)', async () => {
    const op = jest
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(op, { label: 'test', retries: 2, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });
});
