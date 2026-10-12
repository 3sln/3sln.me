const encoder = new TextEncoder();

export const ANSWER_NORMALIZATION = '3sln-answers-v1';
export const QUESTION_TYPES = Object.freeze(['text', 'date', 'ssn', 'national-id', 'phone', 'pin', 'passphrase']);
export const MAX_TEXT_BYTES = 1024;
export const MAX_QUESTIONS = 12;
export const MAX_METADATA_BYTES = 240;
const whitespace = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000]/g;
const whitespaceRuns = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000]+/g;
function trimWhitespace(value) { return value.replace(whitespaceRuns, ' ').replace(/^ +| +$/g, ''); }
function trimOuterWhitespace(value) {
  return value.replace(/^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000]+|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000]+$/g, '');
}

function invalid(message) { throw new TypeError(message); }

// Check before normalization, which could otherwise erase invisible characters.
export function validateText(value, label, { empty = false, maxBytes = MAX_TEXT_BYTES, formattingWhitespace = false } = {}) {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  if (value.length > maxBytes) invalid(`${label} is too long.`);
  if (encoder.encode(value).length > maxBytes) invalid(`${label} is too long.`);
  const checked = formattingWhitespace ? value.replace(whitespace, '') : value;
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(checked)) invalid(`${label} contains unsupported characters.`);
  if (!empty && !trimOuterWhitespace(value)) invalid(`${label} cannot be empty.`);
  return value;
}

export function normalizeAnswer(type, answer) {
  if (!QUESTION_TYPES.includes(type)) invalid('Unsupported recovery question type.');
  validateText(answer, 'Recovery answer', { formattingWhitespace: type !== 'passphrase', empty: type === 'passphrase' });
  if (!answer.length) invalid('Recovery answer cannot be empty.');
  let normalized;
  switch (type) {
    case 'text':
      normalized = trimWhitespace(answer.normalize('NFKC')).toLowerCase().normalize('NFC');
      break;
    case 'passphrase':
      normalized = answer.normalize('NFC');
      break;
    case 'date': {
      normalized = trimOuterWhitespace(answer.normalize('NFKC'));
      const match = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(normalized);
      if (!match) invalid('Use a date in YYYY-MM-DD format.');
      const [, yearText, , monthText, dayText] = match;
      const year = Number(yearText), month = Number(monthText), day = Number(dayText);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid('Use a valid calendar date.');
      normalized = `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}`;
      break;
    }
    case 'ssn':
      normalized = answer.normalize('NFKC').replace(whitespace, '').replaceAll('-', '');
      if (!/^\d{9}$/.test(normalized)) invalid('Use a nine-digit SSN.');
      break;
    case 'national-id':
      normalized = answer.normalize('NFKC').replace(whitespace, '').replaceAll('-', '');
      if (!/^[A-Za-z0-9]{3,40}$/.test(normalized)) invalid('Use 3–40 letters and digits for a national ID.');
      normalized = normalized.toUpperCase();
      break;
    case 'phone':
      normalized = answer.normalize('NFKC').replace(whitespace, '').replace(/[().-]/g, '');
      if (!/^\+[1-9]\d{7,14}$/.test(normalized)) invalid('Use an international phone number beginning with + and its country code.');
      break;
    case 'pin':
      normalized = trimOuterWhitespace(answer.normalize('NFKC'));
      if (!/^\d{4,32}$/.test(normalized)) invalid('Use 4–32 digits for a PIN.');
      break;
  }
  validateText(normalized, 'Normalized recovery answer', { empty: type === 'passphrase' });
  return normalized;
}

export function assertFields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be a plain object.`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some(key => typeof key !== 'string' || !expected.includes(key))) invalid(`Unsupported ${label} fields.`);
  if (actual.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid(`${label} must contain plain JSON values.`);
}

export function validateArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(`${label} must be an array.`);
  const fields = Reflect.ownKeys(value);
  if (fields.length !== value.length + 1 || fields.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) invalid(`${label} must be a plain, dense array.`);
  if (fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid(`${label} must contain plain JSON values.`);
}

export function validateQuestions(questions) {
  validateArray(questions, 'Recovery questions');
  if (questions.length < 1 || questions.length > MAX_QUESTIONS) invalid('Choose between one and twelve recovery questions.');
  const ids = new Set();
  return questions.map(question => {
    const fields = Object.hasOwn(question ?? {}, 'hint') ? ['id', 'type', 'prompt', 'hint'] : ['id', 'type', 'prompt'];
    assertFields(question, fields, 'recovery question');
    if (typeof question.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(question.id) || ids.has(question.id)) invalid('Recovery question IDs must be unique letters, digits, dashes or underscores.');
    ids.add(question.id);
    if (!QUESTION_TYPES.includes(question.type)) invalid('Unsupported recovery question type.');
    validateText(question.prompt, 'Recovery question prompt', { maxBytes: MAX_METADATA_BYTES });
    const hint = Object.hasOwn(question, 'hint') ? question.hint : '';
    validateText(hint, 'Recovery question hint', { empty: true, maxBytes: MAX_METADATA_BYTES });
    return { id: question.id, type: question.type, prompt: question.prompt, hint };
  });
}
