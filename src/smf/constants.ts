/**
 * SMF protocol constants. Byte layouts and values are documented in
 * docs/protocol-notes.md with citations into solclientjs-debug.js and the
 * Wireshark SMF dissector.
 */

export const SMF_VERSION = 3;
export const SMF_MIN_HEADER_LEN = 12;

export const SmfProtocol = {
  CSPF: 1,
  CSMP: 2,
  PUBMSG: 3,
  XMLLINK: 4,
  WSE: 5,
  SEMP: 6,
  SUBCTRL: 7,
  PUBCTRL: 8,
  ADCTRL: 9,
  KEEPALIVE: 10,
  KEEPALIVEV2: 11,
  CLIENTCTRL: 12,
  TRMSG: 13,
  JNDI: 14,
  SMP: 15,
  SMRP: 16,
  TSESSION: 20,
} as const;
export type SmfProtocolId = (typeof SmfProtocol)[keyof typeof SmfProtocol];

/** Standard (5-bit) SMF header parameter types. */
export const SmfParam = {
  PADDING: 0x00,
  PUBLISHER_ID: 0x01,
  PUBLISHER_MSGID: 0x02,
  MESSAGE_PRIORITY: 0x03,
  USERDATA: 0x04,
  MESSAGE_ID: 0x05,
  USERNAME: 0x06,
  PASSWORD: 0x07,
  RESPONSE: 0x08,
  ENTITLEMENT_LIST: 0x09,
  SUB_ID_LIST: 0x0a,
  GENERIC_ATTACHMENT: 0x0b,
  BINARY_ATTACHMENT: 0x0c,
  DELIVERY_MODE: 0x10,
  ASSURED_MESSAGE_ID: 0x11,
  ASSURED_PREVMESSAGE_ID: 0x12,
  ASSURED_REDELIVERED_FLAG: 0x13,
  MESSAGE_CONTENT_SUMMARY: 0x16,
  ASSURED_FLOWID: 0x17,
  TR_TOPICNAME: 0x18,
  AD_FLOWREDELIVERED_FLAG: 0x19,
  AD_TIMETOLIVE: 0x1c,
  SEQUENCE_NUMBER: 0x1e,
  EXTENDED_TYPE_STREAM: 0x1f,
} as const;

/** Lightweight (3-bit) SMF header parameter types. */
export const SmfLightParam = {
  CORRELATION: 0,
  TOPIC_NAME_OFFSET: 1,
  QUEUE_NAME_OFFSET: 2,
  ACK_IMMEDIATELY: 3,
  HEADER_EXTENSION: 4,
} as const;

export const ClientCtrlMsgType = {
  LOGIN: 0,
  UPDATE: 1,
} as const;

export const ClientCtrlVersion = 1;

export const ClientCtrlParam = {
  SOFTWAREVERSION: 0x00,
  SOFTWAREDATE: 0x01,
  PLATFORM: 0x02,
  USERID: 0x03,
  CLIENTDESC: 0x04,
  CLIENTNAME: 0x05,
  MSGVPNNAME: 0x06,
  DELIVERTOONEPRIORITY: 0x07,
  P2PTOPIC: 0x08,
  ROUTER_CAPABILITIES: 0x09,
  VRIDNAME: 0x0a,
  PHYSICALROUTERNAME: 0x0c,
  NO_LOCAL: 0x0f,
  AUTHENTICATION_SCHEME: 0x11,
  CONNECTION_TYPE: 0x12,
  ROUTER_CAPABILITIES_EXTENDED: 0x13,
  CLIENT_CAPABILITIES: 0x17,
  KEEP_ALIVE_INTERVAL: 0x18,
} as const;

export const SmpMsgType = {
  ADDSUBSCRIPTION: 0,
  REMSUBSCRIPTION: 1,
  ADDQUEUESUBSCRIPTION: 2,
  REMQUEUESUBSCRIPTION: 3,
} as const;
export type SmpMsgTypeId = (typeof SmpMsgType)[keyof typeof SmpMsgType];

export const SmpFlags = {
  FILTER: 0x01,
  PERSIST: 0x02,
  TOPIC: 0x04,
  RESPREQUIRED: 0x08,
  DELIVERALWAYS: 0x10,
} as const;

/**
 * Boolean router-capability bit indices (MSB-first bitmap after a count byte),
 * in the exact order solclientjs parses them (BOOLEAN_CAPS_BITS).
 */
export const RouterCapBit = {
  JNDI: 0,
  COMPRESSION: 1,
  GUARANTEED_MESSAGE_CONSUME: 2,
  TEMPORARY_ENDPOINT: 3,
  GUARANTEED_MESSAGE_PUBLISH: 4,
  GUARANTEED_MESSAGE_BROWSE: 5,
  ENDPOINT_MGMT: 6,
  SELECTOR: 7,
  ENDPOINT_MESSAGE_TTL: 8,
  QUEUE_SUBSCRIPTIONS: 9,
  SUBSCRIPTION_MANAGER: 11,
  MESSAGE_ELIDING: 12,
  TRANSACTED_SESSION: 13,
  NO_LOCAL: 14,
  ACTIVE_CONSUMER_INDICATION: 15,
  PER_TOPIC_SEQUENCE_NUMBERING: 16,
  ENDPOINT_DISCARD_BEHAVIOR: 17,
  CUT_THROUGH: 18,
  MESSAGE_REPLAY: 20,
  COMPRESSED_SSL: 21,
  SHARED_SUBSCRIPTIONS: 23,
  BR_REPLAY_ERRORID: 24,
  AD_APP_ACK_FAILED: 25,
  VAR_LEN_EXT_PARAM: 26,
} as const;
export const ROUTER_CAP_BIT_COUNT = 27;

export const WS_SUBPROTOCOL = 'smf.solacesystems.com';

/** AdProtocol (AssuredCtrl, proto 9) message types — debug.js:18622–18634. */
export const AdMsgType = {
  OPENPUBFLOW: 0,
  CLIENTACK: 3,
  BIND: 4,
  UNBIND: 5,
  UNSUBSCRIBE: 6,
  CLOSEPUBFLOW: 7,
  CREATE: 8,
  DELETE: 9,
  FLOWCHANGEUPDATE: 12,
  CLIENTNACK: 15,
} as const;

/** AdProtocol parameter ids — debug.js:18642–18669. */
export const AdParam = {
  LASTMSGIDACKED: 2,
  WINDOW: 3,
  APPLICATION_ACK: 5,
  FLOWID: 6,
  QUEUENAME: 7,
  DTENAME: 8,
  TOPICNAME: 9,
  EP_DURABLE: 11,
  ACCESSTYPE: 12,
  TRANSPORT_WINDOW: 14,
  LASTMSGIDRECEIVED: 16,
  FLOWTYPE: 18,
  ACTIVE_FLOW_INDICATION: 32,
  WANT_FLOW_CHANGE_NOTIFY: 33,
  MAX_DELIVERED_UNACKED_MESSAGES_PER_FLOW: 49,
} as const;

/** Wire values for the DELIVERY_MODE SMF param — debug.js:16804–16808. */
export const WireDeliveryMode = {
  NON_PERSISTENT: 0,
  PERSISTENT: 1,
  DIRECT: 2,
} as const;
