/**
 * What the model may read of a buyer's text (iceberg B6, M-177). The masker moved into the Smart Layer engine (plan 4 A3, identical behaviour,
 * shared vectors); this re-export keeps every Chat import working. The stored message is untouched; only the copy sent to the model is masked.
 */
export { maskForModel } from '../../../foundation/smart-layer/rails/mask';
