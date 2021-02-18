import {
  u128,
  context,
  env,
  storage,
} from 'near-sdk-as'

// NEAR types //
type AccountId = string;
type Balance = u128;
type EpochHeight = number;
type WrappedTimestamp = u64;


// Generic types //
type Option<T> = T | None;
type None = null;

// STORAGE //
type StorageKey = string;
const KEY_VOTING_CONTRACT: StorageKey = "v";


// Main Contract Class //

@nearBindgen
// @ts-ignore
export class VotingContract {

  votes: Map<AccountId, Balance>
  total_voted_stake: Balance
  result: Option<WrappedTimestamp>
  last_epoch_height: EpochHeight

  ping(): void {
    assert(
      _is_none(this.result),
      "Voting has already ended"
    );
    let cur_epoch_height = env.epoch_height();
    if (cur_epoch_height != this.last_epoch_height) {
      this.total_voted_stake = u128.Zero;
      for (let account_id in this.votes) {
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
      _is_none(this.result),
      "check result is called after result is already set"
    );

    let total_stake = env.validator_total_stake();
    if (
      // NOTE -- don't really know how to handle operations with checked u128 type - T
      this.total_voted_stake >
      u128.from(changetype<number>(total_stake) * 2 / 3)
    ) {
      this.result = env.block_timestamp();
    }
  }

  vote(is_vote: bool) {
    this.ping();
    if (_is_some(this.result)) {
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
      "invariant: voted stake " + voted_stake + " is more than total voted stake " + this.total_voted_stake
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

  get_total_voted_stake():  [u128, u128] {
    return [this.total_voted_stake, env.validator_total_stake()];
  }

  get_votes(): Map<AccountId, u128> {
    // Note :: I think this is okay to just return without processing .. need to confirm -T
    return this.votes;
  }

  // AS-sdk extras //

  private _key: StorageKey;
  
  // load contract from storage
  constructor(_key: StorageKey) {
    this._key = _key;
    
    let state = storage.get<VotingContract>(this._key);
    if (state) {
      this.votes = state.votes;
      this.total_voted_stake = state.total_voted_stake;
      this.result = state.result
      this.last_epoch_height = state.last_epoch_height;
    }
  }

  // Persist the contract to account storage
  persist() {
    storage.set<VotingContract>(this._key, this);
  }

}

///////////////
// INTERFACE //
///////////////

// Not needed, only included for api parity with rust version
// @ts-ignore
@exportAs("default")
export function fallback() {
  env.panic();
}

// Initialize contract
// NOTE :: this initialized function is not actually necessary; it is included in order to maintain the same interface and behavior as the rust version (panics if any method is called before init) and to demonstrate how to use the @exportAs decorator 
// @ts-ignore
@exportAs("new")
export function main() {
  assert(!storage.hasKey(KEY_VOTING_CONTRACT), "The contract is already initialized");
  let contract = new VotingContract(KEY_VOTING_CONTRACT);
  contract.persist();
}

/// Ping to update the votes according to current stake of validators.
export function ping() {
  let contract = new VotingContract(KEY_VOTING_CONTRACT);
  contract.ping();
  contract.persist();
}

/// Check whether the voting has ended.
export function check_result() {
  let contract = new VotingContract(KEY_VOTING_CONTRACT);
  contract.check_result();
  contract.persist();
}

/// Method for validators to vote or withdraw the vote.
/// Votes for if `is_vote` is true, or withdraws the vote if `is_vote` is false.
export function vote(is_vote: bool) {
  let contract = new VotingContract(KEY_VOTING_CONTRACT);
  contract.vote(is_vote);
  contract.persist();
}

/// Get the timestamp of when the voting finishes. `None` means the voting hasn't ended yet
export function get_result(): Option<WrappedTimestamp> {
  let contract = new VotingContract(KEY_VOTING_CONTRACT);
  return contract.get_result();
}

/// Returns current a pair of `total_voted_stake` and the total stake.
/// Note: as a view method, it doesn't recompute the active stake. May need to call `ping` to
/// update the active stake.
export function get_total_voted_stake(): [u128, u128] {
  let contract = new VotingContract(KEY_VOTING_CONTRACT);
  return contract.get_total_voted_stake();
}

/////////////
// HELPERS //
/////////////

function _is_none(thing: any): bool {
  return thing == null;
}

function _is_some(thing: any): bool {
  return thing != null;
}

///////////
// TESTS //
///////////