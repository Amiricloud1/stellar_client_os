import catalogData from './error-catalog.json';

export interface ContractErrorInfo {
  code: number;
  name: string;
  message: string;
  retryable: boolean;
  contract?: string;
}

export const ERROR_CATALOG: Record<string, Record<number, ContractErrorInfo>> = {};

// Populate catalog map
for (const [contractName, errors] of Object.entries(catalogData.contracts)) {
  ERROR_CATALOG[contractName] = {};
  for (const err of errors) {
    ERROR_CATALOG[contractName][err.code] = {
      ...err,
      contract: contractName,
    };
  }
}

/**
 * Looks up error details by code and optional contract name
 */
export function lookupContractError(code: number, contract?: string): ContractErrorInfo {
  if (contract && ERROR_CATALOG[contract] && ERROR_CATALOG[contract][code]) {
    return ERROR_CATALOG[contract][code];
  }

  // Fallback search across contracts
  for (const errors of Object.values(ERROR_CATALOG)) {
    if (errors[code]) {
      return errors[code];
    }
  }

  return {
    code,
    name: 'UnknownContractError',
    message: `Unknown contract error with code ${code}`,
    retryable: false,
    contract: contract ?? 'unknown',
  };
}
