/**
 * What the model may read of a buyer's text (iceberg B6, M-177). Phones, card-like numbers and e-mail addresses are replaced by a
 * placeholder BEFORE the text goes to any model (the platform's or a merchant's own endpoint), so a customer who pastes a card number
 * or an address book never leaks it to a third party. The stored message is untouched; only the copy sent to the model is masked.
 */
import { maskPhones } from '../observability';

const DIGIT = '[0-9\\u0660-\\u0669\\u06f0-\\u06f9]';
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// 13 to 19 digits with at most one space or dash between digits (a card number, written plain or in groups of four).
const CARD = new RegExp(`(?<!${DIGIT})${DIGIT}(?:[ -]?${DIGIT}){12,18}(?!${DIGIT})`, 'gu');

export function maskForModel(text: string): string {
  return maskPhones(text.replace(EMAIL, '[email]').replace(CARD, '[card]')) ?? '';
}
