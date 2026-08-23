import assert from "node:assert/strict";
import {
  appendManagedQueue,
  insertManagedQueueItem,
  moveManagedQueueItem,
  removeManagedQueueItem,
} from "../src/lib/managedQueue";
import type { ManagedQueuedMessage } from "../src/types";

const item = (id: string): ManagedQueuedMessage => ({
  id,
  text: `message-${id}`,
  attachments: [],
  createdAt: 1,
});

let queue = appendManagedQueue([], item("a"));
queue = appendManagedQueue(queue, item("b"));
queue = appendManagedQueue(queue, item("c"));
assert.deepEqual(queue.map(({ id }) => id), ["a", "b", "c"]);

queue = moveManagedQueueItem(queue, "c", -1);
assert.deepEqual(queue.map(({ id }) => id), ["a", "c", "b"]);
assert.strictEqual(moveManagedQueueItem(queue, "a", -1), queue);

const removed = removeManagedQueueItem(queue, "c");
assert.equal(removed.item?.id, "c");
assert.equal(removed.index, 1);
assert.deepEqual(removed.queue.map(({ id }) => id), ["a", "b"]);

queue = insertManagedQueueItem(removed.queue, removed.item!, removed.index);
assert.deepEqual(queue.map(({ id }) => id), ["a", "c", "b"]);
assert.strictEqual(removeManagedQueueItem(queue, "missing").queue, queue);

console.log("managed follow-up queue tests passed");
