# @brianjenkins94/hub

A message bus per context (window, frame, worker), linked into a tree. Publish on a dotted subject, subscribe with
NATS patterns (`*` one token, `>` the rest); a message crosses a link only if something past it wants it.

## What it promises

Each is checked by a test: `model` is the randomized model test (`test/model.test.ts`, random trees against a
reference router a few lines long); the rest are named tests in `test/hub.test.ts`.

1. **Delivery.** A message published on hub H on subject S reaches every handler whose pattern matches S on every hub
   the tree connects to H through links that let S through — **exactly once each** — and no other handler. *(model)*
2. **Permissions** are enforced by the hub that owns the link end, so the peer can't opt out. A hop X → Y carries S only
   if X's end allows Y to receive it (`subscribe`) and Y's end allows X to send it (`publish`). A peer that sends what
   it may not anyway is dropped (a `deny` tap event). *(model; "publish permissions drop what a peer may not send")*
3. **Non-transit.** Nothing passes between two non-transit links of one hub — a hub above several trees reaches each,
   but never joins them. *(model; "non-transit links")*
4. **Interest.** `interested(S)` on H is true exactly when a message on S published there would reach some handler.
   *(model)* Interest is advertised narrowed to what each link may carry, so nobody past a confined link takes it for a
   listener. *("a confined link is told only of interest it could serve")*
5. **Locality.** A message crosses a link only when something past it wants it and may receive it. *("local traffic
   stays local")*
6. **Changes converge.** After a subscribe, unsubscribe, `permit()` or unlink, 1–4 hold again once the links have
   passed on the change. *(model)*
7. **Identity.** A hub that assigns its peer an id (`peer`) stamps `from` with it on everything the peer sends; only a
   hub's uplink can tell it who it is. *("an assigned peer id overrides…", "only a hub's uplink can name it")*
8. **Containment.** A throwing handler doesn't stop the others or the forwarding; a frame a transport can't send is
   dropped; a malformed frame from a peer is ignored. Each is a `fault` tap event. *("a throwing handler…", "a frame the
   transport can't send…", "subjects, patterns, ids and permissions are validated…")*
9. **Liveness.** A link whose transport closes (`Transport.onClose`) is unlinked; with `heartbeatMs`, so is one whose
   peer goes silent. A new hub on the same transport (a reloaded frame) replaces the old one's interest. *("a link whose
   transport closes…", "heartbeat…", "a peer that restarts…")*
10. **Bounds.** With `maxPayload`, an oversized message is dropped either way; with `maxBacklog`, messages are dropped
    while the transport is backed up — control frames still go. *("maxPayload…", "backpressure…")*

## What it assumes

- **A tree.** Hubs are wired without cycles. A message never goes back the way it came; that's all the loop prevention
  there is, so a cycle would carry a message round it forever.
- **Reliable, ordered transports** once both ends listen (a MessagePort, a WebSocket, an ordered RTCDataChannel). The one
  loss tolerated is at the start, before the other end listens: the `hello` handshake recovers it.
- **Interest before messages.** A message published before the far side's interest has arrived goes nowhere — `await
  link(…).ready` or `whenInterested` before a one-off message.

## What it doesn't do

No persistence or acknowledgement (a router, not a broker); no reconnect (the transport's owner relinks); no loop
detection; no queue groups (every subscriber gets every message); no deny lists (permissions are allow lists); no
headers (per-message metadata goes in `data`).
