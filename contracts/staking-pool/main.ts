import {
  u128,
  context,
  env,
  storage,
  base58,
  logging,
  ContractPromise,
  ContractPromiseBatch,
  ContractPromiseResult,
  util,
  u256
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
const KEY_STAKING_CONTRACT: StorageKey = "staking_contract";


/// The amount of gas given to complete `vote` call.
const VOTE_GAS: u64 = 100_000_000_000_000;

/// The amount of gas given to complete internal `on_stake_action` call.
const ON_STAKE_ACTION_GAS: u64 = 20_000_000_000_000;

/// The amount of yocto NEAR the contract dedicates to guarantee that the "share" price never
/// decreases. It's used during rounding errors for share : amount conversions.
const STAKE_SHARE_PRICE_GUARANTEE_FUND: Balance = u128.from(1_000_000_000_000);

/// There is no deposit balance attached.
const NO_DEPOSIT: Balance = u128.Zero;

/// A type to distinguish between a balance and "stake" shares for better readability.
export type NumStakeShares = Balance;

@nearBindgen
export class Account {
  unstaked: Balance;
  stake_shares: NumStakeShares;
  unstaked_available_epoch_height: EpochHeight;
}

@nearBindgen
export class HumanReadableAccount {
  account_id: AccountId;
  unstaked_balance: Balance;
  staked_balance: Balance;
  can_withdraw: bool;
}

/// The number of epochs required for the locked balance to become unlocked.
/// NOTE: The actual number of epochs when the funds are unlocked is 3. But there is a corner case
/// when the unstaking promise can arrive at the next epoch, while the inner state is already
/// updated in the previous epoch. It will not unlock the funds for 4 epochs.
const NUM_EPOCHS_TO_UNLOCK: EpochHeight = 4;

// @nearBindgen
// abstract class BaseContract {
//   abstract persist(): void
//   constructor(readonly key: StorageKey) {}
// }

// function expect<T>(some: T | null, message?: string): T {
//   if (some) {
//     return some;
//   } else {
//     env.panic();
//   }
// }

@nearBindgen
export class StakingContract {

  static readonly key: StorageKey = KEY_STAKING_CONTRACT;


  // singleton
  private static instance: StakingContract;

  // disable construction outside of "StakingContract.load()"
  private constructor(
    owner_id: AccountId,
    stake_public_key: PublicKey,
    last_epoch_height: EpochHeight,
    last_total_balance: Balance,
    total_staked_balance: Balance,
    total_stake_shares: NumStakeShares,
    reward_fee_fraction: RewardFeeFraction,
    accounts: Map < AccountId, Account > ,
    paused: false,
  ) {
    this.owner_id = owner_id;
    this.stake_public_key = stake_public_key;
    this.last_epoch_height = last_epoch_height;
    this.last_total_balance = last_total_balance;
    this.total_staked_balance = total_staked_balance;
    this.total_stake_shares = total_stake_shares;
    this.reward_fee_fraction = reward_fee_fraction;
    this.accounts = accounts;
    this.paused = paused;

    this.internal_restake();
  }

  // storage key used for persisting contract data

  // Initialize a new Staking Contract
  static init(owner_id: AccountId, stake_public_key: PublicKey, reward_fee_fraction: RewardFeeFraction): StakingContract {
    assert(!this.is_init(), "StakingContract has ahready been initialized");
    reward_fee_fraction.assert_valid();
    assert(env.isValidAccountID(owner_id), "The owner id is invalid");
    let account_balance = context.accountBalance
    let total_staked_balance = u128.sub(account_balance, STAKE_SHARE_PRICE_GUARANTEE_FUND);
    assert(context.accountLockedBalance > u128.Zero);

    let contract = new StakingContract(
      owner_id,
      stake_public_key,
      env.epoch_height(),
      account_balance,
      total_staked_balance,
      total_staked_balance,
      reward_fee_fraction,
      new Map < AccountId, Account > (),
      false
    );

    // contract.owner_id = owner_id;
    // contract.stake_public_key = stake_public_key;
    // contract.last_epoch_height = env.epoch_height();
    // contract.last_total_balance = account_balance;
    // contract.total_staked_balance = total_staked_balance;
    // contract.total_stake_shares = total_staked_balance;
    // contract.reward_fee_fraction = reward_fee_fraction;
    // contract.accounts = new Map<AccountId, Account>();
    // contract.paused = false;

    contract.persist();

    return contract;
  }

  // singleton initializer
  static load(): StakingContract {
    assert(this.is_init(), "This contract has not been initialized");

    if (!this.instance) {
      this.instance = storage.getSome < StakingContract > (this.key);
    }
    return this.instance;
  }

  // instance method for persisting the contract to account storage
  persist(): void {
    storage.set < StakingContract > (StakingContract.key, this);
  }

  private static is_init(): bool {
    return storage.hasKey(StakingContract.key);
  }





  /// The account ID of the owner who's running the staking validator node.
  /// NOTE: This is different from the current account ID which is used as a validator account.
  /// The owner of the staking pool can change staking public key and adjust reward fees.
  owner_id: AccountId;
  /// The public key which is used for staking action. It's the public key of the validator node
  /// that validates on behalf of the pool.
  stake_public_key: PublicKey;
  /// The last epoch height when `ping` was called.
  last_epoch_height: EpochHeight;
  /// The last total balance of the account (consists of staked and unstaked balances).
  last_total_balance: Balance;
  /// The total amount of shares. It should be equal to the total amount of shares across all
  /// accounts.
  total_stake_shares: NumStakeShares;
  /// The total staked balance.
  total_staked_balance: Balance;
  /// The fraction of the reward that goes to the owner of the staking pool for running the
  /// validator node.
  reward_fee_fraction: RewardFeeFraction;
  /// Persistent map from an account ID to the corresponding account.
  accounts: Map < AccountId, Account > ;
  /// Whether the staking is paused.
  /// When paused, the account unstakes everything (stakes 0) and doesn't restake.
  /// It doesn't affect the staking shares or reward distribution.
  /// Pausing is useful for node maintenance. Only the owner can pause and resume staking.
  /// The contract is not paused by default.
  paused: bool;




  // PUBLIC METHODS


  ping() {
    if (this.internal_ping()) {
      this.internal_restake();
    }
  }

  deposit() {
    let need_to_restake = this.internal_ping();
    this.internal_deposit();
    if (need_to_restake) {
      this.internal_restake();
    }
  }


  // INTERNAL METHODS

  protected internal_restake() {
    if (this.paused) {
      return;
    }

    ContractPromiseBatch.create(context.contractName)
      .stake(this.total_staked_balance, this.stake_public_key)
      .function_call(
        (this as SelfContract).on_stake_action.name,
        null,
        NO_DEPOSIT,
        ON_STAKE_ACTION_GAS
      );
  }

  protected internal_deposit(): u128 {
    let account_id = context.predecessor;
    let account = this.internal_get_account(account_id);
    let amount = context.attachedDeposit;
    account.unstaked = u128.add(amount, account.unstaked);
    this.internal_save_account(account_id, account);
    this.last_total_balance = u128.add(this.last_total_balance, amount);
    logging.log(account_id + " deposited " + amount + ". New unstaked balance is " + account.unstaked);
    return amount;
  }

  protected internal_withdraw(amount: Balance) {
    assert(amount > u128.Zero, "Withdrawal amount should be positive");
    let account_id = context.predecessor;
    let account = this.internal_get_account(account_id);
    assert(account.unstaked >= amount, "Not enough unstaked balance to withdraw");
    assert(account.unstaked_available_epoch_height <= context.epochHeight, "The unstaked balance is not yet available due to unstaking delay");
    account.unstaked = u128.sub(account.unstaked, amount);
    this.internal_save_account(account_id, account);
    logging.log(account_id + " wutgdrawubg " + amount + ". New unstaked balance is " + account.unstaked);
    ContractPromiseBatch.create(account_id).transfer(amount);
    this.last_total_balance = u128.sub(this.last_total_balance, amount);
  }

  protected internal_stake(amount: Balance) {
    assert(amount > u128.Zero, "Staking amount should be positive");
    let account_id = context.predecessor;
    let account = this.internal_get_account(account_id);

    // Calculate the number of "stake" shares that the account will receive for staking the
    // given amount.
    let num_shares = this.num_shares_from_staked_amount_rounded_down(amount);
    assert(
      num_shares > u128.Zero,
      "The calculated number of \"stake\" shares received for staking should be positive"
    );


    // The amount of tokens the account will be charged from the unstaked balance.
    // Rounded down to avoid overcharging the account to guarantee that the account can always
    // unstake at least the same amount as staked.
    let charge_amount = this.staked_amount_from_num_shares_rounded_down(num_shares);
    assert(
      charge_amount > u128.Zero,
      "Invariant violation. Calculated staked amount must be positive, because \"stake\" share price should be at least 1"
    );

    assert(
      account.unstaked >= charge_amount,
      "Not enough unstaked balance to stake"
    );
    account.unstaked = u128.sub(charge_amount, account.unstaked);
    account.stake_shares = u128.add(num_shares, account.stake_shares);
    this.internal_save_account(account_id, account);

    // The staked amount that will be added to the total to guarantee the "stake" share price
    // never decreases. The difference between `stake_amount` and `charge_amount` is paid
    // from the allocated STAKE_SHARE_PRICE_GUARANTEE_FUND.
    let stake_amount = this.staked_amount_from_num_shares_rounded_up(num_shares);

    this.total_staked_balance = u128.add(stake_amount,this.total_staked_balance);
    this.total_stake_shares = u128.add(num_shares,this.total_stake_shares);

    logging.log(
      account_id + " staking " + charge_amount + ". Received " + num_shares + " new staking shares. Total " + account.unstaked + " unstaked balance and " + account.stake_shares + " staking shares"
    );
    logging.log(
      "Contract total staked balance is " + this.total_staked_balance + ". Total number of shares" + this.total_stake_shares
    );

  }


  protected inner_unstake(amount: u128) {
    assert(amount > u128.Zero, "Unstaking amount should be positive");

    let account_id = context.predecessor;
    let account = this.internal_get_account(account_id);

    assert(
      this.total_staked_balance > u128.Zero,
      "The contract doesn't have staked balance"
    );
    // Calculate the number of shares required to unstake the given amount.
    // NOTE: The number of shares the account will pay is rounded up.
    let num_shares = this.num_shares_from_staked_amount_rounded_up(amount);
    assert(
      num_shares > u128.Zero,
      "Invariant violation. The calculated number of \"stake\" shares for unstaking should be positive"
    );
    assert(
      account.stake_shares >= num_shares,
      "Not enough staked balance to unstake"
    );

    // Calculating the amount of tokens the account will receive by unstaking the corresponding
    // number of "stake" shares, rounding up.
    let receive_amount = this.staked_amount_from_num_shares_rounded_up(num_shares);
    assert(
      receive_amount > u128.Zero,
      "Invariant violation. Calculated staked amount must be positive, because \"stake\" share price should be at least 1"
    );

    account.stake_shares = u128.sub(num_shares, account.stake_shares);
    account.unstaked = u128.add(receive_amount, account.unstaked);
    account.unstaked_available_epoch_height = context.epochHeight + NUM_EPOCHS_TO_UNLOCK;
    this.internal_save_account(account_id, account);

    // The amount tokens that will be unstaked from the total to guarantee the "stake" share
    // price never decreases. The difference between `receive_amount` and `unstake_amount` is
    // paid from the allocated STAKE_SHARE_PRICE_GUARANTEE_FUND.
    let unstake_amount = this.staked_amount_from_num_shares_rounded_down(num_shares);

    this.total_staked_balance = u128.add(this.total_staked_balance, unstake_amount);
    this.total_stake_shares = u128.add(this.total_stake_shares, num_shares);

    logging.log("@" + account_id + " unstaking " + receive_amount + ". Spent " + num_shares + " staking shares. Total " + account.unstaked + " unstaked balance and " + account.stake_shares + " staking shares");
    logging.log("Contract total staked balance is " + this.total_staked_balance + ". Total number of shares " + this.total_stake_shares);
  }
  protected assert_owner() {
    assert(context.predecessor == this.owner_id, "Can only be called by owner");
  }

  /// Distributes rewards after the new epoch. It's automatically called before every action.
  /// Returns true if the current epoch height is different from the last epoch height.
  protected internal_ping(): bool {
    let epoch_height = context.epochHeight;
    if (this.last_epoch_height == epoch_height) {
      return false;
    }
    this.last_epoch_height = epoch_height;

    // New total amount (both locked and unlocked balances).
    // NOTE: We need to subtract `attached_deposit` in case `ping` called from `deposit` call
    // since the attached deposit gets included in the `account_balance`, and we have not
    // accounted it yet.
    let total_balance = u128.add(context.accountLockedBalance, u128.sub(context.accountBalance, context.attachedDeposit));

    assert(
      total_balance >= this.last_total_balance,
      "The new total balance should not be less than the old total balance"
    );
    let total_reward = u128.sub(total_balance, this.last_total_balance);

    if (total_reward > u128.Zero) {
      // The validation fee that the contract owner takes.
      let owners_fee = this.reward_fee_fraction.multiply(total_reward);

      //istributing the remaining reward to the delegators first.
      let remaining_reward = u128.sub(total_reward, owners_fee);
      this.total_staked_balance = u128.add(remaining_reward, this.total_staked_balance);

      // Now buying "stake" shares for the contract owner at the new share price.
      let num_shares = this.num_shares_from_staked_amount_rounded_down(owners_fee);
      if (num_shares > u128.Zero) {
        // Updating owner's inner account
        let owner_id = this.owner_id;
        let account = this.internal_get_account(owner_id);
        account.stake_shares = u128.add(num_shares, account.stake_shares);
        this.internal_save_account(owner_id, account);
        // Increasing the total amount of "stake" shares.
        this.total_stake_shares = u128.add(num_shares, this.total_stake_shares);
      }
      // Increasing the total staked balance by the owners fee, no matter whether the owner
      // received any shares or not.
      this.total_staked_balance = u128.add(this.total_staked_balance, owners_fee);

      logging.log("Epoch " + epoch_height + ": Contract received total rewards of " + total_reward + " tokens. New total staked balance is " + this.total_staked_balance + ". Total number of shares " + this.total_stake_shares)

      if (num_shares > u128.Zero) {
        logging.log("Total rewards fee is " + num_shares + "stake shares");
      }
    }

    this.last_total_balance = total_balance;
    return true
  }


  /// Returns the number of "stake" shares rounded down corresponding to the given staked balance
  /// amount.
  ///
  /// price = total_staked / total_shares
  /// Price is fixed
  /// (total_staked + amount) / (total_shares + num_shares) = total_staked / total_shares
  /// (total_staked + amount) * total_shares = total_staked * (total_shares + num_shares)
  /// amount * total_shares = total_staked * num_shares
  /// num_shares = amount * total_shares / total_staked
  protected num_shares_from_staked_amount_rounded_down(amount: Balance): NumStakeShares {
    assert(
      this.total_staked_balance > u128.Zero,
      "The total staked balance can't be 0"
    );
    // u256 math not supported
    // (U256::from(this.total_stake_shares) * U256::from(amount)
    // / U256::from(this.total_staked_balance))
    return u128.mul(amount, u128.div(this.total_stake_shares, this.total_staked_balance));
  }

  /// Returns the number of "stake" shares rounded up corresponding to the given staked balance
  /// amount.
  ///
  /// Rounding up division of `a / b` is done using `(a + b - 1) / b`.
  protected num_shares_from_staked_amount_rounded_up(amount: Balance): NumStakeShares {
    assert(
      this.total_staked_balance > u128.Zero,
      "The total staked balance can't be 0"
    );
    // ((U256::from(this.total_stake_shares) * U256::from(amount)
    //     + U256::from(this.total_staked_balance - 1))
    //     / U256::from(this.total_staked_balance))
    // .as_u128()

    return u128.add(
      u128.mul(this.total_stake_shares, amount),
      u128.div(
        u128.sub(this.total_staked_balance, u128.One),
        this.total_staked_balance
      )
    );
  }

  /// Returns the staked amount rounded down corresponding to the given number of "stake" shares.
  protected staked_amount_from_num_shares_rounded_down(num_shares: NumStakeShares): Balance {
    assert(
      this.total_stake_shares > u128.Zero,
      "The total number of stake shares can't be 0"
    );
    // (U256::from(this.total_staked_balance) * U256::from(num_shares)
    //     / U256::from(this.total_stake_shares))
    // .as_u128()
    return u128.mul(
      num_shares,
      u128.div(this.total_staked_balance, this.total_stake_shares)
    )
  }

  /// Returns the staked amount rounded up corresponding to the given number of "stake" shares.
  ///
  /// Rounding up division of `a / b` is done using `(a + b - 1) / b`.
  protected staked_amount_from_num_shares_rounded_up(num_shares: NumStakeShares): Balance {
    assert(
      this.total_stake_shares > u128.Zero,
      "The total number of stake shares can't be 0"
    );
    // ((U256::from(this.total_staked_balance) * U256::from(num_shares)
    //     + U256::from(this.total_stake_shares - 1))
    //     / U256::from(this.total_stake_shares))
    // .as_u128()
    return u128.add(
      u128.mul(this.total_staked_balance, num_shares),
      u128.div(
        u128.sub(this.total_stake_shares, u128.One),
        this.total_stake_shares
      )
    );
  }

  /// Inner method to get the given account or a new default value account.
  protected internal_get_account(account_id: & AccountId): Account {
    return this.accounts.get(account_id) || new Account();
  }

  /// Inner method to save the given account for a given account ID.
  /// If the account balances are 0, the account is deleted instead to release storage.
  protected internal_save_account(account_id: AccountId, account: Account) {
    if (account.unstaked > u128.Zero || account.stake_shares > u128.Zero) {
      this.accounts.set(account_id, account);
    } else {
      this.accounts.delete(account_id);
    }
  }

}

// @ts-ignore
@exportAs("new")
export function main(
  owner_id: AccountId,
  stake_public_key: PublicKey,
  reward_fee_fraction: RewardFeeFraction,
) {
  assert(!storage.hasKey(KEY_STAKING_CONTRACT), "Already initialized")
  reward_fee_fraction.assert_valid();
  assert(
    env.isValidAccountID(owner_id),
    "The owner account ID is invalid"
  );

}

@nearBindgen
export class RewardFeeFraction {
  numerator: u32;
  denominator: u32;
  assert_valid() {
    assert(this.denominator != 0, "Denominator must be a positive number");
    assert(this.numerator <= this.denominator, "The reward must be less than or equal to 1");
  }
  multiply(value: Balance): Balance {
    // NOTE :: multiplication and division are not yet implemented for u256 :: so currently, lacking precision
    // u256.fromU32(this.numerator) * u256.fromU128(value) / u256.fromU32(this.denominator)
    return u128.mul(value, u128.div(u128.fromU32(this.numerator), u128.fromU32(this.denominator)));
  }
}

/************************
 * INTERFACES
 * ********************** */

export interface VoteContract {
  /// Method for validators to vote or withdraw the vote.
  /// Votes for if `is_vote` is true, or withdraws the vote if `is_vote` is false.
  vote(is_vote: bool): void;
}
export interface SelfContract {
  /// A callback to check the result of the staking action.
  /// In case the stake amount is less than the minimum staking threshold, the staking action
  /// fails, and the stake amount is not changed. This might lead to inconsistent state and the
  /// follow withdraw calls might fail. To mitigate this, the contract will issue a new unstaking
  /// action in case of the failure of the first staking action.
  on_stake_action(): void;
}