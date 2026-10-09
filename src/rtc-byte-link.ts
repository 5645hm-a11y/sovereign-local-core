import type { ByteLink } from "./sync-session.js";

/** Keep SSP1 DataChannel messages wire-compatible; streams carry a length prefix. */
export function rtcByteLink(channel: RTCDataChannel, connection: RTCPeerConnection | null = null): ByteLink {
  if (!channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) throw new Error("Reliable ordered delivery is required");
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 64 * 1024;
  let ended = false, controller: ReadableStreamDefaultController<Uint8Array>;
  const drains = new Set<() => void>();
  const finish = (error?: Error) => {
    if (ended) return; ended = true;
    error ? controller.error(error) : controller.close();
    for (const wake of drains) wake(); drains.clear();
  };
  const readable = new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel() { close(); },
  }, { highWaterMark: 4 * 1024 * 1024, size: bytes => bytes.length });
  const onMessage = (event: MessageEvent) => {
    if (ended) return;
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 16 * 1024 || event.data.byteLength < 17 || (controller.desiredSize ?? 0) < event.data.byteLength + 4) {
      finish(new Error("Invalid frame or bounded RTC receive queue exceeded")); close(); return;
    }
    const bytes = new Uint8Array(4 + event.data.byteLength);
    new DataView(bytes.buffer).setUint32(0, event.data.byteLength, true); bytes.set(new Uint8Array(event.data), 4);
    controller.enqueue(bytes);
  };
  const onClose = () => finish(new Error("Data channel closed"));
  const onError = () => finish(new Error("Data channel error"));
  // Property handlers also support the existing deterministic channel mocks.
  channel.onmessage = onMessage; channel.onclose = onClose; channel.onerror = onError;
  function close() {
    finish(); channel.onmessage = null; channel.onclose = null; channel.onerror = null; channel.onopen = null;
    channel.close();
  }
  const writable = new WritableStream<Uint8Array>({
    async write(bytes) {
      if (bytes.length < 21 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== bytes.length - 4) throw new Error("Invalid stream frame");
      if (channel.bufferedAmount > 256 * 1024) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); drains.delete(check); channel.removeEventListener("bufferedamountlow", check); channel.removeEventListener("close", check); };
        const check = () => { if (ended || channel.readyState !== "open") { cleanup(); reject(new Error("Channel closed during backpressure")); }
          else if (channel.bufferedAmount <= 64 * 1024) { cleanup(); resolve(); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error("Data channel stalled")); }, 15000);
        drains.add(check); channel.addEventListener("bufferedamountlow", check); channel.addEventListener("close", check); check();
      });
      if (ended || channel.readyState !== "open") throw new Error("Data channel is not open");
      const payload = bytes.subarray(4);
      channel.send(payload.buffer instanceof ArrayBuffer ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) : payload.slice());
    }, close, abort: close,
  });
  return { readable, writable, get maxFrameBytes() { return Math.min(16 * 1024, connection?.sctp?.maxMessageSize || 16 * 1024); }, close };
}
