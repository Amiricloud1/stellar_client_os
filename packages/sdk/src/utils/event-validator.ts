/**
 * Contract Event Schema Versioning and Validation.
 *
 * Defines versioned schemas for Soroban contract events, enforces
 * schema evolution rules (backward compatibility), and validates
 * ingested events from RPC streams or transaction results.
 */

export type SchemaFieldType = 'string' | 'number' | 'bigint' | 'boolean' | 'address' | 'bytes' | 'any';

export interface FieldDefinition {
  name: string;
  type: SchemaFieldType;
  required: boolean;
  description?: string;
}

export interface EventSchemaDefinition {
  contract: string;
  eventName: string;
  version: number;
  deprecated?: boolean;
  topics: FieldDefinition[];
  payload: FieldDefinition[];
}

export interface RawContractEvent {
  contractId?: string;
  topic: unknown[];
  value: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  schema?: EventSchemaDefinition;
  parsedTopics?: Record<string, unknown>;
  parsedPayload?: Record<string, unknown>;
}

export interface ValidatedContractEvent<TPayload = Record<string, unknown>> {
  contractId?: string;
  contractType: string;
  eventName: string;
  schemaVersion: number;
  topics: Record<string, unknown>;
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Schema Registry
// ---------------------------------------------------------------------------

export const EVENT_SCHEMAS: Record<string, EventSchemaDefinition> = {
  // Payment Stream Events
  'payment-stream:FeeCollected:v1': {
    contract: 'payment-stream',
    eventName: 'FeeCollected',
    version: 1,
    topics: [
      { name: 'eventName', type: 'string', required: true },
    ],
    payload: [
      { name: 'streamId', type: 'bigint', required: true },
      { name: 'recipient', type: 'address', required: true },
      { name: 'amount', type: 'bigint', required: true },
      { name: 'timestamp', type: 'number', required: false },
    ],
  },
  'payment-stream:StreamDeposit:v1': {
    contract: 'payment-stream',
    eventName: 'StreamDeposit',
    version: 1,
    topics: [
      { name: 'eventName', type: 'string', required: true },
    ],
    payload: [
      { name: 'streamId', type: 'bigint', required: true },
      { name: 'sender', type: 'address', required: true },
      { name: 'amount', type: 'bigint', required: true },
    ],
  },
  'payment-stream:StreamPaused:v1': {
    contract: 'payment-stream',
    eventName: 'StreamPaused',
    version: 1,
    topics: [{ name: 'eventName', type: 'string', required: true }],
    payload: [
      { name: 'streamId', type: 'bigint', required: true },
      { name: 'pausedBy', type: 'address', required: true },
    ],
  },
  'payment-stream:StreamResumed:v1': {
    contract: 'payment-stream',
    eventName: 'StreamResumed',
    version: 1,
    topics: [{ name: 'eventName', type: 'string', required: true }],
    payload: [
      { name: 'streamId', type: 'bigint', required: true },
      { name: 'resumedBy', type: 'address', required: true },
    ],
  },

  // Timelock Contract Events
  'timelock:ActionProposed:v1': {
    contract: 'timelock',
    eventName: 'ActionProposed',
    version: 1,
    topics: [{ name: 'eventName', type: 'string', required: true }],
    payload: [
      { name: 'admin', type: 'address', required: true },
      { name: 'actionHash', type: 'bytes', required: true },
      { name: 'target', type: 'address', required: false },
      { name: 'description', type: 'string', required: true },
    ],
  },
  'timelock:ActionExecuted:v1': {
    contract: 'timelock',
    eventName: 'ActionExecuted',
    version: 1,
    topics: [{ name: 'eventName', type: 'string', required: true }],
    payload: [
      { name: 'admin', type: 'address', required: true },
      { name: 'actionHash', type: 'bytes', required: true },
      { name: 'target', type: 'address', required: false },
    ],
  },
  'timelock:ActionCancelled:v1': {
    contract: 'timelock',
    eventName: 'ActionCancelled',
    version: 1,
    topics: [{ name: 'eventName', type: 'string', required: true }],
    payload: [
      { name: 'admin', type: 'address', required: true },
      { name: 'actionHash', type: 'bytes', required: true },
    ],
  },

  // Distributor Contract Events
  'distributor:DistributeBatch:v1': {
    contract: 'distributor',
    eventName: 'DistributeBatch',
    version: 1,
    topics: [{ name: 'eventName', type: 'string', required: true }],
    payload: [
      { name: 'token', type: 'address', required: true },
      { name: 'sender', type: 'address', required: true },
      { name: 'recipientCount', type: 'number', required: true },
      { name: 'totalAmount', type: 'bigint', required: true },
    ],
  },
};

/**
 * Registers a new event schema or schema version in the registry.
 */
export function registerEventSchema(schema: EventSchemaDefinition): void {
  const key = `${schema.contract}:${schema.eventName}:v${schema.version}`;
  EVENT_SCHEMAS[key] = schema;
}

/**
 * Retrieves a schema by contract, event name, and optional version (defaults to latest registered).
 */
export function getEventSchema(
  contract: string,
  eventName: string,
  version?: number
): EventSchemaDefinition | undefined {
  if (version !== undefined) {
    return EVENT_SCHEMAS[`${contract}:${eventName}:v${version}`];
  }

  // Find highest version
  const matching = Object.values(EVENT_SCHEMAS).filter(
    s => s.contract === contract && s.eventName === eventName
  );

  if (matching.length === 0) return undefined;
  matching.sort((a, b) => b.version - a.version);
  return matching[0];
}

/**
 * Validates a contract event against a specific schema.
 */
export function validateContractEvent(
  raw: RawContractEvent,
  schema: EventSchemaDefinition
): ValidationResult {
  const errors: string[] = [];

  if (!raw || !Array.isArray(raw.topic)) {
    return {
      valid: false,
      errors: ['Event must have a topic array'],
      schema,
    };
  }

  // Validate topics
  const parsedTopics: Record<string, unknown> = {};
  for (let i = 0; i < schema.topics.length; i++) {
    const field = schema.topics[i];
    const value = raw.topic[i];

    if (value === undefined || value === null) {
      if (field.required) {
        errors.push(`Missing required topic "${field.name}" at index ${i}`);
      }
    } else {
      if (!matchesType(value, field.type)) {
        errors.push(
          `Topic "${field.name}" expected type ${field.type}, got ${typeof value}`
        );
      }
      parsedTopics[field.name] = value;
    }
  }

  // Validate payload
  const parsedPayload: Record<string, unknown> = {};
  if (typeof raw.value !== 'object' || raw.value === null) {
    if (schema.payload.some(f => f.required)) {
      errors.push('Event payload must be an object/record or tuple');
    }
  } else {
    const isArrayPayload = Array.isArray(raw.value);

    for (let i = 0; i < schema.payload.length; i++) {
      const field = schema.payload[i];
      let value: unknown;

      if (isArrayPayload) {
        value = (raw.value as unknown[])[i];
      } else {
        value = (raw.value as Record<string, unknown>)[field.name];
      }

      if (value === undefined || value === null) {
        if (field.required) {
          errors.push(`Missing required payload field "${field.name}"`);
        }
      } else {
        if (!matchesType(value, field.type)) {
          errors.push(
            `Payload field "${field.name}" expected type ${field.type}, got ${typeof value}`
          );
        }
        parsedPayload[field.name] = value;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    schema,
    parsedTopics,
    parsedPayload,
  };
}

/**
 * Asserts that a new schema version is strictly backward compatible with an older version.
 *
 * Rules:
 * 1. Event name and contract must match.
 * 2. New version must be greater than previous version.
 * 3. All previously required fields must remain present and required (or relaxed to optional).
 * 4. Any newly introduced fields MUST be optional.
 */
export function assertBackwardCompatibility(
  oldSchema: EventSchemaDefinition,
  newSchema: EventSchemaDefinition
): void {
  if (oldSchema.contract !== newSchema.contract) {
    throw new Error(`Contract mismatch: ${oldSchema.contract} vs ${newSchema.contract}`);
  }
  if (oldSchema.eventName !== newSchema.eventName) {
    throw new Error(`Event name mismatch: ${oldSchema.eventName} vs ${newSchema.eventName}`);
  }
  if (newSchema.version <= oldSchema.version) {
    throw new Error(`New version (${newSchema.version}) must be higher than old version (${oldSchema.version})`);
  }

  // Check payload fields
  const oldFieldMap = new Map(oldSchema.payload.map(f => [f.name, f]));
  const newFieldMap = new Map(newSchema.payload.map(f => [f.name, f]));

  // Ensure old required fields are still supported
  for (const [name, oldField] of oldFieldMap) {
    const newField = newFieldMap.get(name);
    if (!newField && oldField.required) {
      throw new Error(`Breaking change: required field "${name}" was removed in v${newSchema.version}`);
    }
  }

  // Ensure any new fields are optional
  for (const [name, newField] of newFieldMap) {
    if (!oldFieldMap.has(name) && newField.required) {
      throw new Error(`Breaking change: newly added field "${name}" must be optional in v${newSchema.version}`);
    }
  }
}

function matchesType(value: unknown, expectedType: SchemaFieldType): boolean {
  if (expectedType === 'any') return true;

  if (expectedType === 'address' || expectedType === 'string') {
    return typeof value === 'string';
  }

  if (expectedType === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }

  if (expectedType === 'bigint') {
    return (
      typeof value === 'bigint' ||
      (typeof value === 'string' && /^-?\d+$/.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value))
    );
  }

  if (expectedType === 'boolean') {
    return typeof value === 'boolean';
  }

  if (expectedType === 'bytes') {
    return (
      typeof value === 'string' ||
      value instanceof Uint8Array ||
      Buffer.isBuffer(value)
    );
  }

  return false;
}
