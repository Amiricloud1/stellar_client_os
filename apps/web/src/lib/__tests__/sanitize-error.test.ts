import { describe, it, expect } from 'vitest';
import {
  sanitizeErrorString,
  sanitizeObject,
  sanitizeError,
  sanitizeUrl,
  scrubSentryEvent,
  scrubSentryBreadcrumb,
  STELLAR_PUBLIC_KEY_PATTERN,
  STELLAR_SECRET_KEY_PATTERN,
} from '../sanitize-error';

describe('sanitize-error', () => {
  const validPublicKey = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN';
  const validSecretKey = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN';
  const truncatedKey = 'GABC...KLMN';
  const sampleSignedXdr =
    'AAAAAgAAAABi1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==';

  describe('sanitizeErrorString', () => {
    it('should mask full public keys', () => {
      const input = `Error with account ${validPublicKey}`;
      const result = sanitizeErrorString(input);
      expect(result).toBe('Error with account [PUBLIC_KEY_REDACTED]');
    });

    it('should mask secret keys completely', () => {
      const input = `Secret key: ${validSecretKey}`;
      const result = sanitizeErrorString(input);
      expect(result).toBe('Secret key: [SECRET_KEY_REDACTED]');
    });

    it('should mask truncated public keys', () => {
      const input = `Account ${truncatedKey} had an error`;
      const result = sanitizeErrorString(input);
      expect(result).toBe('Account [PUBLIC_KEY_REDACTED] had an error');
    });

    it('should handle multiple keys in one string', () => {
      const input = `Sender ${validPublicKey} and recipient ${validPublicKey}`;
      const result = sanitizeErrorString(input);
      expect(result).toBe('Sender [PUBLIC_KEY_REDACTED] and recipient [PUBLIC_KEY_REDACTED]');
    });

    it('should keep first 4 and last 5 chars when maskFullKey is false', () => {
      const input = `Error with account ${validPublicKey}`;
      const result = sanitizeErrorString(input, { maskFullKey: false });
      const expectedStart = validPublicKey.slice(0, 4);
      const expectedEnd = validPublicKey.slice(-5);
      expect(result).toBe(`Error with account ${expectedStart}...${expectedEnd}`);
    });

    it('should use custom replacement string', () => {
      const input = `Error with account ${validPublicKey}`;
      const result = sanitizeErrorString(input, { replacement: '[KEY_HIDDEN]' });
      expect(result).toBe('Error with account [KEY_HIDDEN]');
    });

    it('should handle non-string inputs gracefully', () => {
      expect(sanitizeErrorString(null as unknown as string)).toBe(null);
      expect(sanitizeErrorString(undefined as unknown as string)).toBe(undefined);
      expect(sanitizeErrorString(123 as unknown as string)).toBe(123);
    });

    it('should scrub US EIN, SSN/ITIN, and EU VAT tax IDs from error strings (#83)', () => {
      expect(sanitizeErrorString('Partner EIN 12-3456789 failed validation')).toBe(
        'Partner EIN [TAX_ID_REDACTED] failed validation'
      );
      expect(sanitizeErrorString('Taxpayer SSN 123-45-6789 rejected')).toBe(
        'Taxpayer SSN [TAX_ID_REDACTED] rejected'
      );
      expect(sanitizeErrorString('VAT DE123456789 lookup failed')).toBe(
        'VAT [TAX_ID_REDACTED] lookup failed'
      );
    });

    it('should scrub signed Stellar XDR transaction envelopes from strings (#83)', () => {
      const input = `Horizon rejected envelope ${sampleSignedXdr} with tx_bad_auth`;
      expect(sanitizeErrorString(input)).toBe(
        'Horizon rejected envelope [SIGNED_TX_REDACTED] with tx_bad_auth'
      );
    });

    it('should scrub IPFS and storage bucket evidence URLs from strings (#83)', () => {
      expect(
        sanitizeErrorString('Upload failed for ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/proof.jpg')
      ).toBe('Upload failed for [EVIDENCE_REDACTED]');
      expect(
        sanitizeErrorString('Could not read https://cdn.fundable.org/verification-evidence/camp-1/photo.png')
      ).toBe('Could not read [EVIDENCE_REDACTED]');
    });
  });

  describe('sanitizeUrl (#83)', () => {
    it('scrubs tax IDs, wallet secrets, signed transactions, evidence signatures, and tokens in query strings', () => {
      const rawUrl =
        `https://app.fundable.org/api/campaigns/verify?taxId=12-3456789&secretKey=${validSecretKey}` +
        `&signedXdr=${sampleSignedXdr}&X-Amz-Signature=deadbeef1234&token=jwt-secret-token&page=2`;
      const sanitized = sanitizeUrl(rawUrl);

      expect(sanitized).toContain('taxId=[TAX_ID_REDACTED]');
      expect(sanitized).toContain('secretKey=[SECRET_KEY_REDACTED]');
      expect(sanitized).toContain('signedXdr=[SIGNED_TX_REDACTED]');
      expect(sanitized).toContain('X-Amz-Signature=[EVIDENCE_REDACTED]');
      expect(sanitized).toContain('token=[REDACTED]');
      expect(sanitized).toContain('page=2');
      expect(sanitized).not.toContain('12-3456789');
      expect(sanitized).not.toContain(validSecretKey);
      expect(sanitized).not.toContain(sampleSignedXdr);
      expect(sanitized).not.toContain('deadbeef1234');
      expect(sanitized).not.toContain('jwt-secret-token');
    });
  });

  describe('sanitizeObject', () => {
    it('should sanitize string values in objects', () => {
      const obj = {
        message: `Error with account ${validPublicKey}`,
        data: {
          address: validPublicKey,
          nested: {
            key: `Secret: ${validSecretKey}`,
          },
        },
        array: [`Account ${validPublicKey}`, `Another ${validPublicKey}`],
      };

      const result = sanitizeObject(obj);
      expect(result.message).toBe('Error with account [PUBLIC_KEY_REDACTED]');
      expect(result.data.address).toBe('[PUBLIC_KEY_REDACTED]');
      expect(result.data.nested.key).toBe('Secret: [SECRET_KEY_REDACTED]');
      expect(result.array[0]).toBe('Account [PUBLIC_KEY_REDACTED]');
      expect(result.array[1]).toBe('Another [PUBLIC_KEY_REDACTED]');
    });

    it('should preserve non-string values', () => {
      const obj = {
        number: 123,
        boolean: true,
        null: null,
        undefined: undefined,
        timestamp: new Date(),
      };

      const result = sanitizeObject(obj);
      expect(result.number).toBe(123);
      expect(result.boolean).toBe(true);
      expect(result.null).toBe(null);
      expect(result.undefined).toBe(undefined);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should not sanitize object keys', () => {
      const obj = {
        [validPublicKey]: 'some value',
      };

      const result = sanitizeObject(obj);
      // Keys should remain unchanged
      expect(Object.keys(result)[0]).toBe(validPublicKey);
      // Values should be sanitized
      expect(result[validPublicKey]).toBe('some value');
    });

    it('should redact tax IDs, wallet secrets, signed transactions, evidence, and sensitive body fields by key (#83)', () => {
      const sensitivePayload = {
        taxId: '98-7654321',
        ein: '11-2233445',
        ssn: '999-00-1111',
        vatNumber: 'NL123456789B01',
        partnerRegistrationNumber: 'REG-99887766',
        secretKey: validSecretKey,
        mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        signedXdr: sampleSignedXdr,
        signatures: ['sig-1', 'sig-2'],
        verificationEvidence: {
          ipfsCid: 'QmTestCid123',
          gpsLocations: [{ latitude: -3.4653, longitude: -62.2159 }],
        },
        photoBuffer: new Uint8Array([1, 2, 3, 4]),
        password: 'super-secret-password',
        apiKey: 'sk_live_12345',
        bankAccount: '000123456789',
        creatorEmail: 'founder@ngo.org',
        campaignId: 'camp-amazon-1',
      };

      const scrubbed = sanitizeObject(sensitivePayload);
      expect(scrubbed.taxId).toBe('[TAX_ID_REDACTED]');
      expect(scrubbed.ein).toBe('[TAX_ID_REDACTED]');
      expect(scrubbed.ssn).toBe('[TAX_ID_REDACTED]');
      expect(scrubbed.vatNumber).toBe('[TAX_ID_REDACTED]');
      expect(scrubbed.partnerRegistrationNumber).toBe('[TAX_ID_REDACTED]');
      expect(scrubbed.secretKey).toBe('[SECRET_KEY_REDACTED]');
      expect(scrubbed.mnemonic).toBe('[SECRET_KEY_REDACTED]');
      expect(scrubbed.signedXdr).toBe('[SIGNED_TX_REDACTED]');
      expect(scrubbed.signatures).toBe('[SIGNED_TX_REDACTED]');
      expect(scrubbed.verificationEvidence).toBe('[EVIDENCE_REDACTED]');
      expect(scrubbed.photoBuffer).toBe('[EVIDENCE_REDACTED]');
      expect(scrubbed.password).toBe('[REDACTED]');
      expect(scrubbed.apiKey).toBe('[REDACTED]');
      expect(scrubbed.bankAccount).toBe('[REDACTED]');
      expect(scrubbed.creatorEmail).toBe('[REDACTED]');
      expect(scrubbed.campaignId).toBe('camp-amazon-1');
    });
  });

  describe('sanitizeError', () => {
    it('should sanitize error message and stack', () => {
      const error = new Error(`Error with account ${validPublicKey}`);
      error.stack = `Error with account ${validPublicKey}\n    at someFunction`;
      error.name = 'CustomError';

      const result = sanitizeError(error);
      expect(result.message).toBe('Error with account [PUBLIC_KEY_REDACTED]');
      expect(result.stack).toBe('Error with account [PUBLIC_KEY_REDACTED]\n    at someFunction');
      expect(result.name).toBe('CustomError');
    });

    it('should sanitize custom error properties', () => {
      type ErrorWithProps = Error & Record<string, unknown>;

      const error = new Error('Something went wrong') as ErrorWithProps;
      error.address = validPublicKey;
      error.details = { user: validPublicKey, context: 'test' };

      const result = sanitizeError(error) as ErrorWithProps;
      expect(result.address).toBe('[PUBLIC_KEY_REDACTED]');
      expect((result.details as Record<string, unknown>).user).toBe('[PUBLIC_KEY_REDACTED]');
      expect((result.details as Record<string, unknown>).context).toBe('test');
    });

    it('should handle error without stack', () => {
      const error = new Error(`Error with account ${validPublicKey}`);
      delete error.stack;

      const result = sanitizeError(error);
      expect(result.message).toBe('Error with account [PUBLIC_KEY_REDACTED]');
      expect(result.stack).toBeUndefined();
    });
  });

  describe('scrubSentryEvent & scrubSentryBreadcrumb (#83)', () => {
    it('scrubs exception, request URL/headers/body, breadcrumbs, user, and contexts before transmission', () => {
      const rawEvent = {
        message: `Submission failed for EIN 12-3456789 and wallet ${validSecretKey}`,
        exception: {
          values: [
            {
              type: 'TransactionSubmissionError',
              value: `Rejected XDR ${sampleSignedXdr} from ${validPublicKey}`,
              stacktrace: {
                frames: [
                  {
                    filename: `https://app.fundable.org/campaigns?secretKey=${validSecretKey}&taxId=12-3456789`,
                    vars: {
                      seedPhrase: 'witch collapse practice feed shame open despair creek road again ice least',
                      evidenceUrl: 'ipfs://QmEvidenceHash123',
                      txXdr: sampleSignedXdr,
                    },
                  },
                ],
              },
            },
          ],
        },
        request: {
          url: `https://app.fundable.org/api/campaigns/verify?taxId=12-3456789&X-Amz-Signature=sig999`,
          query_string: `taxId=12-3456789&secretKey=${validSecretKey}&campaign=camp-1`,
          headers: {
            Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
            Cookie: 'session_id=xyz987',
            'X-Admin-Key': 'admin-secret-999',
            'Content-Type': 'application/json',
          },
          cookies: { session_id: 'xyz987' },
          data: JSON.stringify({
            taxId: '12-3456789',
            walletSecret: validSecretKey,
            signedTransaction: sampleSignedXdr,
            evidence: { url: 'https://s3.amazonaws.com/bucket/evidence/doc.pdf', latitude: 4.5 },
            password: 'my-password',
            amount: '50000000',
          }),
        },
        breadcrumbs: [
          {
            category: 'fetch',
            message: `POST /api/tx with ${sampleSignedXdr}`,
            data: {
              url: `https://app.fundable.org/api/tx?apiKey=secret123&signedXdr=${sampleSignedXdr}`,
              tax_id: '12-3456789',
            },
          },
        ],
        user: {
          id: validPublicKey,
          email: 'donor@example.com',
          ip_address: '203.0.113.42',
        },
        contexts: {
          verification: {
            partnerRegistrationNumber: 'EIN-12-3456789',
            evidenceUrls: ['ipfs://QmSecretEvidence'],
          },
        },
      };

      const scrubbed = scrubSentryEvent(rawEvent);

      expect(scrubbed.message).toBe(
        'Submission failed for EIN [TAX_ID_REDACTED] and wallet [SECRET_KEY_REDACTED]'
      );

      const ex = scrubbed.exception.values[0];
      expect(ex.value).toBe('Rejected XDR [SIGNED_TX_REDACTED] from [PUBLIC_KEY_REDACTED]');
      expect(ex.stacktrace.frames[0].filename).toContain('secretKey=[SECRET_KEY_REDACTED]');
      expect(ex.stacktrace.frames[0].filename).toContain('taxId=[TAX_ID_REDACTED]');
      expect(ex.stacktrace.frames[0].vars).toEqual({
        seedPhrase: '[SECRET_KEY_REDACTED]',
        evidenceUrl: '[EVIDENCE_REDACTED]',
        txXdr: '[SIGNED_TX_REDACTED]',
      });

      expect(scrubbed.request.url).toContain('taxId=[TAX_ID_REDACTED]');
      expect(scrubbed.request.url).toContain('X-Amz-Signature=[EVIDENCE_REDACTED]');
      expect(scrubbed.request.query_string).toContain('taxId=[TAX_ID_REDACTED]');
      expect(scrubbed.request.query_string).toContain('secretKey=[SECRET_KEY_REDACTED]');
      expect(scrubbed.request.query_string).toContain('campaign=camp-1');
      expect(scrubbed.request.headers.Authorization).toBe('[REDACTED]');
      expect(scrubbed.request.headers.Cookie).toBe('[REDACTED]');
      expect(scrubbed.request.headers['X-Admin-Key']).toBe('[REDACTED]');
      expect(scrubbed.request.headers['Content-Type']).toBe('application/json');
      expect(scrubbed.request.cookies).toBe('[REDACTED]');

      const parsedBody = JSON.parse(scrubbed.request.data);
      expect(parsedBody).toEqual({
        taxId: '[TAX_ID_REDACTED]',
        walletSecret: '[SECRET_KEY_REDACTED]',
        signedTransaction: '[SIGNED_TX_REDACTED]',
        evidence: '[EVIDENCE_REDACTED]',
        password: '[REDACTED]',
        amount: '50000000',
      });

      expect(scrubbed.breadcrumbs[0].message).toBe('POST /api/tx with [SIGNED_TX_REDACTED]');
      expect(scrubbed.breadcrumbs[0].data.url).toContain('apiKey=[REDACTED]');
      expect(scrubbed.breadcrumbs[0].data.url).toContain('signedXdr=[SIGNED_TX_REDACTED]');
      expect(scrubbed.breadcrumbs[0].data.tax_id).toBe('[TAX_ID_REDACTED]');

      expect(scrubbed.user).toEqual({
        id: '[PUBLIC_KEY_REDACTED]',
        email: '[REDACTED]',
        ip_address: '[REDACTED]',
      });

      expect(scrubbed.contexts.verification).toEqual({
        partnerRegistrationNumber: '[TAX_ID_REDACTED]',
        evidenceUrls: '[EVIDENCE_REDACTED]',
      });

      // Verify scrubSentryBreadcrumb standalone
      const bc = scrubSentryBreadcrumb({
        message: `Signed ${sampleSignedXdr}`,
        data: { url: 'https://api.fundable.org/submit?token=abc', secretKey: validSecretKey },
      });
      expect(bc.message).toBe('Signed [SIGNED_TX_REDACTED]');
      expect(bc.data.url).toBe('https://api.fundable.org/submit?token=[REDACTED]');
      expect(bc.data.secretKey).toBe('[SECRET_KEY_REDACTED]');
    });
  });

  describe('Regex patterns', () => {
    it('should match valid Stellar public keys', () => {
      const key = validPublicKey;
      expect(STELLAR_PUBLIC_KEY_PATTERN.test(key)).toBe(true);
      // Reset regex state
      STELLAR_PUBLIC_KEY_PATTERN.lastIndex = 0;

      // Should not match invalid keys
      expect(STELLAR_PUBLIC_KEY_PATTERN.test('G123')).toBe(false);
      STELLAR_PUBLIC_KEY_PATTERN.lastIndex = 0;
      expect(STELLAR_PUBLIC_KEY_PATTERN.test('invalid')).toBe(false);
    });

    it('should match Stellar secret keys', () => {
      const key = validSecretKey;
      expect(STELLAR_SECRET_KEY_PATTERN.test(key)).toBe(true);
      STELLAR_SECRET_KEY_PATTERN.lastIndex = 0;

      expect(STELLAR_SECRET_KEY_PATTERN.test('S123')).toBe(false);
    });
  });
});