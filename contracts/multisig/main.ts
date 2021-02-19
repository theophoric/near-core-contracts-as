import {
  u128,
  context,
  env,
  storage,
  base58,
  logging,
  ContractPromiseBatch,
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


const DEFAULT_ALLOWANCE: u128 = u128.Zero;
const REQUEST_COOLDOWN: u64 = 900_000_000_000;

export type RequestId = u32;

// @ts-ignore
@nearBindgen
export class FunctionCallPermission {
  allowance: Option < u128 >
    receiver_id: AccountId
  method_names: Array < string >
}
// @ts-ignore
@nearBindgen
export class MultiSigRequestAction {
  constructor(readonly type: ActionType) {}
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

// @ts-ignore
@nearBindgen
export class TransferAction extends MultiSigRequestAction {
  constructor(readonly amount: u128) {
    super(ActionType.Transfer);
  }
}

// @ts-ignore
@nearBindgen
export class CreateAccountAction extends MultiSigRequestAction {
  constructor() {
    super(ActionType.CreateAccount);
  }
}

// @ts-ignore
@nearBindgen
export class DeployContractAction extends MultiSigRequestAction {
  constructor(readonly code: Uint8Array) {
    super(ActionType.DeployContract);
  }
}

// @ts-ignore
@nearBindgen
export class AddKeyAction extends MultiSigRequestAction {
  constructor(
    readonly public_key: PublicKey,
    readonly permission: Option < FunctionCallPermission >
  ) {
    super(ActionType.AddKey);
  }
}

// @ts-ignore
@nearBindgen
export class DeleteKeyAction extends MultiSigRequestAction {
  constructor(
    readonly public_key: PublicKey
  ) {
    super(ActionType.DeleteKey);
  }
}

// @ts-ignore
@nearBindgen
export class FunctionCallAction extends MultiSigRequestAction {

  constructor(
    readonly method_name: string,
    readonly args: Uint8Array,
    readonly deposit: u128,
    readonly gas: u64
  ) {
    super(ActionType.FunctionCall);
  }

}
// @ts-ignore
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
  constructor(readonly key: StorageKey) {}
}
/*****************************
 * MAIN CONTRACT CLASS
 ***************************** */
@nearBindgen
export class MultiSigContract extends BaseContract {
  num_confirmations: u32
  request_nonce: RequestId
  requests: Map < RequestId,
  MultiSigRequestWithSigner >
  confirmations: Map < RequestId, Set < PublicKey >>
  num_requests_pk: Map < PublicKey, u32 >
  // per_key
  active_requests_limit: u32

  constructor() {
    super(KEY_MULTI_SIG_CONTRACT)
    let state = storage.get < MultiSigContract > (this.key)
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
    storage.set < MultiSigContract > (this.key, this);
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
    let confirmations = new Set < Uint8Array > ();
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

  execute_request(request: MultiSigRequest): ContractPromiseBatch  {
    let promise = ContractPromiseBatch.create(request.receiver_id);
    let receiver_id = request.receiver_id;
    let num_actions = request.actions.length;
    
    request.actions.forEach((action) => {
      switch (action.type) {
        case ActionType.Transfer: {
          let {
            amount
          } = (action as TransferAction);
          promise = promise.transfer(amount);
        }
        case ActionType.CreateAccount: {
          promise = promise.create_account();
        }
        case ActionType.DeployContract: {
          let {
            code
          } = (action as DeployContractAction)
          promise = promise.deploy_contract(code);
        }
        case ActionType.AddKey: {
          let {
            public_key,
            permission
          } = (action as AddKeyAction);
          this.assert_self_request(receiver_id);
          if (permission) {
            promise = promise.add_access_key(
              public_key,
              permission.allowance || DEFAULT_ALLOWANCE,
              permission.receiver_id,
              permission.method_names
            )
          } else {
            promise = promise.add_full_access_key(public_key);
          }
        }
        case ActionType.DeleteKey: {
          let {
            public_key
          } = (action as DeleteKeyAction);
          this.assert_self_request(receiver_id);
          let pk: PublicKey = public_key;
          let request_ids: Array<u32> = [];
          // NOTE :: Not sure if there's a better way to do this in AssemblyScript // Does not support `for(let E of S)` syntax -T
          for(let i = 0; i < this.requests.size; i ++ ) {
            let r_id = this.requests.keys()[i];
            let r = this.requests.get(r_id);
            if (r.signer_pk == pk) {
              request_ids.push(r_id) 
            }
          }
          for(let i = 0; i < request_ids.length; i++ ) {
            let r_id = request_ids[i];
            this.confirmations.delete(r_id);
            this.requests.delete(r_id);
          }
          this.num_requests_pk.delete(pk);
          promise = promise.delete_key(pk);
        }
        case ActionType.FunctionCall: {
          let {
            method_name,
            args,
            deposit,
            gas,
          } = (action as FunctionCallAction);
          promise = promise.function_call(method_name, args, deposit, gas);
        }
        case ActionType.SetNumConfirmations: {
          let {
            num_confirmations 
          } = (action as SetNumConfirmationsAction);
          this.assert_one_action_only(receiver_id, num_actions);
          this.num_confirmations = num_confirmations;
          return promise;
        }
        case ActionType.SetActiveRequestsLimit: {
          let {
            active_request_limit
          } = (action as SetActiveRequestsLimitAction);
          this.assert_one_action_only(receiver_id, num_actions);
          this.active_requests_limit = active_request_limit;
          return promise;
        }
      }
    });
    return promise;
  }

  /// Confirm given request with given signing key.
  /// If with this, there has been enough confirmation, a promise with request will be scheduled.
  confirm(request_id: RequestId): ContractPromiseBatch {
    this.assert_valid_request(request_id);
    let signer_acount_pk = base58.decode(context.senderPublicKey);
    let confirmations = this.confirmations.get(request_id);
    assert(!confirmations.has(signer_acount_pk), "Already confirmed this request from this key");
    if (confirmations.size + 1 >= this.num_confirmations) { // why not just c.size > this.n_c ? (vs +1 >=) -T
      let request = this.remove_request(request_id);
           /********************************
            NOTE: If the tx execution fails for any reason, the request and confirmations are removed already, so the client has to start all over
            ********************************/
      return this.execute_request(request);
    } else {
      confirmations.add(signer_acount_pk);
      this.confirmations.set(request_id, confirmations);
      return new ContractPromiseBatch();
    }
  }

  /********************************
  Helper methods
  ********************************/

  // removes request, removes confirmations and reduces num_requests_pk - used in delete, delete_key, and confirm
  remove_request(request_id: RequestId): MultiSigRequest {
    // remove confirmations for this request
    this.confirmations.delete(request_id);
    let request_with_signer = this.requests.get(request_id);
    assert((request_with_signer), "Failed to remove existing element");
    // remove the original request
    this.requests.delete(request_id);
    // decrement num requests for original request signer
    let original_signer_pk = request_with_signer.signer_pk;
    let num_requests = this.num_requests_pk.get(original_signer_pk)
    if (num_requests > 0) {
      num_requests = num_requests - 1;
    }
    this.num_requests_pk.set(original_signer_pk, num_requests);
    // return request
    return request_with_signer.request;
  }

  private assert_valid_request(request_id: RequestId) {
    assert(context.contractName == context.predecessor, "Predecessor account must be current account");
    assert(this.requests.has(request_id), "No such request: either wrong number or already confirmed");
    assert(this.confirmations.has(request_id), "Internal error: confirmations mismatch requests");
  }
  private assert_self_request(receiver_id: AccountId) {
    assert(receiver_id == context.contractName, "This method only works when receiver_id is equal to current_account_id");
  }

  private assert_one_action_only(receiver_id: AccountId, num_actions: usize) {
    this.assert_self_request(receiver_id);
    assert(num_actions == 1, "This metod should be a separate request");
  }

  /********************************
  View methods
  ********************************/

  get_request(request_id: RequestId): MultiSigRequest {
    assert(this.requests.has(request_id), "No such request");
    return this.requests.get(request_id).request;
  }

  get_num_requests_pk(public_key: PublicKey): u32 {
    return this.num_requests_pk.get(public_key);
  }

  list_request_ids(): Array<RequestId> {
    return this.requests.keys();
  }

  get_confirmations(request_id: RequestId) : Array<PublicKey> {
    assert(this.confirmations.has(request_id), "No such request");
    let request_confirmations = this.confirmations.get(request_id);
    return request_confirmations.values();
  }
  get_num_confirmations(): u32  {
    return this.num_confirmations;
  }
  get_request_nonce(): u32 {
    return this.request_nonce;
  }
}

/***************************
  CONTRACT INTERFACE
******************************/

// @ts-ignore
@exportAs("default")
export function fallback() {
  logging.log("💥 :: Multisig contract should be initialized before usage");
  env.panic();
}

// @ts-ignore
@exportAs("new")
export function main() {
  assert(!storage.hasKey(KEY_MULTI_SIG_CONTRACT), "Already initialized");

}

export function add_request(request: MultiSigRequest): RequestId {
  let contract = new MultiSigContract();
  let result = contract.add_request(request);
  contract.persist();
  return result;
}

export function add_request_and_confirm(request: MultiSigRequest): RequestId {
  let contract = new MultiSigContract();
  let result = contract.add_request_and_confirm(request);
  contract.persist();
  return result;
}

export function delete_request(request_id: RequestId) {
  let contract = new MultiSigContract();
  contract.delete_request(request_id);
  contract.persist();
}

export function execute_request(request: MultiSigRequest): ContractPromiseBatch  {
  let contract = new MultiSigContract();
  let result = contract.execute_request(request);
  contract.persist();
  return result;
}

/// Confirm given request with given signing key.
/// If with this, there has been enough confirmation, a promise with request will be scheduled.
export function confirm(request_id: RequestId): ContractPromiseBatch {
  let contract = new MultiSigContract();
  let result = contract.confirm(request_id);
  contract.persist();
  return result;
}

/********************************
Helper methods
********************************/

// removes request, removes confirmations and reduces num_requests_pk - used in delete, delete_key, and confirm
export function remove_request(request_id: RequestId): MultiSigRequest {
  let contract = new MultiSigContract();
  let result = contract.remove_request(request_id);
  contract.persist();
  return result;
}


/********************************
View methods
********************************/

export function get_request(request_id: RequestId): MultiSigRequest {
  let contract = new MultiSigContract();
  return contract.get_request(request_id);
}

export function get_num_requests_pk(public_key: PublicKey): u32 {
  let contract = new MultiSigContract();
  return contract.get_num_requests_pk(public_key);
}

export function list_request_ids(): Array<RequestId> {
  let contract = new MultiSigContract();
  return contract.list_request_ids();
}

export function get_confirmations(request_id: RequestId) : Array<PublicKey> {
  let contract = new MultiSigContract();
  let result = contract.get_confirmations(request_id);
  return result;
}
export function get_num_confirmations(): u32  {
  let contract = new MultiSigContract();
  let result = contract.get_num_confirmations();
  return result;
}
export function get_request_nonce(): u32 {
  let contract = new MultiSigContract();
  let result = contract.get_request_nonce();
  return result;
}

// HELPER FUNCTIONS

function _is_some < T > (option: Option < T > ): bool {
  return option == null;
}


function _load_contract < T > (key: StorageKey): Option < T > {
  return storage.get < T > (key);
}
