/**
 * Runs tasks strictly one at a time, in the order they arrive.
 *
 * The MCP2221 has a single command pipeline and a single I2C engine: you send a
 * 64-byte report and read the one reply it produces. Two Python calls in flight
 * at once each suspend on their own JSPI stack, and while one is suspended the
 * worker's message loop is free to start the other -- so their command/response
 * pairs interleave on that one pipeline and each reads the other's reply. The
 * symptom is nonsense status bytes and Blinka raising "Unrecoverable I2C state
 * failure" on the first address of a scan.
 *
 * That is not a race worth trying to make safe at the transport layer, because
 * a transfer is not the unit of atomicity -- a whole driver operation is. So
 * calls queue here instead. A slow scan does delay a status poll, which is the
 * correct trade: the bus is a single shared resource and pretending otherwise
 * is what corrupts it.
 */
export class Serializer {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** Queued tasks not yet finished, including the running one. */
  get pending(): number {
    return this.#depth;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#depth++;
    // Chain onto the tail regardless of how the previous task settled, so one
    // failure does not wedge the queue.
    const result = this.#tail.then(task, task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#depth--;
    });
  }
}
