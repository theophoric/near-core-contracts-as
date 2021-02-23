import {
  u128,
  context,
  env,
  storage
} from 'near-sdk-as'
import { get_number_of_accounts } from '../staking-pool/main';

// NEAR types //
type AccountId = string;
type Balance = u128;
type EpochHeight = u64;
type WrappedTimestamp = u64;

class Option<T> {
  constructor(readonly value: T) {}
  is_some(): bool {
    return (!this.is_none());
  }
  is_none(): bool {
    if (isNullable<T>() || isReference<T>()) {
      return changetype<usize>(this.value) == 0;
    } else {
      return false
    }
  }
  expect(message: string = "Missing expected value"): T {
    assert(this.is_some(), message);
    return this.value;
  }
  unwrap(): T {
    return this.expect();
  }
}


// STORAGE //
type StorageKey = string;
const KEY_VOTING_CONTRACT: StorageKey = "voting_contract";


// Main Contract Class //

// @nearBindgen
// abstract class BaseContract<T> {
//   // singleton
//   private static instance: VotingContract;

//   // disable construction outside of "VotingContract.load()"
//   private constructor() {}

//   // storage key used for persisting contract data
//   private static readonly key: StorageKey = KEY_VOTING_CONTRACT;

//   static init(): T {
//     assert(!storage.hasKey(key), )
//     new T()
//   }

//   // singleton initializer
//   static load(): T {
//     if (!this.instance) {
//       this.instance = storage.get<T>(this.key) || new VotingContract();
//     }
//     return this.instance;
//   }
  
//   // instance method for persisting the contract to account storage
//   persist() {
//     storage.set<VotingContract>(VotingContract.key, this);
//   }
// }

@nearBindgen
export class VotingContract {

  // singleton
  private static instance: VotingContract;

  // disable construction outside of "VotingContract.load()"
  private constructor(
    public votes: Map<AccountId, Balance>,
    public total_voted_stake: Balance,
    public result: Option<WrappedTimestamp>,
    public last_epoch_height: EpochHeight
  ) {}

  // storage key used for persisting contract data
  private static readonly key: StorageKey = KEY_VOTING_CONTRACT;

  // I'm not sure about this yet .. but something like init is necessary for new construction
  static init(): VotingContract {
    assert(!this.is_init(), "Voting contract has already been initialized");
    let contract = new VotingContract(
      new Map<AccountId, Balance>(),
      u128.Zero,
      new Option<WrappedTimestamp>(0),
      0
    )
    contract.persist();
    return contract;
  }

  // singleton initializer
  static load(): VotingContract {
    assert(this.is_init(), "Voting contract must be initialized with new()");
    if (!this.instance) {
      this.instance = storage.getSome<VotingContract>(this.key)
    }
    return this.instance;
  }
  // instance method for persisting the contract to account storage
  persist(): void {
    storage.set<VotingContract>(VotingContract.key, this);
  }

  private static is_init(): bool {
    return storage.hasKey(VotingContract.key);
  }
  // rest of the class is basically the same as rust version



  ping(): void {
    assert(
      this.result.is_none(),
      "Voting has already ended"
    );
    let cur_epoch_height = env.epoch_height();
    if (cur_epoch_height != this.last_epoch_height ) {
      this.total_voted_stake = u128.Zero;
      let account_ids = this.votes.keys();
      for (let i = 0; i < account_ids.length; i ++ ) {
        let account_id = account_ids[i];
        let account_current_stake = env.validator_stake(account_id);
        if (account_current_stake > u128.Zero) {
          this.votes.set(account_id, account_current_stake);
        }
        this.check_result();
        this.last_epoch_height = cur_epoch_height;
      }
    }
  }

  check_result(): void {
    assert(
      this.result.is_none(),
      "check result is called after result is already set"
    );

    let total_stake = env.validator_total_stake();
    if (
      // u128 math is verbose -T
      u128.gt(
        this.total_voted_stake,
        u128.mul(
          total_stake,
          u128.div(
            u128.from(2),
            u128.from(3)))
      )
    ) {
      this.result = new Option(env.block_timestamp());
    }
  }

  vote(is_vote: bool):void {
    this.ping();
    if (this.result.is_some()) {
      return;
    }
    // NOTE :: I'm assuming that this is equivalent to env::predecessor_account_id();
    let account_id = context.predecessor;
    
    let account_stake: u128;

    if (is_vote) {
      let stake = env.validator_stake(account_id);
      assert(stake > u128.Zero, account_id + "is not a validator");
      account_stake = stake;
    } else {
      account_stake = u128.Zero;
    }

    let voted_stake = this.votes.get(account_id);
    this.votes.delete(account_id);
    assert(
      voted_stake <= this.total_voted_stake,
      "invariant: voted stake " + voted_stake.toString() + " is more than total voted stake " + this.total_voted_stake.toString()
    );
    this.total_voted_stake = u128.add(
      this.total_voted_stake, u128.sub(
        account_stake, voted_stake));
    if (account_stake > u128.Zero) {
      this.votes.set(account_id, account_stake);
      this.check_result();
    }
  }

  get_result(): Option<WrappedTimestamp> {
    return this.result;
  }

  get_total_voted_stake():  StaticArray<u128> { // no tuple type available
    return [this.total_voted_stake, env.validator_total_stake()];
  }

  get_votes(): Map<AccountId, u128> {
    // Note :: I think this is okay to just return without processing .. need to confirm -T
    return this.votes;
  }

  
}

// class Pair<T> {
//   constructor(readonly x: T, readonly y: T) {}
//   toArray(): StaticArray<T> {
//     let a = new StaticArray<T>(2)
//     a[0] = this.x;
//     a[1] = this.y;
//     return a;
//   }
// }

///////////////
// INTERFACE //
///////////////

// Not needed, only included for api parity with rust version
// @ts-ignore
@exportAs("default")
export function fallback(): void {
  env.panic();
}

// Initialize contract
// NOTE :: this initialized function is not actually necessary; it is included in order to maintain the same interface and behavior as the rust version (panics if any method is called before init) and to demonstrate how to use the @exportAs decorator 
// @ts-ignore
@exportAs("new")
export function main(): void {
  assert(!storage.hasKey(KEY_VOTING_CONTRACT), "The contract is already initialized");
  let contract = VotingContract.load();
  contract.persist();
}

/// Ping to update the votes according to current stake of validators.
export function ping(): void {
  let contract = VotingContract.load();
  contract.ping();
  contract.persist();
}

/// Check whether the voting has ended.
export function check_result():void {
  let contract = VotingContract.load();
  contract.check_result();
  contract.persist();
}

/// Method for validators to vote or withdraw the vote.
/// Votes for if `is_vote` is true, or withdraws the vote if `is_vote` is false.
export function vote(is_vote: bool):void {
  let contract = VotingContract.load();
  contract.vote(is_vote);
  contract.persist();
}

/// Get the timestamp of when the voting finishes. `None` means the voting hasn't ended yet
export function get_result(): Option<WrappedTimestamp> {
  let contract = VotingContract.load();
  return contract.get_result();
}

/// Returns current a pair of `total_voted_stake` and the total stake.
/// Note: as a view method, it doesn't recompute the active stake. May need to call `ping` to
/// update the active stake.
export function get_total_voted_stake(): StaticArray<u128> {
  let contract = VotingContract.load();
  return contract.get_total_voted_stake();
}
///////////
// TESTS //
///////////