# RFC-0001: Explicit session lifecycle for QRL Connect

Status: DRAFT (2026-07-10). Owner: connect SDK + wallet mirror + relay.

## Motivation

Same-device mobile flows work today (buffered offline requests, deep-link
wake, session revival), but the session lifecycle is INFERRED rather than
declared: each side guesses the other's state from relay rosters and a stack
of timers. That produced the July 2026 bug class (instant "disconnects",
mid-approval reaping, silent AEAD bricks) and each fix added another
heuristic. This RFC is the deliberate protocol rev that replaces the
heuristics with contracts.

Current timer/heuristic inventory (all still live):

| Mechanism | Where | Value |
|---|---|---|
| Reconnect wallet probe | SDK | 12s |
| dApp rejoin grace | wallet | 90s (re-armed while approval pending, cap 10 min) |
| Relay ping reap | relay | 25s interval + 20s timeout |
| Message buffer | relay | 50 msgs / 5 min |
| Request timeout | SDK | 5 min |
| Session TTL | both | 7 days |
| Desync teardown | both | 2 consecutive AEAD open failures |

## Proposal 1: declared session states (replaces roster-guessing)

Add a relay-acked `park` signal. A peer that knows it is going away (wallet
app backgrounding via APP_STATE, dApp tab pagehide) emits
`park_channel {channelId}` before its socket dies; the relay marks the
participant `parked` (vs `absent`) and includes that in rosters and
participants_changed events. Peers then render "wallet parked" honestly, the
SDK probe stops guessing (a parked peer is never "gone"), and reaping applies
only to `absent` (never said goodbye AND overstayed the grace). The relay
buffers for both parked and absent peers exactly as today, so this is
additive: old clients keep working (absence semantics unchanged).

## Proposal 2: first-class wake/resume contract

`qrlconnect://?wake=<cid>` is now recognized by the wallet (2026-07-10) but
only as a no-op foreground signal. Finish the contract:
- Wallet: after reconnectAll, if `<cid>` has a pending approval, focus it
  (DAPP_SHOW_WEBVIEW + promote that channel's approval to the front).
- App: add an expo-router route (or linking config) so future PATH-form URIs
  (`qrlconnect://resume/...`) stop resolving to +not-found. Until then the
  query-only form is mandatory (see CLAUDE.md).

## Proposal 3: universal links

Replace raw custom-scheme deep links with `https://qrlwallet.com/connect#...`
universal links (iOS Associated Domains + Android App Links):
- no "Open in MyQRLWallet?" interstitial, no silent failures, no
  route-to-not-found class of bugs;
- graceful fallback: without the app installed the SAME URL opens the web
  wallet's fragment-ingress pairing page (already exists at /dapp-sessions).
Requires: apple-app-site-association + assetlinks.json on qrlwallet.com,
app entitlement, SDK URI generation switch (keep qrlconnect:// as fallback
for the desktop wallet's protocol handler).

## Proposal 4: push wake

The browser-navigation wake only works while the user is ON the dApp page.
A backend push channel (APNs/FCM token registered per wallet install,
relay pings it when a message is buffered for a parked wallet) wakes the
wallet for approvals regardless of what the user is doing. Requires notify
consent UX and a backend token store; the relay already knows "buffered for
absent wallet" (ack `buffered: true`), which is exactly the trigger.

## Proposal 5: acked delivery (kills the desync class at the root)

The 2-failure teardown (SDK #34 / frontend #226) makes desync CLEAN, not
impossible. Root fix: per-message delivery acks at the protocol layer
(recipient confirms seq N; sender retains-and-retransmits past the relay
buffer TTL), or relay persistence keyed by AEAD seq. Evaluate after
Proposal 1: parked-state awareness already shrinks the window because a
sender can hold messages client-side while the peer is parked instead of
racing the relay TTL.

## Sequencing

1. Proposal 2 wallet half + Proposal 1 (relay + both mirrors, additive).
2. Proposal 3 (infra + app release).
3. Proposal 4 (backend + app release + consent UX).
4. Proposal 5 (protocol bump, evaluate need after 1).
