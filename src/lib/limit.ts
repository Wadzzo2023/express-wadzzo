
export function pLimit(concurrency: number) {
  const queue: (() => void)[] = [];
  let active = 0;
  const next = () => {
    active--;
    if (queue.length > 0) queue.shift()!();
  };
  const run = async <T>(fn: () => Promise<T> | T, resolve: (v: T) => void, reject: (e: any) => void) => {
    active++;
    try { resolve(await fn()); } catch (err) { reject(err); } finally { next(); }
  };
  return <T>(fn: () => Promise<T> | T): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      if (active < concurrency) void run(fn, resolve, reject);
      else queue.push(() => void run(fn, resolve, reject));
    });
  };
}
export default pLimit;
