/** Ordered asynchronous byte delivery with observable framing/backpressure; no network shim in production. */
export class MockDataChannel extends EventTarget {
  label = "events-v1"; readyState = "open"; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
  bufferedAmount = 0; bufferedAmountLowThreshold = 0; maximumBuffered = 0; maximumFrame = 0; frames = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null; peer = null;
  send(bytes) {
    if (this.readyState !== "open") throw new Error("Mock channel closed");
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.frames++; this.maximumFrame = Math.max(this.maximumFrame, copy.byteLength);
    this.bufferedAmount += copy.byteLength; this.maximumBuffered = Math.max(this.maximumBuffered, this.bufferedAmount);
    queueMicrotask(() => {
      const before = this.bufferedAmount; this.bufferedAmount -= copy.byteLength;
      if (this.peer?.readyState === "open") this.peer.onmessage?.({ data: copy });
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event("bufferedamountlow"));
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed"; this.dispatchEvent(new Event("close")); this.onclose?.();
    this.peer?.close();
  }
}
export function mockChannelPair() { const a = new MockDataChannel(), b = new MockDataChannel(); a.peer = b; b.peer = a; return [a, b]; }
