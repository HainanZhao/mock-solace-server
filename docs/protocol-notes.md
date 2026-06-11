# SMF Protocol Notes (ground truth for this mock broker)

Sources (verified 2026-06-11):
- `node_modules/solclientjs/lib/solclientjs-debug.js` (v10.18.3, unminified) — cited below as `debug.js:<line>`
- Wireshark SMF dissector: github.com/SolaceLabs/wireshark-smf-plugin (`packet-smf.c`, `packet-clientctrl.c`, `packet-smp.c`)

These notes record byte-exact layouts. Multi-byte integers are big-endian. "latin1 string"
means raw bytes interpreted byte-per-char (the SDK's internal string-as-bytes encoding).

## 1. SMF fixed header (12 bytes) — debug.js:16634–16656 (encode), 17129–17144 (parse)

Word 1 (u32 at offset 0), bit positions:

| bits  | field |
|-------|-------|
| 31    | DI (discard indication) |
| 30    | eliding eligible |
| 29    | DTO (deliver-to-one) |
| 28    | ADF (assured delivery flag) |
| 27    | DMQE (dead msg queue eligible) |
| 26–24 | version — MUST be 3 (`isSMFHeaderValid`, debug.js:17031: `byte0 & 7 !== 3` → reject) |
| 23–22 | UH (unhandled-message handling) |
| 21–16 | protocol id |
| 15–12 | priority |
| 11–8  | (unused by JS SDK; dissector: retain/ACF/SNI) |
| 7–0   | TTL |

- u32 at offset 4: **header length** (12 + params bytes; payload starts here)
- u32 at offset 8: **total message length**
- payload length = total − headerLen (negative → "lost framing", connection-fatal)

## 2. Protocol IDs — debug.js:18793–18814

`CSPF=1, CSMP=2, PUBMSG=3, XMLLINK=4, WSE=5, SEMP=6, SUBCTRL=7, PUBCTRL=8, ADCTRL=9,
KEEPALIVE=10, KEEPALIVEV2=11, CLIENTCTRL=12, TRMSG=13, JNDI=14, SMP=15, SMRP=16,
SMF_IN_SMF=17, SMF_IN_RV=18, ADCTRL_PASSTHROUGH=19, TSESSION=20`

Client receive dispatch (debug.js:16309–16349) handles TSESSION/TRMSG/ADCTRL/CLIENTCTRL/SMP/
KEEPALIVE/KEEPALIVEV2; unknown id → error log + discard (not fatal).

## 3. SMF header parameters (TLV, bytes 12..headerLen) — debug.js:17155–17330 (parse), 16818–16838 (encode)

First byte per param: bits 7–6 = UH, bit 5 = lightweight flag.

**Lightweight** (bit 5 set): type = bits 4–2, value length = bits 1–0 (bytes follow).
Types: `0` correlation tag (u24 value), `1` topic-name offset, `2` queue-name offset,
`3` ack-immediately, `4` header extension.

**Standard** (bit 5 clear): type = bits 4–0. **Type 0 = padding and terminates the param
loop** (debug.js:17206). Next byte = total length including the 2 header bytes; if that byte
is 0 → extended form: next u32 = total length including 6 header bytes.

Standard types used here (debug.js:18747–18777):
- `0x03` MESSAGEPRIORITY (u8)
- `0x04` USERDATA (raw)
- `0x06` USERNAME — value is **base64(username)**
- `0x07` PASSWORD — value is **base64(password)**
- `0x08` RESPONSE — value = u32 code + raw string (no null terminator); 200 = success
- `0x0c` BINARY_ATTACHMENT — *deprecated; receiver skips it* (payload rides after header instead)
- `0x10` DELIVERY_MODE — only parsed when ADF flag set
- `0x16` MESSAGE_CONTENT_SUMMARY (see §7)
- `0x18` TR_TOPICNAME — raw UTF-8 topic bytes, NOT null-terminated (SDK encodes with UH=2)
- `0x1f` EXTENDED_TYPE_STREAM (OAuth tokens, trace context — can ignore/skip)

## 4. KeepAlive — debug.js:18409–18415, 12775–12805, 20161

- SDK sends **KEEPALIVEV2 (11)** with UH=2, TTL=2, no params/payload.
  Exact frame: `03 8b 00 02 | 00 00 00 0c | 00 00 00 0c`
- Default interval 3000 ms (`keepAliveIntervalInMsecs`, debug.js:14016), limit 3 missed
  (`keepAliveIntervalsLimit`, debug.js:14022).
- **Any received bytes reset the client's KA counter** (debug.js:20161) — but the server must
  send *something* within 3×interval. We echo a KA per client KA.
- Server-side: client sends KA every 3 s; treat as liveness, no reply semantics required
  beyond sending our own KA.

## 5. ClientCtrl (proto 12) — debug.js:15933–15998 (codec), 18171–18408 (message)

Body (after the 12-byte SMF header):
- u16: bits 10–8 = ClientCtrl version, MUST be 1 (parse rejects otherwise); bits 7–0 = msgType
  (`0` LOGIN, `1` UPDATE)
- u32: body length **including these 6 bytes**
- params: each = 1 byte (bit 7 UH, bits 6–0 type) + u32 total length **including the 5 header
  bytes** + value

Param ids (debug.js:18711–18735): `0x00` SOFTWAREVERSION, `0x01` SOFTWAREDATE, `0x02` PLATFORM,
`0x03` USERID, `0x04` CLIENTDESC, `0x05` CLIENTNAME, `0x06` MSGVPNNAME, `0x07` DELIVERTOONEPRIORITY,
`0x08` P2PTOPIC, `0x09` ROUTER_CAPABILITIES, `0x0a` VRIDNAME, `0x0c` PHYSICALROUTERNAME,
`0x0f` NO_LOCAL, `0x11` AUTHENTICATION_SCHEME, `0x12` CONNECTION_TYPE,
`0x13` ROUTER_CAPABILITIES_EXTENDED, `0x17` CLIENT_CAPABILITIES, `0x18` KEEP_ALIVE_INTERVAL.
String values are null-terminated (`stripNullTerminate` on read).

### Login request (client → broker) — debug.js:18295–18372
Always: CLIENTNAME, PLATFORM, SOFTWAREDATE, SOFTWAREVERSION, CLIENT_CAPABILITIES (2 bytes:
highest-cap-id, cap-bits), KEEP_ALIVE_INTERVAL (u32 **seconds**). Optional: MSGVPNNAME (UH=1),
CLIENTDESC, USERID, NO_LOCAL, AUTHENTICATION_SCHEME, SSL_DOWNGRADE.
Username/password arrive as **SMF-level** params 0x06/0x07 (base64). Correlation tag arrives as
lightweight SMF param.

### Login response (broker → client) — requirements for UP_NOTICE (debug.js:11650–11671, 12526–12528, 13275–13286)
- **LOGIN responses are matched by msgType, not correlation tag** (fake tag,
  debug.js:12526–12528) — echoing pm_corrtag is unnecessary for LOGIN but REQUIRED for UPDATE
  responses.
- SMF-level RESPONSE param (0x08) with code **200** → success; anything else → login failure.
- `updateReadonlySessionProps` reads ClientCtrl params: P2PTOPIC (0x08), MSGVPNNAME (0x06),
  VRIDNAME (0x0a), ROUTER_CAPABILITIES (0x09). Missing params default to ""/empty — no crash.
- P2P topic shape: broker sends e.g. `#P2P/v:<router>/<vrid>/<clientpart>`; SDK uses
  `base + "/_"` as inbox topic and subscribes `base + "/>"` (debug.js:11023–11029).
- **No second exchange needed**: after login 200, FSM goes ReapplyingSubscriptions →
  SessionTransportUp → FullyConnected → UP_NOTICE.

### Router capabilities encoding (param 0x09) — debug.js:18168, 18246–18293
Value = 1 byte **count of boolean capability bits**, then ceil(count/8) bitmap bytes (MSB
first), then extended entries (1 byte type + u32 total length incl 5 + value):
type 0 PEER_PORT_SPEED (u32), 1 PEER_PORT_TYPE (u8), 2 MAX_GUARANTEED_MSG_SIZE (u32),
3 MAX_DIRECT_MSG_SIZE (u32).

Boolean bit order (index → capability): 0 JNDI, 1 COMPRESSION, 2 GUARANTEED_MESSAGE_CONSUME,
3 TEMPORARY_ENDPOINT, 4 GUARANTEED_MESSAGE_PUBLISH, 5 GUARANTEED_MESSAGE_BROWSE,
6 ENDPOINT_MGMT, 7 SELECTOR, 8 ENDPOINT_MESSAGE_TTL, 9 QUEUE_SUBSCRIPTIONS, 10 (skip),
11 SUBSCRIPTION_MANAGER, 12 MESSAGE_ELIDING, 13 TRANSACTED_SESSION, 14 NO_LOCAL,
15 ACTIVE_CONSUMER_INDICATION, 16 PER_TOPIC_SEQUENCE_NUMBERING, 17 ENDPOINT_DISCARD_BEHAVIOR,
18 CUT_THROUGH, 19 (skip), 20 MESSAGE_REPLAY, 21 COMPRESSED_SSL, 22 (skip),
23 SHARED_SUBSCRIPTIONS, 24 BR_REPLAY_ERRORID, 25 AD_APP_ACK_FAILED, 26 VAR_LEN_EXT_PARAM.
**Phase 1: bits 2/4/5 (guaranteed messaging) stay 0** so the SDK never opens AD flows.

## 6. SMP (proto 15) — debug.js:17389–17442, 18821–18841

Body: 1 byte (bit 7 UH, bits 6–0 msgType) + u32 body length (incl 6 header bytes) +
1 byte flags + subscription.
- msgTypes: `0` ADDSUBSCRIPTION, `1` REMSUBSCRIPTION, `2` ADDQUEUESUBSCRIPTION,
  `3` REMQUEUESUBSCRIPTION
- flags: `0x10` DELIVERALWAYS, `0x08` RESPREQUIRED, `0x04` TOPIC, `0x02` PERSIST, `0x01` FILTER
- add/rem subscription: topic = raw bytes from offset 6 to body end (no terminator/prefix)
- queue variants: u8 queue-name length + name, then u8 subscription length + subscription
- The SMF wrapper carries a lightweight correlation tag (u24).

**Subscription confirmation** (debug.js:15280–15290): broker replies with an SMP frame whose
SMF header has the **echoed correlation tag** + RESPONSE param (200 "OK"). SDK matches on
corrtag only; 200 → SUBSCRIPTION_OK, else SUBSCRIPTION_ERROR. Echoing the SMP body back is
safe and matches broker behavior.

## 7. TrMsg / direct messages (proto 13) — debug.js:16550–16738, 16196–16198

Publish from SDK: SMF header proto 13 TTL 255, ADF=0 for direct, params:
TR_TOPICNAME (0x18, UH=2, raw UTF-8), optional MESSAGE_CONTENT_SUMMARY (0x16, UH=2),
optional userdata/priority/corrtag. Payload (binary attachment / XML meta / SDT containers)
follows the header.

Content summary (debug.js:16924–16946): sequence of elements, each: 1 byte (type<<4 |
length-mode) + length field. Types: 0 XML_META, 1 XML_PAYLOAD, 2 BINARY_ATTACHMENT,
4 BINARY_METADATA. Length-modes: 2=u8, 3=u16, 4=u24, 5=u32. **If the payload is a single
binary attachment, the SDK omits the content-summary param entirely** (debug.js:16622) — a
bare payload is implicitly one binary attachment.

Delivery to SDK: it only needs TR_TOPICNAME to set `getDestination()` (debug.js:16196–16198).
**Forwarding the publisher's frame bytes unchanged to subscribers is valid** — that is what
this mock does for direct messages.

## 8. WebSocket transport — debug.js:23822–23901, 20153–20204

- Subprotocol: **`smf.solacesystems.com`** (debug.js:23854) — the server must accept/echo it.
- `binaryType = "arraybuffer"`; URL used verbatim (no extra path/query). Client must specify
  the port explicitly (`ws://host:8008`); the SDK does NOT default 8008.
- **No preamble**: first frame after WS open is the ClientCtrl LOGIN. TSESSION (proto 20) is
  HTTP/COMET-only — over WS, receiving TSESSION is an error (debug.js:12741).
- Receive side tolerates SMF messages split across WS frames and multiple SMF messages per
  frame (accumulating buffer loop, debug.js:20163–20188). Sender may split a large SMF message
  across WS frames (debug.js:23890–23894). → server must run a byte-stream framer, and may
  batch or split its own writes freely.
- Disconnect: client just closes the WebSocket (debug.js:23925–23951); no ClientCtrl logout.

## 9. Topic wildcard semantics (docs.solace.com, Wildcard-Charaters-Topic-Subs)

- `/` separates levels. Wildcards are only meaningful in subscriptions.
- `*` alone = exactly one whole level. `abc*` = one level starting with `abc`
  (`*` only acts as a wildcard when it is the LAST char of a level).
- `>` as the entire final level = one or more remaining levels; does not match the parent.
- Published topics containing `*`/`>` are treated as literals by real brokers only in
  specific cases; this mock treats published topics as literals always.
