// tests/lib/ws-helper.ts — a small promise-shaped WebSocket client for the
// wander-online server tests. Bun's WebSocket delivers whole messages; this
// just queues them so a test can await the next one with a timeout.
export interface TestSocket {
  readonly url: string;
  send(data: string | ArrayBuffer): void;
  close(): void;
  /** Resolve with the next message (string or ArrayBuffer), or undefined
   *  after `timeoutMs`. Rejects if the socket closes while waiting. */
  nextMessage(timeoutMs?: number): Promise<string | ArrayBuffer | undefined>;
}

export function connect(url: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const queue: (string | ArrayBuffer)[] = [];
    const waiters: ((m: string | ArrayBuffer | undefined) => void)[] = [];
    let closed = false;

    ws.addEventListener("open", () => {
      resolve({
        url,
        send: (data) => ws.send(data as string | ArrayBuffer),
        close: () => ws.close(),
        nextMessage(timeoutMs = 1000) {
          const m = queue.shift();
          if (m !== undefined) return Promise.resolve(m);
          if (closed) return Promise.resolve(undefined);
          return new Promise((res) => {
            const timer = setTimeout(() => {
              const i = waiters.indexOf(wake);
              if (i >= 0) waiters.splice(i, 1);
              res(undefined);
            }, timeoutMs);
            const wake = (msg: string | ArrayBuffer | undefined) => {
              clearTimeout(timer);
              res(msg);
            };
            waiters.push(wake);
          });
        },
      });
    });
    ws.addEventListener("error", () => {
      if (!waiters.length) reject(new Error(`connect failed: ${url}`));
    });
    ws.addEventListener("close", () => {
      closed = true;
      while (waiters.length) waiters.shift()!(undefined);
    });
    ws.addEventListener("message", (ev) => {
      const data = ev.data as string | ArrayBuffer;
      const w = waiters.shift();
      if (w) w(data);
      else queue.push(data);
    });
  });
}
