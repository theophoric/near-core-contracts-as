
import {
  u128,
  context,
  env
} from 'near-sdk-as';

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

// class None extends Option<null> {
//   constructor() {
//     super(null);
//   }
// }

@nearBindgen
export class VotingContract {
  public votes: Map<AccountId, Balance>
  public total_voted_stake: Balance
  public result: Option<WrappedTimestamp>
  public last_epoch_height: EpochHeight
  // exported as "new"
  constructor() {
    this.votes = new Map<AccountId, Balance>();
    this.total_voted_stake = u128.Zero;
    this.result = new Option(0); // 0 is interpreted as "none"
    this.last_epoch_height = 0;
  }

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