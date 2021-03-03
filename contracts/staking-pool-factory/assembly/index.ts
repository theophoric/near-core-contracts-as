import { env, ContractPromiseBatch, u128, context, logging } from "near-sdk-core";

type AccountId = string
type Balance = u128;
type Gas = u64;
type PublicKey = Uint8Array;
type Base58PublicKey = PublicKey; // need some better way of doing this

const SUBACCOUNT_SEPARATOR:string = ".";
// const STAKING_POOL_BIN_PATH:string = "../../../build/release/staking-pool.wasm";

class GasPrices {
    private static BASE: Gas = 25_000_000_000_000;
    static STAKING_POOL_NEW: Gas = (GasPrices.BASE * 2);
    static CALLBACK: Gas = (GasPrices.BASE * 2);
    static WHITELIST_STAKING_POOL: Gas = GasPrices.BASE;
}

const MIN_ATTACHED_BALANCE: Balance = u128.from(30_000_000_000_000_000_000_000_000);

const NO_DEPOSIT: Balance = u128.Zero;

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

class ContractBase {
    constructor(private init: bool = true) {}
    protected isInit(): bool {
        return this.init;
    }
    protected assertInit():void {
        assert(this.isInit(), "This contract has not been initialized")
    }

    protected assert_self(): void {
        assert(context.predecessor == context.contractName, "This method can only be invoked by self");
    }
    protected is_promise_success(): bool {
        assert( env.promise_results_count() == 1, "Contract expected a result on the callback");
        switch(<u32>env.promise_result(0, ATOMIC_OP_REGISTER)) {
            case PromiseResult.Successful: {
                return true
            }
            default: {
                return false
            }
        }
    }
}

@nearBindgen
export class StakingPoolFactory extends ContractBase {
    /// Account ID of the staking pool whitelist contract.
    staking_pool_whitelist_account_id: AccountId;

    /// The account ID of the staking pools created.
    staking_pool_account_ids: Set<AccountId>;

    constructor(staking_pool_whitelist_account_id: AccountId) {
        super();
        this.staking_pool_whitelist_account_id = staking_pool_whitelist_account_id;
        this.staking_pool_account_ids = new Set<AccountId>();
    }
    get_min_attached_balance(): Balance {
        return MIN_ATTACHED_BALANCE;
    }
    get_number_of_staking_pools_created(): u64 {
        return this.staking_pool_account_ids.size
    }

    create_staking_pool(
        staking_pool_id: string,
        owner_id: AccountId,
        stake_public_key: Base58PublicKey,
        reward_fee_fraction: RewardFeeFraction,
    ):  ContractPromiseBatch {
        assert(
            context.attachedDeposit >= MIN_ATTACHED_BALANCE,
            "Not enough attached deposit to complete staking pool creation"
        );

        assert(
            !staking_pool_id.includes(SUBACCOUNT_SEPARATOR),
            "The staking pool ID can't contain `.`"
        );

        let staking_pool_account_id = [staking_pool_id, context.contractName].join(SUBACCOUNT_SEPARATOR);

        assert(
            env.isValidAccountID(staking_pool_account_id),
            "The staking pool account ID is invalid"
        );

        assert(
            env.isValidAccountID(owner_id),
            "The owner account ID is invalid"
        );

        reward_fee_fraction.assert_valid();
        
        
        assert(
            !this.staking_pool_account_ids.has(staking_pool_account_id),
            "The staking pool account ID already exists"
        );

        this.staking_pool_account_ids.add(staking_pool_account_id)
        
        let stakingPoolBin = Uint8Array.wrap(changetype<ArrayBuffer>(includeBytes("../../../build/release/staking-pool.wasm")));
        
        return ContractPromiseBatch.create(staking_pool_account_id)
            .create_account()
            .transfer(context.attachedDeposit)
            .deploy_contract(stakingPoolBin)
            .function_call(
                ExtStakingPool.NEW_METHOD,
                ExtStakingPool.newArgs(
                    owner_id,
                    stake_public_key,
                    reward_fee_fraction,
                ),
                NO_DEPOSIT,
                GasPrices.STAKING_POOL_NEW,
            )
            .then(context.contractName)
            .function_call(
                ExtSelf.ON_STAKING_POOL_CREATE_METHOD,
                ExtSelf.onStakingPoolCreateArgs(
                    staking_pool_account_id,
                    context.attachedDeposit,
                    context.predecessor
                ),
                NO_DEPOSIT,
                GasPrices.CALLBACK
            )
    }
    on_staking_pool_create(
        staking_pool_account_id: AccountId,
        attached_deposit: u128,
        predecessor_account_id: AccountId,
    ) : ContractPromiseBatch {
        this.assert_self();

        let staking_pool_created = this.is_promise_success();

        if (staking_pool_created) {
            logging.log("The staking pool "+staking_pool_account_id+"was successfully created. Whitelisting...",);
            let whitelist = new ExtWhitelist(this.staking_pool_whitelist_account_id);
            return whitelist.add_staking_pool(staking_pool_account_id);
        } else {
            this.staking_pool_account_ids.delete(staking_pool_account_id);

            logging.log(
                    "The staking pool "+staking_pool_account_id+"creation has failed. Returning attached deposit of "+attached_deposit.toString()+" to " + predecessor_account_id);
            return ContractPromiseBatch.create(predecessor_account_id).transfer(attached_deposit);
        }
    }
}

