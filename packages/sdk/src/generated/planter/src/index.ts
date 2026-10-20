import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
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
    { admin, reward_token, reward_amount }: { admin: string; reward_token: string; reward_amount: i128 },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<null>>;

  register_planter(
    { planter, referrer }: { planter: string; referrer?: string },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<null>>;

  complete_job(
    { planter }: { planter: string },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<null>>;

  claim_referral_reward(
    { referrer, referred_planter }: { referrer: string; referred_planter: string },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<null>>;

  get_planter(
    { planter }: { planter: string },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<PlanterInfo>>;

  get_referral_info(
    { referrer }: { referrer: string },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<ReferralInfo>>;

  get_reward_amount(options?: MethodOptions): Promise<AssembledTransaction<bigint>>;

  set_reward_amount(
    { new_amount }: { new_amount: i128 },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<null>>;
}

export class Client extends ContractClient {
  constructor(options: ContractClientOptions) {
    super(
      new ContractSpec(["AAAAAAAAAAAAAAAKaW5pdGlhbGl6ZQAAAAADAAAAAAAAAAVhZG1pbgAAAAARAAAAAAAAAAxyZXdhcmRfdG9rZW4AAAAAEQAAAAAAAAANcmV3YXJkX2Ftb3VudAAAAAAKAAAAAA=="]),
      options,
    );
  }
}
