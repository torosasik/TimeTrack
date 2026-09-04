/**
 * workModelUtils tests — the resolver is the single source of truth for
 * Remote-ness across reports, the edit modal, and guardrails.
 */
import { resolveWorkModelName, isRemoteWorkModel } from './workModelUtils';
import type { WorkModel } from '../services/workModelsService';

const MODELS: WorkModel[] = [
  { id: 'onsite-id', name: 'On-site', noOvertime: false, overtimeLimit: 8, overtimeMultiplier: 1.5, doubleTimeLimit: 12, doubleTimeMultiplier: 2, weeklyOvertimeLimit: 40 },
  { id: 'remote-id', name: 'Remote', noOvertime: true, overtimeLimit: 8, overtimeMultiplier: 1.5, doubleTimeLimit: 12, doubleTimeMultiplier: 2, weeklyOvertimeLimit: 40 },
  { id: 'remote-east-id', name: 'Remote East', noOvertime: true, overtimeLimit: 8, overtimeMultiplier: 1.5, doubleTimeLimit: 12, doubleTimeMultiplier: 2, weeklyOvertimeLimit: 40 },
  { id: 'hybrid-id', name: 'Hybrid', noOvertime: false, overtimeLimit: 8, overtimeMultiplier: 1.5, doubleTimeLimit: 12, doubleTimeMultiplier: 2, weeklyOvertimeLimit: 40 },
];

describe('resolveWorkModelName', () => {
  it('prefers workModelId → name over the legacy string', () => {
    // Drifted doc: string says On-site, FK says Remote.
    expect(resolveWorkModelName({ workModel: 'On-site', workModelId: 'remote-id' }, MODELS)).toBe('Remote');
  });

  it('falls back to the legacy string when workModelId is missing', () => {
    expect(resolveWorkModelName({ workModel: 'Remote', workModelId: undefined }, MODELS)).toBe('Remote');
  });

  it('falls back to the legacy string when workModelId points at an unknown/voided model', () => {
    expect(resolveWorkModelName({ workModel: 'Remote', workModelId: 'voided-id' }, MODELS)).toBe('Remote');
  });

  it('returns empty string when neither source yields a value', () => {
    expect(resolveWorkModelName({ workModel: '' as never, workModelId: undefined }, MODELS)).toBe('');
  });
});

describe('isRemoteWorkModel', () => {
  it('is true for the canonical Remote model via FK', () => {
    expect(isRemoteWorkModel({ workModel: 'On-site', workModelId: 'remote-id' }, MODELS)).toBe(true);
  });

  it('is true for a custom Remote-flavored model via FK (fixes legacy-string clobber)', () => {
    expect(isRemoteWorkModel({ workModel: 'On-site', workModelId: 'remote-east-id' }, MODELS)).toBe(true);
  });

  it('is false for a custom non-Remote model (Hybrid)', () => {
    expect(isRemoteWorkModel({ workModel: 'On-site', workModelId: 'hybrid-id' }, MODELS)).toBe(false);
  });

  it('honors the legacy string when no FK resolves', () => {
    expect(isRemoteWorkModel({ workModel: 'Remote', workModelId: undefined }, MODELS)).toBe(true);
    expect(isRemoteWorkModel({ workModel: 'On-site', workModelId: undefined }, MODELS)).toBe(false);
  });

  it('is false when nothing resolves', () => {
    expect(isRemoteWorkModel({ workModel: 'On-site', workModelId: 'unknown' }, [])).toBe(false);
  });
});
