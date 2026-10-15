import { describe, expect, it } from 'vitest';
import { normalizeTime } from './AttendanceList';

describe('normalizeTime', () => {
  it.each([
    ['8', '08:00'],
    ['17', '17:00'],
    ['830', '08:30'],
    ['0830', '08:30'],
    ['8:30', '08:30'],
    ['8.30', '08:30'],
    ['8,3', '08:30'],
    ['17h15', '17:15'],
    ['', ''],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeTime(raw)).toBe(expected);
  });

  it.each(['25', '8:75', 'abc', '12345'])('keeps invalid input %s for correction', (raw) => {
    expect(normalizeTime(raw)).toBe(raw);
  });
});
