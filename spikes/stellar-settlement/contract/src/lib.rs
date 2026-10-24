//! Milestone 12, WP3 — measurement-only settlement contract (testnet spike).
//!
//! NOT A VAULT. It holds no tokens, accepts no deposits and performs no withdrawals: balances are
//! internal numbers seeded by the spike client, so that the storage and CPU work of a settlement can
//! be measured. Key registration and balance seeding are deliberately unauthenticated (measurement
//! only); a real design requires the account's own authorisation for both.
//!
//! What it does model faithfully (docs/venue/STELLAR-FEASIBILITY.md §2–§4):
//! - orders signed off-chain with a registered ed25519 trading key over a domain-separated hash
//!   (domain tag, network id, this contract's address, the order's XDR);
//! - per-fill checks: same pair, opposite sides, different accounts, price within both limits (fill
//!   at the maker's price), expiry, epoch, cumulative fill limit per order;
//! - a strictly increasing settlement cursor (journal seq, fill index) for exactly-once settlement;
//! - fill counters in temporary or persistent storage (chosen at init), with TTL to order expiry;
//! - journal-head anchoring.
//!
//! For comparison it also has an alternative exactly-once rule, an idempotent fill identifier: each
//! (seq, index) is recorded as settled and may settle once, in any order (`settle_idem`,
//! `settle_batch_idem`). All other per-fill checks are identical. This is a measurement of the
//! alternative, not a recommendation in itself (docs/venue/STELLAR-SPIKE-RESULTS.md).
#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, xdr::ToXdr, Address, Bytes, BytesN, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub account: Address,
    pub pair: u32,
    /// 0 = buy, 1 = sell.
    pub side: u32,
    /// Limit price in ticks.
    pub price: u64,
    /// Maximum base quantity in lots.
    pub max_qty: u64,
    /// Last ledger at which the order may be settled.
    pub expiry: u32,
    pub epoch: u32,
    pub salt: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fill {
    /// Engine journal position of the execution: (seq, index within the command).
    pub seq: u64,
    pub idx: u32,
    pub maker: Order,
    pub maker_sig: BytesN<64>,
    pub taker: Order,
    pub taker_sig: BytesN<64>,
    pub qty: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum Key {
    Operator,
    TempCounters,
    Cursor,
    AnchorHead,
    AnchorCount,
    TradingKey(Address),
    Epoch(Address),
    Filled(BytesN<32>),
    /// Internal balance of (account, asset): 0 = base, 1 = quote.
    Balance(Address, u32),
    Probe(u32),
    /// Idempotent alternative: settled marker for the fill identifier (seq, index).
    Settled(u64, u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    CursorNotIncreasing = 3,
    PairMismatch = 4,
    SameSide = 5,
    SelfTrade = 6,
    PriceOutsideLimit = 7,
    Expired = 8,
    StaleEpoch = 9,
    Overfill = 10,
    UnknownTradingKey = 11,
    InsufficientBalance = 12,
    ZeroQuantity = 13,
    AlreadySettled = 14,
}

const DOMAIN: &[u8] = b"venue-order/1";
const TTL_MARGIN: u32 = 100;

fn operator(env: &Env) -> Address {
    env.storage().instance().get(&Key::Operator).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// sha256(domain || network id || contract address XDR || order XDR).
pub fn order_hash(env: &Env, order: &Order) -> BytesN<32> {
    let mut b = Bytes::from_slice(env, DOMAIN);
    b.append(&Bytes::from(env.ledger().network_id()));
    b.append(&env.current_contract_address().to_xdr(env));
    b.append(&order.clone().to_xdr(env));
    env.crypto().sha256(&b).to_bytes()
}

fn verify_order(env: &Env, order: &Order, sig: &BytesN<64>) -> BytesN<32> {
    let key: BytesN<32> = env
        .storage()
        .persistent()
        .get(&Key::TradingKey(order.account.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::UnknownTradingKey));
    let hash = order_hash(env, order);
    env.crypto().ed25519_verify(&key, &Bytes::from(hash.clone()), sig);
    let epoch: u32 = env.storage().persistent().get(&Key::Epoch(order.account.clone())).unwrap_or(0);
    if order.epoch != epoch {
        panic_with_error!(env, Error::StaleEpoch);
    }
    if env.ledger().sequence() > order.expiry {
        panic_with_error!(env, Error::Expired);
    }
    hash
}

fn add_filled(env: &Env, hash: &BytesN<32>, order: &Order, qty: u64) {
    let key = Key::Filled(hash.clone());
    let temp: bool = env.storage().instance().get(&Key::TempCounters).unwrap_or(false);
    let ttl = (order.expiry.saturating_sub(env.ledger().sequence()) + TTL_MARGIN).min(env.storage().max_ttl());
    let filled: u64 = if temp { env.storage().temporary().get(&key).unwrap_or(0) } else { env.storage().persistent().get(&key).unwrap_or(0) };
    let next = filled.checked_add(qty).unwrap_or_else(|| panic_with_error!(env, Error::Overfill));
    if next > order.max_qty {
        panic_with_error!(env, Error::Overfill);
    }
    if temp {
        env.storage().temporary().set(&key, &next);
        env.storage().temporary().extend_ttl(&key, ttl, ttl);
    } else {
        env.storage().persistent().set(&key, &next);
        env.storage().persistent().extend_ttl(&key, ttl, ttl);
    }
}

fn move_balance(env: &Env, account: &Address, asset: u32, delta: i128) {
    let key = Key::Balance(account.clone(), asset);
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = current + delta;
    if next < 0 {
        panic_with_error!(env, Error::InsufficientBalance);
    }
    env.storage().persistent().set(&key, &next);
}

/// Exactly-once rule A: a strictly increasing cursor over (seq, index).
fn advance_cursor(env: &Env, fill: &Fill) {
    let cursor: (u64, u32) = env.storage().instance().get(&Key::Cursor).unwrap_or((0, 0));
    if (fill.seq, fill.idx) <= cursor {
        panic_with_error!(env, Error::CursorNotIncreasing);
    }
    env.storage().instance().set(&Key::Cursor, &(fill.seq, fill.idx));
}

/// Exactly-once rule B: a settled marker per fill identifier, kept at least until both orders have
/// expired (after that the expiry check alone rejects a replay of the same signed orders).
fn mark_settled(env: &Env, fill: &Fill) {
    let key = Key::Settled(fill.seq, fill.idx);
    let temp: bool = env.storage().instance().get(&Key::TempCounters).unwrap_or(false);
    let exists = if temp { env.storage().temporary().has(&key) } else { env.storage().persistent().has(&key) };
    if exists {
        panic_with_error!(env, Error::AlreadySettled);
    }
    let until = fill.maker.expiry.max(fill.taker.expiry);
    let ttl = (until.saturating_sub(env.ledger().sequence()) + TTL_MARGIN).min(env.storage().max_ttl());
    if temp {
        env.storage().temporary().set(&key, &true);
        env.storage().temporary().extend_ttl(&key, ttl, ttl);
    } else {
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, ttl, ttl);
    }
}

fn settle_one(env: &Env, fill: &Fill, idempotent: bool) {
    if idempotent {
        mark_settled(env, fill);
    } else {
        advance_cursor(env, fill);
    }
    if fill.qty == 0 {
        panic_with_error!(env, Error::ZeroQuantity);
    }
    let (m, t) = (&fill.maker, &fill.taker);
    if m.pair != t.pair {
        panic_with_error!(env, Error::PairMismatch);
    }
    if m.side == t.side || m.side > 1 || t.side > 1 {
        panic_with_error!(env, Error::SameSide);
    }
    if m.account == t.account {
        panic_with_error!(env, Error::SelfTrade);
    }
    // The fill executes at the maker's price; it must be within the taker's limit too.
    let price = m.price;
    let (buyer, seller) = if t.side == 0 { (t, m) } else { (m, t) };
    if price > buyer.price || price < seller.price {
        panic_with_error!(env, Error::PriceOutsideLimit);
    }
    let mh = verify_order(env, m, &fill.maker_sig);
    let th = verify_order(env, t, &fill.taker_sig);
    add_filled(env, &mh, m, fill.qty);
    add_filled(env, &th, t, fill.qty);
    let notional = (price as i128) * (fill.qty as i128);
    move_balance(env, &buyer.account, 1, -notional);
    move_balance(env, &seller.account, 1, notional);
    move_balance(env, &seller.account, 0, -(fill.qty as i128));
    move_balance(env, &buyer.account, 0, fill.qty as i128);
    env.events().publish((symbol_short!("fill"), fill.seq, fill.idx), (price, fill.qty));
}

#[contract]
pub struct SettlementSpike;

#[contractimpl]
impl SettlementSpike {
    pub fn init(env: Env, operator: Address, temp_counters: bool) {
        if env.storage().instance().has(&Key::Operator) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&Key::Operator, &operator);
        env.storage().instance().set(&Key::TempCounters, &temp_counters);
        env.storage().instance().extend_ttl(env.storage().max_ttl(), env.storage().max_ttl());
    }

    /// Measurement only: a real design requires `account.require_auth()`.
    pub fn register_key(env: Env, account: Address, key: BytesN<32>) {
        env.storage().persistent().set(&Key::TradingKey(account), &key);
    }

    /// Measurement only: internal numbers, no tokens.
    pub fn seed_balance(env: Env, account: Address, asset: u32, amount: i128) {
        env.storage().persistent().set(&Key::Balance(account, asset), &amount);
    }

    /// Measurement only: registers keys and seeds both balances for many accounts in one transaction
    /// (a Stellar transaction carries one contract call, so per-account setup calls would dominate
    /// the spike's run time).
    pub fn setup(env: Env, accounts: Vec<Address>, keys: Vec<BytesN<32>>, base: i128, quote: i128) {
        for (account, key) in accounts.iter().zip(keys.iter()) {
            env.storage().persistent().set(&Key::TradingKey(account.clone()), &key);
            env.storage().persistent().set(&Key::Balance(account.clone(), 0), &base);
            env.storage().persistent().set(&Key::Balance(account, 1), &quote);
        }
    }

    /// Measurement only: models the epoch bump that an exit performs.
    pub fn bump_epoch(env: Env, account: Address) -> u32 {
        let key = Key::Epoch(account);
        let next: u32 = env.storage().persistent().get(&key).unwrap_or(0) + 1;
        env.storage().persistent().set(&key, &next);
        next
    }

    pub fn settle(env: Env, fill: Fill) {
        operator(&env).require_auth();
        settle_one(&env, &fill, false);
    }

    pub fn settle_batch(env: Env, fills: Vec<Fill>) {
        operator(&env).require_auth();
        for fill in fills.iter() {
            settle_one(&env, &fill, false);
        }
    }

    /// Alternative exactly-once rule: idempotent fill identifier instead of the cursor.
    pub fn settle_idem(env: Env, fill: Fill) {
        operator(&env).require_auth();
        settle_one(&env, &fill, true);
    }

    pub fn settle_batch_idem(env: Env, fills: Vec<Fill>) {
        operator(&env).require_auth();
        for fill in fills.iter() {
            settle_one(&env, &fill, true);
        }
    }

    pub fn is_settled(env: Env, seq: u64, idx: u32) -> bool {
        let key = Key::Settled(seq, idx);
        env.storage().temporary().has(&key) || env.storage().persistent().has(&key)
    }

    pub fn anchor(env: Env, head: BytesN<32>) {
        operator(&env).require_auth();
        let count: u64 = env.storage().instance().get(&Key::AnchorCount).unwrap_or(0) + 1;
        env.storage().instance().set(&Key::AnchorHead, &head);
        env.storage().instance().set(&Key::AnchorCount, &count);
        env.events().publish((symbol_short!("anchor"),), head);
    }

    pub fn cursor(env: Env) -> (u64, u32) {
        env.storage().instance().get(&Key::Cursor).unwrap_or((0, 0))
    }

    pub fn filled(env: Env, hash: BytesN<32>) -> u64 {
        let key = Key::Filled(hash);
        env.storage().temporary().get(&key).or_else(|| env.storage().persistent().get(&key)).unwrap_or(0)
    }

    pub fn balance(env: Env, account: Address, asset: u32) -> i128 {
        env.storage().persistent().get(&Key::Balance(account, asset)).unwrap_or(0)
    }

    pub fn order_hash(env: Env, order: Order) -> BytesN<32> {
        order_hash(&env, &order)
    }

    /// Signature-verification cost probe: verifies the same signature `n` times.
    pub fn verify_n(env: Env, key: BytesN<32>, msg: BytesN<32>, sig: BytesN<64>, n: u32) {
        let m = Bytes::from(msg);
        for _ in 0..n {
            env.crypto().ed25519_verify(&key, &m, &sig);
        }
    }

    /// TTL probe: kind 0 = temporary, 1 = persistent; extends the entry to `extend_to` ledgers.
    pub fn probe_put(env: Env, kind: u32, id: u32, extend_to: u32) -> u32 {
        let key = Key::Probe(id);
        if kind == 0 {
            env.storage().temporary().set(&key, &id);
            env.storage().temporary().extend_ttl(&key, extend_to, extend_to);
        } else {
            env.storage().persistent().set(&key, &id);
            env.storage().persistent().extend_ttl(&key, extend_to, extend_to);
        }
        env.storage().max_ttl()
    }

    pub fn max_ttl(env: Env) -> u32 {
        env.storage().max_ttl()
    }
}

#[cfg(test)]
mod test;
