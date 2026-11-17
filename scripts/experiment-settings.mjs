export function experimentSettings(env = process.env) {
  const arms = { A: { workers: 2, multiplier: 1 }, B: { workers: 1, multiplier: 1 },
    C: { workers: 2, multiplier: 2 }, D: { workers: 1, multiplier: 2 } };
  const arm = env.E2E_EXPERIMENT_ARM ?? null;
  if (arm !== null && !Object.hasOwn(arms, arm)) throw new Error('E2E_EXPERIMENT_ARM must be A, B, C or D.');
  const workers = Number(env.E2E_WORKERS ?? arms[arm]?.workers ?? 2);
  const multiplier = Number(env.E2E_TIMEOUT_MULTIPLIER ?? arms[arm]?.multiplier ?? 1);
  if (!Number.isInteger(workers) || workers < 1) throw new Error('Expected a positive worker count.');
  if (![1, 2].includes(multiplier)) throw new Error('Expected timeout multiplier 1 or 2.');
  if (arm && (workers !== arms[arm].workers || multiplier !== arms[arm].multiplier)) throw new Error('Worker/timeout settings disagree with the experiment arm.');
  return { arm, workers, timeoutMultiplier: multiplier };
}
