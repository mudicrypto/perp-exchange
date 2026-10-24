//! Offline behaviour tests for the measurement contract (cargo test). They pin the settlement
//! semantics analysed in docs/venue/STELLAR-SPIKE-RESULTS.md: exactly-once cursor (duplicates,
//! retries, gaps), cumulative fill limit, replay protection, epoch invalidation, expiry, price limits,
//! self-trade, and batch atomicity; and the alternative idempotent fill identifier (any order,
//! exactly once).
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{Address as _, Ledger};

/// The contract error code carried by a failed invocation (panics if it failed any other way).
fn code<T: core::fmt::Debug, C: core::fmt::Debug>(r: Result<T, Result<soroban_sdk::Error, C>>) -> u32 {
    match r {
        Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Contract) => e.get_code(),
        other => panic!("expected a contract error, got {:?}", other),
    }
}

struct World {
    env: Env,
    client: SettlementSpikeClient<'static>,
    buyer: Address,
    seller: Address,
    buyer_key: SigningKey,
    seller_key: SigningKey,
}

fn world(temp: bool) -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 1_000);
    let id = env.register(SettlementSpike, ());
    let client = SettlementSpikeClient::new(&env, &id);
    client.init(&Address::generate(&env), &temp);
    let (buyer, seller) = (Address::generate(&env), Address::generate(&env));
    let (buyer_key, seller_key) = (SigningKey::from_bytes(&[7u8; 32]), SigningKey::from_bytes(&[9u8; 32]));
    client.register_key(&buyer, &BytesN::from_array(&env, &buyer_key.verifying_key().to_bytes()));
    client.register_key(&seller, &BytesN::from_array(&env, &seller_key.verifying_key().to_bytes()));
    client.seed_balance(&buyer, &1, &1_000_000_000);
    client.seed_balance(&seller, &0, &1_000_000);
    World { env, client, buyer, seller, buyer_key, seller_key }
}

fn order(_w: &World, account: &Address, side: u32, price: u64, max_qty: u64, salt: u64) -> Order {
    Order { account: account.clone(), pair: 1, side, price, max_qty, expiry: 2_000, epoch: 0, salt }
}

fn sign(w: &World, client: &SettlementSpikeClient, key: &SigningKey, o: &Order) -> BytesN<64> {
    let hash = client.order_hash(o);
    BytesN::from_array(&w.env, &key.sign(&hash.to_array()).to_bytes())
}

fn fill(w: &World, seq: u64, maker: &Order, taker: &Order, qty: u64) -> Fill {
    let mk = if maker.account == w.buyer { &w.buyer_key } else { &w.seller_key };
    let tk = if taker.account == w.buyer { &w.buyer_key } else { &w.seller_key };
    Fill { seq, idx: 0, maker: maker.clone(), maker_sig: sign(w, &w.client, mk, maker), taker: taker.clone(), taker_sig: sign(w, &w.client, tk, taker), qty }
}

#[test]
fn settles_at_maker_price_and_moves_internal_balances() {
    for temp in [false, true] {
        let w = world(temp);
        let ask = order(&w, &w.seller, 1, 4_000, 100, 1);
        let bid = order(&w, &w.buyer, 0, 4_010, 100, 2);
        w.client.settle(&fill(&w, 1, &ask, &bid, 30));
        assert_eq!(w.client.balance(&w.buyer, &0), 30);
        assert_eq!(w.client.balance(&w.seller, &1), 4_000 * 30);
        assert_eq!(w.client.balance(&w.buyer, &1), 1_000_000_000 - 4_000 * 30);
        assert_eq!(w.client.cursor(), (1, 0));
        assert_eq!(w.client.filled(&w.client.order_hash(&ask)), 30);
    }
}

