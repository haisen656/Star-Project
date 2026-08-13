import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, sanitizeFilename, validateFileMetadata } from '../src/validation.js';

describe('file validation', () => {
  it('removes path characters from display names', () => expect(sanitizeFilename('../../notes.txt')).toBe('notes.txt'));
  it('rejects executables and oversized files', () => {
    expect(validateFileMetadata({ filename: 'run.exe', mimeType: 'application/octet-stream', size: 10 }).valid).toBe(false);
    expect(validateFileMetadata({ filename: 'huge.pdf', mimeType: 'application/pdf', size: MAX_FILE_BYTES + 1 }).valid).toBe(false);
  });
  it('accepts a safe document', () => expect(validateFileMetadata({ filename: '计划.pdf', mimeType: 'application/pdf', size: 1024 })).toEqual({ valid: true, filename: '计划.pdf' }));
});
