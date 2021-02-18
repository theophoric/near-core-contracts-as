import {
  u128,
  context,
  env,
  storage,
  PersistentVector,
  base58,
  logging,
  ContractPromise,
  ContractPromiseBatch,
  
} from 'near-sdk-as'

// NEAR types //
type AccountId = string;
type Balance = u128;
type EpochHeight = number;
type WrappedTimestamp = u64;
type PublicKey = Uint8Array;


// Generic types //
type Option<T> = T | None;
type None = null;

// STORAGE //
type StorageKey = string;
const KEY_MULTI_SIG_CONTRACT: StorageKey = "ms";


const DEFAULT_ALLOWANCE: u128 = u128.Zero;
const REQUEST_COOLDOWN: u64 = 900_000_000_000;

export type RequestId = u32;

// @ts-ignore
@nearBindgen
export class FunctionCallPermission {
  allowance: Option<u128>
  receiver_id: AccountId
  method_names: Array<String>
}
@nearBindgen
export class MultiSigRequestAction {
  constructor(readonly type: ActionType){}
}

// @ts-ignore
@nearBindgen
export enum ActionType {
  Transfer,
  CreateAccount,
  DeployContract,
  AddKey,
  DeleteKey,
  FunctionCall,
  SetNumConfirmations,
  SetActiveRequestsLimit,
}


@nearBindgen
export class TransferAction extends MultiSigRequestAction {
  constructor(readonly amount: u128) {
    super(ActionType.Transfer);
  }
}

@nearBindgen
export class CreateAccountAction extends MultiSigRequestAction {
  constructor() {
    super(ActionType.CreateAccount);
  }
}
@nearBindgen
export class DeployContractAction extends MultiSigRequestAction {
  constructor(readonly code: Uint8Array) {
    super(ActionType.DeployContract);
  }
}
@nearBindgen
export class AddKeyAction extends MultiSigRequestAction {
  constructor(
    readonly public_key: PublicKey,
    readonly permission: Option<FunctionCallPermission>
  ) {
    super(ActionType.AddKey);
  }
}
@nearBindgen
export class DeleteKeyAction extends MultiSigRequestAction {
  constructor(
    readonly public_key: PublicKey,
  ) {
    super(ActionType.DeleteKey);
  }
}
@nearBindgen
export class FunctionCallAction extends MultiSigRequestAction {

  constructor(
    readonly method_name: String,
    readonly args: Uint8Array,
    readonly deposit: u128,
    readonly gas: u64
  ) {
    super(ActionType.FunctionCall);
  }

}
@nearBindgen
export class SetNumConfirmationsAction extends MultiSigRequestAction {
  constructor(
    readonly num_confirmations: u32
  ) {
    super(ActionType.SetNumConfirmations);
  }
}
@nearBindgen
export class SetActiveRequestsLimitAction extends MultiSigRequestAction {
  constructor(
    readonly active_request_limit: u32
  ) {
    super(ActionType.SetActiveRequestsLimit);
  }
}
@nearBindgen
export class MultiSigRequest {
  receiver_id: AccountId
  actions: MultiSigRequestAction[]
}

@nearBindgen
export class MultiSigRequestWithSigner {
  request: MultiSigRequest
  signer_pk: PublicKey
  added_timestamp: u64
}

@nearBindgen
abstract class BaseContract {
  abstract persist(): void
  constructor(readonly key: StorageKey){}
}

@nearBindgen
export class MultiSigContract extends BaseContract {
  num_confirmations: u32
  request_nonce: RequestId
  requests: Map<RequestId, MultiSigRequestWithSigner>
  confirmations: Map<RequestId, Set<PublicKey>>
  num_requests_pk: Map<PublicKey, u32>
  // per_key
  active_requests_limit: u32

  constructor() {
    super(KEY_MULTI_SIG_CONTRACT)
    let state = storage.get<MultiSigContract>(this.key)
    if (state) {
      this.num_confirmations = state.num_confirmations;
      this.request_nonce = state.request_nonce;
      this.requests = state.requests;
      this.confirmations = state.confirmations;
      this.num_requests_pk = state.num_requests_pk;
      this.active_requests_limit = state.active_requests_limit;
    }
  }

  persist() {
    storage.set<MultiSigContract>(this.key, this);
  }

  add_request(request: MultiSigRequest): RequestId {
    assert(
      (context.contractName == context.predecessor),
      "Predecessor account must match current account"
    );
    let sender_pk = base58.decode(context.senderPublicKey);
    let num_requests = this.num_requests_pk.get(sender_pk) + 1;
    assert(num_requests <= this.active_requests_limit, "Account has too many active requests");
    this.num_requests_pk.set(sender_pk, num_requests);
    let confirmations = new Set<Uint8Array>();
    this.confirmations.set(this.request_nonce, confirmations);
    this.request_nonce += 1;
    return this.request_nonce - 1;
  }

  add_request_and_confirm(request: MultiSigRequest): RequestId {
    let request_id = this.add_request(request);
    this.confirm(request_id);
    return request_id;
  }

  delete_request(request_id: RequestId) {
    this.assert_valid_request(request_id);
    let request_with_signer = this.requests.get(request_id);
    assert((request_with_signer), "No such request");
    assert(context.blockTimestamp > request_with_signer.added_timestamp + REQUEST_COOLDOWN, "Request cannot be deleted immediately after creation");
  }

  execute_request(request: MultiSigRequest): ContractPromiseBatch {
    let promise = ContractPromiseBatch.create(request.receiver_id);
    let receiver_id = request.receiver_id;
    let num_actions = request.actions.length;
    request.actions.forEach((action) => {
        switch (action.type) {
          case ActionType.Transfer:
            let { amount } = (action as TransferAction);
            promise = promise.transfer(amount);
          case ActionType.CreateAccount:
            promise =  promise.create_account();
          case ActionType.DeployContract:
            let { code } = (action as DeployContractAction)
            promise = promise.deploy_contract(code);
          case ActionType.AddKey:
            let { public_key, permission } = (action as AddKeyAction);
            this.assert_self_request(receiver_id);
            if (_is_some(permission)) {

            }
        }
    });
      

  }
}

@exportAs("default")
export function fallback() {
  logging.log("💥 :: Multisig contract should be initialized before usage");
  env.panic();
}

@exportAs("new")
export function main() {
  assert(!storage.hasKey(KEY_MULTI_SIG_CONTRACT), "Already initialized");

}

// interface Option2<T> {
//   readonly value: T
//   is_some(): bool
//   is_none(): bool
//   unwrap(): T
// }

// class Some<T> extends Option2 {
//   constructor() 
// }

function _is_some<T>(option: Option<T>): bool {
  return option == null;
}


function _load_contract<T>(key: StorageKey): Option<T> {
  return storage.get<T>(key); 
}









/// UTILITY STUFF /**  */