#[test]
fn cursor_rejects_duplicates_and_retries_but_cannot_see_gaps() {
    let w = world(false);
    let ask = order(&w, &w.seller, 1, 4_000, 100, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
    let first = fill(&w, 5, &ask, &bid, 10);
    w.client.settle(&first);
    // Duplicate submission or retry after an unknown outcome: rejected, nothing moves twice.
    assert_eq!(code(w.client.try_settle(&first)), Error::CursorNotIncreasing as u32);
    assert_eq!(w.client.balance(&w.buyer, &0), 10);
    // An earlier position is rejected too (out-of-order submission).
    assert_eq!(code(w.client.try_settle(&fill(&w, 4, &ask, &bid, 10))), Error::CursorNotIncreasing as u32);
    // A gap (seq 6..=8 never presented) is accepted: the contract cannot know they existed.
    w.client.settle(&fill(&w, 9, &ask, &bid, 10));
    assert_eq!(w.client.cursor(), (9, 0));
    // A skipped fill can never be settled afterwards.
    assert_eq!(code(w.client.try_settle(&fill(&w, 7, &ask, &bid, 10))), Error::CursorNotIncreasing as u32);
}

#[test]
fn cumulative_fill_limit_holds_across_partial_fills() {
    let w = world(true);
    let ask = order(&w, &w.seller, 1, 4_000, 50, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 500, 2);
    w.client.settle(&fill(&w, 1, &ask, &bid, 30));
    w.client.settle(&fill(&w, 2, &ask, &bid, 20));
    assert_eq!(code(w.client.try_settle(&fill(&w, 3, &ask, &bid, 1))), Error::Overfill as u32);
}

#[test]
fn signatures_do_not_replay_across_contracts() {
    let w = world(false);
    let other_id = w.env.register(SettlementSpike, ());
    let other = SettlementSpikeClient::new(&w.env, &other_id);
    other.init(&Address::generate(&w.env), &false);
    other.register_key(&w.buyer, &BytesN::from_array(&w.env, &w.buyer_key.verifying_key().to_bytes()));
    other.register_key(&w.seller, &BytesN::from_array(&w.env, &w.seller_key.verifying_key().to_bytes()));
    other.seed_balance(&w.buyer, &1, &1_000_000_000);
    other.seed_balance(&w.seller, &0, &1_000_000);
    let ask = order(&w, &w.seller, 1, 4_000, 100, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
    // Signed for the first contract; the second contract's domain differs, so verification fails.
    assert!(other.try_settle(&fill(&w, 1, &ask, &bid, 10)).is_err());
    assert_eq!(other.balance(&w.buyer, &0), 0);
}

#[test]
fn epoch_bump_and_expiry_invalidate_signed_orders() {
    let w = world(false);
    let ask = order(&w, &w.seller, 1, 4_000, 100, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
    let f = fill(&w, 1, &ask, &bid, 10);
    w.client.bump_epoch(&w.seller);
    assert_eq!(code(w.client.try_settle(&f)), Error::StaleEpoch as u32);
    let w = world(false);
    let ask = order(&w, &w.seller, 1, 4_000, 100, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
    let f = fill(&w, 1, &ask, &bid, 10);
    w.env.ledger().with_mut(|l| l.sequence_number = 2_001);
    assert_eq!(code(w.client.try_settle(&f)), Error::Expired as u32);
}

#[test]
fn price_limits_and_self_trade_are_enforced() {
    let w = world(false);
    let ask = order(&w, &w.seller, 1, 4_020, 100, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
    assert_eq!(code(w.client.try_settle(&fill(&w, 1, &ask, &bid, 10))), Error::PriceOutsideLimit as u32);
    let own = order(&w, &w.buyer, 1, 4_000, 100, 3);
    assert_eq!(code(w.client.try_settle(&fill(&w, 2, &own, &bid, 10))), Error::SelfTrade as u32);
}

#[test]
fn a_batch_is_atomic() {
    let w = world(false);
    let ask = order(&w, &w.seller, 1, 4_000, 15, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
    let mut fills = Vec::new(&w.env);
    fills.push_back(fill(&w, 1, &ask, &bid, 10));
    fills.push_back(fill(&w, 2, &ask, &bid, 10)); // overfills the ask: the whole batch must revert
    assert_eq!(code(w.client.try_settle_batch(&fills)), Error::Overfill as u32);
    assert_eq!(w.client.cursor(), (0, 0));
    assert_eq!(w.client.balance(&w.buyer, &0), 0);
    assert_eq!(w.client.filled(&w.client.order_hash(&ask)), 0);
}

#[test]
fn idempotent_fill_ids_settle_once_in_any_order() {
    for temp in [false, true] {
        let w = world(temp);
        let ask = order(&w, &w.seller, 1, 4_000, 100, 1);
        let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
        let later = fill(&w, 9, &ask, &bid, 10);
        let earlier = fill(&w, 7, &ask, &bid, 10);
        // Out-of-order arrival is accepted: (9, 0) then (7, 0).
        w.client.settle_idem(&later);
        w.client.settle_idem(&earlier);
        assert_eq!(w.client.balance(&w.buyer, &0), 20);
        assert!(w.client.is_settled(&9, &0) && w.client.is_settled(&7, &0) && !w.client.is_settled(&8, &0));
        // Duplicates and retries are rejected; nothing moves twice.
        assert_eq!(code(w.client.try_settle_idem(&later)), Error::AlreadySettled as u32);
        assert_eq!(code(w.client.try_settle_idem(&earlier)), Error::AlreadySettled as u32);
        assert_eq!(w.client.balance(&w.buyer, &0), 20);
        // The idempotent path does not touch the cursor, and all other checks still apply.
        assert_eq!(w.client.cursor(), (0, 0));
        assert_eq!(code(w.client.try_settle_idem(&fill(&w, 8, &ask, &bid, 81))), Error::Overfill as u32);
        assert!(!w.client.is_settled(&8, &0));
    }
}

#[test]
fn idempotent_batch_is_atomic_and_rejects_internal_duplicates() {
    let w = world(false);
    let ask = order(&w, &w.seller, 1, 4_000, 100, 1);
    let bid = order(&w, &w.buyer, 0, 4_000, 100, 2);
    let mut fills = Vec::new(&w.env);
    fills.push_back(fill(&w, 3, &ask, &bid, 10));
    fills.push_back(fill(&w, 3, &ask, &bid, 10)); // the same identifier twice in one batch
    assert_eq!(code(w.client.try_settle_batch_idem(&fills)), Error::AlreadySettled as u32);
    assert!(!w.client.is_settled(&3, &0));
    assert_eq!(w.client.balance(&w.buyer, &0), 0);
}