class RewardFeeFraction {
    numerator: u32;
    denominator: u32;
    assert_valid(): void {
        assert(this.denominator != 0, "Denominator must be a positive number");
        assert(this.numerator <= this.denominator, "The reward fee must be less than or equal to 1");
    }
}


class ExtContract {
    constructor(public accountId: AccountId) {}
    call<T>(method: string, args: T, amount: u128, gas: Gas ): ContractPromiseBatch {
        return ContractPromiseBatch.create(this.accountId).function_call(
            method,
            args,
            amount,
            gas
        );
    }
}

@nearBindgen
class SelfOnStakingPoolCreateArgs {
    staking_pool_account_id: AccountId;
    attached_deposit: u128;
    predecessor_account_id: AccountId;
}

// @nearBindgen
class ExtSelf { // extends ExtContract{
    static readonly ON_STAKING_POOL_CREATE_METHOD: string = "on_staking_pool_create";
    static onStakingPoolCreateArgs(
        staking_pool_account_id: AccountId, 
        attached_deposit: u128, 
        predecessor_account_id: AccountId
    ): SelfOnStakingPoolCreateArgs {
        return {
            staking_pool_account_id,
            attached_deposit,
            predecessor_account_id
        }
    }
}

@nearBindgen
class StakingPoolNewArgs {
    owner_id: AccountId;
    stake_public_key: Base58PublicKey;
    reward_fee_fraction: RewardFeeFraction;
}

class ExtStakingPool {
    static readonly NEW_METHOD:string = "new";
    static newArgs(owner_id: AccountId, stake_public_key: Base58PublicKey, reward_fee_fraction: RewardFeeFraction): StakingPoolNewArgs {
        return {
            owner_id,
            stake_public_key,
            reward_fee_fraction
        }
    }
}


@nearBindgen 
class WhitelistAddStakingPoolArgs {
    staking_pool_account_id: AccountId
}


class ExtWhitelist extends ExtContract {
    static readonly ADD_STAKING_POOL_METHOD: string = "add_staking_pool";
    static addStakingPoolArgs(staking_pool_account_id: AccountId): WhitelistAddStakingPoolArgs {
        return {staking_pool_account_id}
    }
    constructor(accountId: AccountId) {super(accountId)}
    add_staking_pool(staking_pool_account_id: AccountId): ContractPromiseBatch {
        return this.call(
            ExtWhitelist.ADD_STAKING_POOL_METHOD,
            ExtWhitelist.addStakingPoolArgs(staking_pool_account_id),
            u128.Zero,
            GasPrices.WHITELIST_STAKING_POOL );
    }
}


