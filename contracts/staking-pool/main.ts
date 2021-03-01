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
  u256,
  math,
  persist
} from 'near-sdk-as';

// NEAR types //
type AccountId = string;
type Balance = u128;
type EpochHeight = u64;
type PublicKey = Uint8Array;
type Base58PublicKey = PublicKey; // need some better way of doing this


enum PromiseResult {
  NotReady = 0,
  Successful = 1,
  Failed = 2 
}

/// Register used internally for atomic operations. This register is safe to use by the user,
/// since it only needs to be untouched while methods of `Environment` execute, which is guaranteed
/// guest code is not parallel.
const ATOMIC_OP_REGISTER: u64 = 0;
/// Register used to record evicted values from the storage.
const EVICTED_REGISTER: u64 = u64.MAX_VALUE - 1;


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
}
// STORAGE //

type StorageKey = string;
/// Key used to store the state of the contract.
const STATE_KEY: StorageKey = "STATE";

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
  constructor(
    public unstaked: Balance,
    public stake_shares: NumStakeShares,
    public unstaked_available_epoch_height: EpochHeight,
  ){}
}

@nearBindgen
export class HumanReadableAccount {
  constructor(
    public account_id: AccountId,
    public unstaked_balance: Balance,
    public staked_balance: Balance,
    public can_withdraw: bool,
  ) {}
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

    /// The account ID of the owner who's running the staking validator node.
    /// NOTE: This is different from the current account ID which is used as a validator account.
    /// The owner of the staking pool can change staking public key and adjust reward fees.
    public owner_id: AccountId;
    /// The public key which is used for staking action. It's the public key of the validator node
    /// that validates on behalf of the pool.
    public stake_public_key: Base58PublicKey;
    /// The last epoch height when `ping` was called.
    public last_epoch_height: EpochHeight;
    /// The last total balance of the account (consists of staked and unstaked balances).
    public last_total_balance: Balance;
    /// The total amount of shares. It should be equal to the total amount of shares across all
    /// accounts.
    public total_stake_shares: NumStakeShares;
    /// The total staked balance.
    public total_staked_balance: Balance;
    /// The fraction of the reward that goes to the owner of the staking pool for running the
    /// validator node.
    public reward_fee_fraction: RewardFeeFraction;
    /// Persistent map from an account ID to the corresponding account.
    public accounts: Map < AccountId, Account >;
    /// Whether the staking is paused.
    /// When paused, the account unstakes everything (stakes 0) and doesn't restake.
    /// It doesn't affect the staking shares or reward distribution.
    /// Pausing is useful for node maintenance. Only the owner can pause and resume staking.
    /// The contract is not paused by default.
    public paused: bool;

    private init: bool;

  // storage key used for persisting contract data

  // Initialize a new Staking Contract
  constructor (owner_id: AccountId, stake_public_key: Base58PublicKey, reward_fee_fraction: RewardFeeFraction) {
    reward_fee_fraction.assert_valid();
    assert(env.isValidAccountID(owner_id), "The owner id is invalid");
    let account_balance = context.accountBalance;
    let total_staked_balance = u128.sub(account_balance, STAKE_SHARE_PRICE_GUARANTEE_FUND);
    assert(context.accountLockedBalance > u128.Zero);
    this.owner_id =  owner_id;
    this.stake_public_key =  stake_public_key;
    this.last_epoch_height =  env.epoch_height();
    this.last_total_balance =  account_balance;
    this.total_stake_shares =  total_staked_balance;
    this.total_staked_balance =  total_staked_balance;
    this.reward_fee_fraction =  reward_fee_fraction;
    this.accounts =  new Map < AccountId, Account > ();
    this.paused = false;

    this.init = true;

    this.internal_restake();
  }

  private assertInit(): void {
    assert((this.init), "Contract has not been initialized; initialize with #new(owner_id: AccountId, stake_public_key: Base58PublicKey, reward_fee_fraction: RewardFeeFraction)")
  }

  // PUBLIC METHODS

  @mutateState()
  ping(): void {
    if (this.internal_ping()) {
      this.internal_restake();
    }
  }

  // @payable
  @mutateState()
  deposit(): void {
    let need_to_restake = this.internal_ping();
    this.internal_deposit();
    if (need_to_restake) {
      this.internal_restake();
    }
  }



  /// Deposits the attached amount into the inner account of the predecessor and stakes it.
  // #[payable]
  @mutateState()
  deposit_and_stake(): void {
    this.internal_ping();

    let amount = this.internal_deposit();
    this.internal_stake(amount);

    this.internal_restake();
  }

  /// Withdraws the entire unstaked balance from the predecessor account.
  /// It's only allowed if the `unstake` action was not performed in the four most recent epochs.
  @mutateState()
  withdraw_all(): void {
    let need_to_restake = this.internal_ping();
    let account_id = context.predecessor;
    let account = this.internal_get_account(account_id);
    this.internal_withdraw(account.unstaked);

    if (need_to_restake) {
      this.internal_restake();
    }
  }

