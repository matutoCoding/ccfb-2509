/** 确定性 PRNG（mulberry32），保证种子数据每次生成都完全一致 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function range(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function uid(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}
