const test = require('node:test');
const assert = require('node:assert/strict');
const { visitServicesLine } = require('../../lib/same-day-visit.js');

const NOON = '2026-11-09T19:00:00.000Z';
const TWO = '2026-11-09T21:00:00.000Z';

test('one service is just its name', () => {
  assert.equal(
    visitServicesLine([
      { displayName: 'Lash Extension Full Set', bookingTime: NOON },
    ]),
    'Lash Extension Full Set'
  );
});

test('services that start together are named once', () => {
  assert.equal(
    visitServicesLine([
      { displayName: 'Lash Extension Full Set', bookingTime: NOON },
      { displayName: 'Brow Shape', bookingTime: NOON },
      { displayName: 'Lip/Chin Wax Add On', bookingTime: NOON },
    ]),
    'Lash Extension Full Set, Brow Shape, and Lip/Chin Wax Add On'
  );
});

test('a later start says when that service begins', () => {
  assert.equal(
    visitServicesLine([
      { displayName: 'Lash Extension Full Set', bookingTime: NOON },
      { displayName: 'Brow Shape', bookingTime: TWO },
    ]),
    'Lash Extension Full Set, then Brow Shape at 2:00pm'
  );
});
