/** pass@k family over k repeated runs of one task. */
/** At least one of the runs passed (1 or 0). */
export const passAtK = (results: boolean[]): number => (results.some(Boolean) ? 1 : 0);
/** Every run passed: the reliability bar for safety classes (pass^k). An empty list is NOT a pass. */
export const passHatK = (results: boolean[]): boolean => results.length > 0 && results.every(Boolean);
/** Fraction of runs that passed (the quality number the gate compares across releases). */
export const passAt1 = (results: boolean[]): number => (results.length ? results.filter(Boolean).length / results.length : 0);
