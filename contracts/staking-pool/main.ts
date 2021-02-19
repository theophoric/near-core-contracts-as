import {
    u128,
    context,
    env,
    storage,
    base58,
    logging,
    ContractPromiseBatch,
    ContractPromiseResult
  } from 'near-sdk-as';
  
  // NEAR types //
  type AccountId = string;
  type Balance = u128;
  type EpochHeight = number;
  type WrappedTimestamp = u64;
  type PublicKey = Uint8Array;
  
  
  // Generic types //
  type Option < T > = T | None;
  type None = null;
  
  // STORAGE //
  type StorageKey = string;
  const KEY_MULTI_SIG_CONTRACT: StorageKey = "ms";
  

/// The amount of gas given to complete `vote` call.
const VOTE_GAS: u64 = 100_000_000_000_000;

/// The amount of gas given to complete internal `on_stake_action` call.
const ON_STAKE_ACTION_GAS: u64 = 20_000_000_000_000;

/// The amount of yocto NEAR the contract dedicates to guarantee that the "share" price never
/// decreases. It's used during rounding errors for share -> amount conversions.
const STAKE_SHARE_PRICE_GUARANTEE_FUND: Balance = u128.from(1_000_000_000_000);

/// There is no deposit balance attached.
const NO_DEPOSIT: Balance = u128.Zero;
  

