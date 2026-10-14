/**
 * Upstream data-format constants.
 *
 * These strings are *wire values*, not branding: the mobile web client and the
 * public relay match them byte for byte, so renaming one silently breaks the
 * link. They are collected here — the single place in this repository that
 * spells them — so the rest of the code can use neutral names.
 *
 * @module dsh-remote/upstream-protocol
 */

/** Relay websocket the desktop stays connected to. */
export const RELAY_ENDPOINT = 'wss://zcode.z.ai/ws';

/** Mobile web client that the QR code points a phone at. */
export const WEB_CLIENT_ENDPOINT = 'https://zcode.z.ai/remote/v4';

/** RPC channels the web client addresses. */
export const CHANNEL_AGENT = 'zcode-agent';
export const CHANNEL_TASK = 'zcode-task';
export const CHANNEL_SESSION = 'zcode-session';

/** Frame discriminator field carried by every control frame. */
export const FRAME_TYPE_KEY = 'zcode_type';

/** Handshake name reported to the web client. */
export const PROTOCOL_NAME = 'ZCode Protocol';

/** Marker prefix for a nested binary payload inside the RPC codec. */
export const RPC_NESTED_BINARY_MARKER = '__zcode_rpc_nested_uint8array_v1';

/** Settings key that records which endpoint origin the app is pinned to. */
export const SETTINGS_ENDPOINT_ORIGIN_KEY = 'zcodeEndpointOrigin';
