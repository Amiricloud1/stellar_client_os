/* eslint-disable */
import { Buffer } from "buffer";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";

export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  window.Buffer = window.Buffer || Buffer;
}

export interface PlanterInfo {
  address: string;
  referrer?: string;
  jobs_completed: u64;
  first_job_reward_claimed: boolean;
}

export interface ReferralInfo {
  referral_count: u64;
  successful_referrals: u64;
}

export interface Client {
  initialize(
    args: { admin: string; reward_token: string; reward_amount: i128 },
    options?: MethodOptions
  ): Promise<AssembledTransaction<null>>;
  register_planter(
    args: { planter: string; referrer?: string },
    options?: MethodOptions
  ): Promise<AssembledTransaction<null>>;
  complete_job(
    args: { planter: string },
    options?: MethodOptions
  ): Promise<AssembledTransaction<null>>;
  claim_referral_reward(
    args: { referrer: string; referred_planter: string },
    options?: MethodOptions
  ): Promise<AssembledTransaction<null>>;
  get_planter(
    args: { planter: string },
    options?: MethodOptions
  ): Promise<AssembledTransaction<PlanterInfo>>;
  get_referral_info(
    args: { referrer: string },
    options?: MethodOptions
  ): Promise<AssembledTransaction<ReferralInfo>>;
  get_reward_amount(
    options?: MethodOptions
  ): Promise<AssembledTransaction<i128>>;
  set_reward_amount(
    args: { new_amount: i128 },
    options?: MethodOptions
  ): Promise<AssembledTransaction<null>>;
}

export class Client {
  readonly options: ContractClientOptions;

  constructor(options: ContractClientOptions) {
    this.options = options;
  }
}
