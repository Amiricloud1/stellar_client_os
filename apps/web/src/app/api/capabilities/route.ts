/**
 * GET /api/capabilities
 *
 * Exposes SDK capabilities and version information for client discovery.
 * Allows clients to detect supported operations before transaction preparation.
 * Implements deprecation headers per RFC 8594.
 */

import { NextRequest, NextResponse } from 'next/server';
import { VERSION } from '@fundable/sdk';
import { CapabilityChecker } from '@fundable/sdk/dist/utils/capability-checker';

export const runtime = 'nodejs';

/**
 * GET /api/capabilities
 *
 * Query Parameters:
 *   - network: (optional) filter by network (testnet, mainnet, futurenet)
 *   - sdkVersion: (optional) query specific SDK version capabilities
 *
 * Response: {
 *   apiVersion: "1.0.0",
 *   sdkVersion: "0.2.0",
 *   capabilities: {
 *     network: "testnet",
 *     supportedOperations: ["payment-stream:create", ...],
 *     contractMethods: { "payment-stream": ["create", ...] },
 *     deprecated: [...]
 *   },
 *   deprecationPolicy: {
 *     sunset90Days: "2025-02-28",
 *     deprecationHeaders: true
 *   }
 * }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const network = searchParams.get('network') || 'testnet';
    const sdkVersion = searchParams.get('sdkVersion') || VERSION;

    // Create capability checker for the requested version/network
    const checker = new CapabilityChecker(sdkVersion, network);
    const capabilities = checker.getCapabilities();
    const deprecated = checker.listDeprecatedOperations();

    // Convert Set to Array for JSON serialization
    const supportedOperations = Array.from(capabilities.supportedOperations);
    const contractMethods: Record<string, string[]> = {};
    for (const [contract, methods] of capabilities.contractMethods) {
      contractMethods[contract] = Array.from(methods);
    }

    const response = NextResponse.json(
      {
        apiVersion: '1.0.0',
        sdkVersion,
        network,
        capabilities: {
          supportedOperations,
          contractMethods,
          deprecated: deprecated.length > 0 ? deprecated : undefined,
        },
        meta: {
          fetchedAt: new Date().toISOString(),
          docUrl: 'https://docs.fundable.xyz/api/capabilities',
        },
      },
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
          'X-API-Version': '1.0.0',
        },
      }
    );

    // Add deprecation headers if any operations are deprecated
    if (deprecated.length > 0) {
      const oldestSunset = deprecated
        .filter((d) => d.sunset)
        .map((d) => d.sunset!)
        .sort()[0];

      if (oldestSunset) {
        response.headers.set('Deprecation', 'true');
        response.headers.set('Sunset', oldestSunset.toUTCString());
      }

      // RFC 8594: Explain deprecation
      response.headers.set(
        'Warning',
        '299 - "Some operations are deprecated and will be removed. See /api/capabilities for details"'
      );
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      {
        error: {
          code: 'capabilities_error',
          message,
        },
        meta: {
          apiVersion: '1.0.0',
          fetchedAt: new Date().toISOString(),
        },
      },
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Version': '1.0.0',
        },
      }
    );
  }
}

/**
 * OPTIONS /api/capabilities
 * CORS preflight support
 */
export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '3600',
    },
  });
}