  /// Withdraws the non staked balance for given account.
  /// It's only allowed if the `unstake` action was not performed in the four most recent epochs.
  @mutateState()
  withdraw(amount: Balance): void {
    let need_to_restake = this.internal_ping();

    this.internal_withdraw(amount);

    if (need_to_restake) {
      this.internal_restake();
    }
  }

  /// Stakes all available unstaked balance from the inner account of the predecessor.
  @mutateState()
  stake_all(): void {
    // Stake action always restakes
    this.internal_ping();

    let account_id = context.predecessor;
    let account = this.internal_get_account(account_id);
    this.internal_stake(account.unstaked);

    this.internal_restake();
  }

  /// Stakes the given amount from the inner account of the predecessor.
  /// The inner account should have enough unstaked balance.
  @mutateState()
  stake(amount: Balance): void {
    // Stake action always restakes
    this.internal_ping();

    this.internal_stake(amount);

    this.internal_restake();
  }

  /// Unstakes all staked balance from the inner account of the predecessor.
  /// The new total unstaked balance will be available for withdrawal in four epochs.
  @mutateState()
  unstake_all(): void {
    // Unstake action always restakes
    this.internal_ping();

    let account_id = context.predecessor;
    let account = this.internal_get_account(account_id);
    let amount = this.staked_amount_from_num_shares_rounded_down(account.stake_shares);
    this.inner_unstake(amount);

    this.internal_restake();
  }

  /// Unstakes the given amount from the inner account of the predecessor.
  /// The inner account should have enough staked balance.
  /// The new total unstaked balance will be available for withdrawal in four epochs.
  @mutateState()
  unstake(amount: Balance): void {
    // Unstake action always restakes
    this.internal_ping();

    this.inner_unstake(amount);

    this.internal_restake();
  }

  /****************/
  /* View methods */
  /****************/

  /// Returns the unstaked balance of the given account.
  get_account_unstaked_balance(account_id: AccountId): Balance {
    return this.get_account(account_id).unstaked_balance
  }

  /// Returns the staked balance of the given account.
  /// NOTE: This is computed from the amount of "stake" shares the given account has and the
  /// current amount of total staked balance and total stake shares on the account.
  get_account_staked_balance(account_id: AccountId): Balance {
    return this.get_account(account_id).staked_balance
  }

  /// Returns the total balance of the given account (including staked and unstaked balances).
  get_account_total_balance(account_id: AccountId): Balance {
    let account = this.get_account(account_id);
    return u128.add(account.unstaked_balance, account.staked_balance);
  }

  /// Returns `true` if the given account can withdraw tokens in the current epoch.
  is_account_unstaked_balance_available(account_id: AccountId): bool {
    return this.get_account(account_id).can_withdraw
  }

  /// Returns the total staking balance.
  get_total_staked_balance(): Balance {
    return this.total_staked_balance
  }

  /// Returns account ID of the staking pool owner.
  get_owner_id(): AccountId {
    return this.owner_id
  }

  /// Returns the current reward fee as a fraction.
  get_reward_fee_fraction(): RewardFeeFraction {
    return this.reward_fee_fraction
  }

  /// Returns the staking public key
  get_staking_key(): Base58PublicKey {
    return this.stake_public_key;
  }

  /// Returns true if the staking is paused
  is_staking_paused(): bool {
    return this.paused;
  }

  /// Returns human readable representation of the account for the given account ID.
  get_account(account_id: AccountId): HumanReadableAccount {
    let account = this.internal_get_account(account_id);
    return new HumanReadableAccount(
      account_id,
      account.unstaked,
      this.staked_amount_from_num_shares_rounded_down(account.stake_shares),
      (account.unstaked_available_epoch_height <= context.epochHeight)
    );
  }

  /// Returns the number of accounts that have positive balance on this staking pool.
  get_number_of_accounts(): u64 {
    return this.accounts.size
  }

  /// Returns the list of accounts
  get_accounts(from_index: u64, limit: u64): Array < HumanReadableAccount > {
    let keys = this.accounts.keys();
    let accounts: Array < HumanReadableAccount > = [];
    for (let i = from_index; i < min(from_index + limit, keys.length); i++) {
      accounts.push(this.get_account(keys[i]))
    }
    return accounts;
  }

  /*************/
  /* Callbacks */
  /*************/

  on_stake_action(): void {
    assert(
      context.contractName ==
      context.predecessor,
      "Can be called only as a callback"
    );

    assert(
      env.promise_results_count() == 1,
      "Contract expected a result on the callback"
    );

    let stake_action_succeeded = (env.promise_result(ATOMIC_OP_REGISTER, 0) == PromiseResult.Successful);
    if (!stake_action_succeeded &&context.accountLockedBalance > u128.Zero) {
      ContractPromiseBatch.create(context.contractName).stake(u128.Zero, this.stake_public_key);
    }
  }

