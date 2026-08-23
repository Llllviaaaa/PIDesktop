import type { ManagedQueuedMessage } from "../types";

export function appendManagedQueue(
  queue: ManagedQueuedMessage[],
  item: ManagedQueuedMessage,
): ManagedQueuedMessage[] {
  return [...queue, item];
}

export function removeManagedQueueItem(
  queue: ManagedQueuedMessage[],
  id: string,
): { queue: ManagedQueuedMessage[]; item: ManagedQueuedMessage | null; index: number } {
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return { queue, item: null, index: -1 };
  return {
    queue: [...queue.slice(0, index), ...queue.slice(index + 1)],
    item: queue[index],
    index,
  };
}

export function insertManagedQueueItem(
  queue: ManagedQueuedMessage[],
  item: ManagedQueuedMessage,
  index: number,
): ManagedQueuedMessage[] {
  const target = Math.max(0, Math.min(index, queue.length));
  return [...queue.slice(0, target), item, ...queue.slice(target)];
}

export function moveManagedQueueItem(
  queue: ManagedQueuedMessage[],
  id: string,
  direction: -1 | 1,
): ManagedQueuedMessage[] {
  const index = queue.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= queue.length) return queue;
  const next = [...queue];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
