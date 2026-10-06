import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUsPhoneAsYouType } from '../../lib/client-identity.ts';

test('formats a US number as it is typed', () => {
  assert.equal(formatUsPhoneAsYouType('808'), '(808)');
  assert.equal(formatUsPhoneAsYouType('8085'), '(808) 5');
  assert.equal(formatUsPhoneAsYouType('8085551234'), '(808) 555-1234');
});

test('backspace on the closing parenthesis deletes the third digit', () => {
  assert.equal(formatUsPhoneAsYouType('(808', '(808)'), '(80');
  assert.equal(formatUsPhoneAsYouType('(8', '(80'), '(8');
  assert.equal(formatUsPhoneAsYouType('(', '(8'), '');
});

test('backspace on a real digit does not drop an extra digit', () => {
  assert.equal(formatUsPhoneAsYouType('(808) ', '(808) 5'), '(808)');
  assert.equal(formatUsPhoneAsYouType('(808) 555-123', '(808) 555-1234'), '(808) 555-123');
});