  /*******************/
  /* Owner's methods */
  /*******************/

  /// Owner's method.
  /// Updates current public key to the new given public key.
  @mutateState()
  update_staking_key(stake_public_key: Base58PublicKey): void {
    this.assert_owner();
    // When updating the staking keythe contract has to restake.
    let _need_to_restake = this.internal_ping();
    this.stake_public_key = stake_public_key;
    this.internal_restake();
  }

  /// Owner's method.
  /// Updates current reward fee fraction to the new given fraction.
  @mutateState()
  update_reward_fee_fraction(reward_fee_fraction: RewardFeeFraction): void {
    this.assert_owner();
    reward_fee_fraction.assert_valid();

    let need_to_restake = this.internal_ping();
    this.reward_fee_fraction = reward_fee_fraction;
    if (need_to_restake) {
      this.internal_restake();
    }
  }

  /// Owner's method.
  /// Calls `vote(is_vote)` on the given voting contract account ID on behalf of the pool.
  @mutateState()
  vote(voting_account_id: AccountId, is_vote: bool): ContractPromiseBatch {
    this.assert_owner();
    assert(
      env.isValidAccountID(voting_account_id),
      "Invalid voting account ID"
    );
    
    let ext = new ExtVoting(voting_account_id);
    return ext.vote(is_vote);
  }

  /// Owner's method.
  /// Pauses pool staking.
  @mutateState()
  pause_staking(): void {
    this.assert_owner();
    assert(!this.paused, "The staking is already paused");

    this.internal_ping();
    this.paused = true;
    ContractPromiseBatch.create(context.contractName).stake(u128.Zero, this.stake_public_key);
  }

  /// Owner's method.
  /// Resumes pool staking.
  @mutateState()
  resume_staking(): void {
    this.assert_owner();
    assert(this.paused, "The staking is not paused");

    this.internal_ping();
    this.paused = false;
    this.internal_restake();
  }


  // INTERNAL METHODS
  // No @mutateState provided -- should be on external methods

  protected internal_restake(): void {
    if (this.paused) {
      return;
    }

    ContractPromiseBatch.create(context.contractName)
      .stake(this.total_staked_balance, this.stake_public_key)
      .function_call(
        this.on_stake_action.name,
        {},
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

  protected internal_withdraw(amount: Balance): void {
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

  protected internal_stake(amount: Balance): void {
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

    this.total_staked_balance = u128.add(stake_amount, this.total_staked_balance);
    this.total_stake_shares = u128.add(num_shares, this.total_stake_shares);

    logging.log(
      account_id + " staking " + charge_amount + ". Received " + num_shares + " new staking shares. Total " + account.unstaked + " unstaked balance and " + account.stake_shares + " staking shares"
    );
    logging.log(
      "Contract total staked balance is " + this.total_staked_balance + ". Total number of shares" + this.total_stake_shares
    );

  }

  protected inner_unstake(amount: u128): void {
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

  protected assert_owner(): void {
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
  protected internal_get_account(account_id: AccountId): Account {
    return this.accounts.get(account_id) || {};
  }

  /// Inner method to save the given account for a given account ID.
  /// If the account balances are 0, the account is deleted instead to release storage.
  protected internal_save_account(account_id: AccountId, account: Account): void {
    if (account.unstaked > u128.Zero || account.stake_shares > u128.Zero) {
      this.accounts.set(account_id, account);
    } else {
      this.accounts.delete(account_id);
    }
  }

}


@nearBindgen
class RewardFeeFraction {
  numerator: u32;
  denominator: u32;
  assert_valid(): void {
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
 * Contract Interface
 * ********************** */



/************************
 * External Contracts
 * ********************** */

class ExtContract {
  constructor(readonly ext_account_id: AccountId){}
  
  protected call(method_name: string, args: Uint8Array, amount: u128, gas: number  ): ContractPromiseBatch {
    return ContractPromiseBatch.create(this.ext_account_id).function_call(method_name, args, amount, gas)
  }

}

class ExtVoting extends ExtContract {
  vote(is_vote:bool): ContractPromiseBatch {
    return this.call(this.vote.name, encode({is_vote}), NO_DEPOSIT, VOTE_GAS);
  }
}

class SelfContract extends ExtContract {
  /// A callback to check the result of the staking action.
  /// In case the stake amount is less than the minimum staking threshold, the staking action
  /// fails, and the stake amount is not changed. This might lead to inconsistent state and the
  /// follow withdraw calls might fail. To mitigate this, the contract will issue a new unstaking
  /// action in case of the failure of the first staking action.
  on_stake_action(): ContractPromiseBatch {
    return this.call(this.on_stake_action.name, new Uint8Array(0), NO_DEPOSIT, ON_STAKE_ACTION_GAS);
  }
}