// Pure unit tests: no database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpUrl, intId } from '../src/util.js';

test('httpUrl strips advertising parameters but keeps the rest', () => {
  assert.equal(
    httpUrl('https://rozetka.com.ua/ua/x/p1/?gad_source=1&gad_campaignid=22&utm_source=a&color=red'),
    'https://rozetka.com.ua/ua/x/p1/?color=red',
  );
});

test('httpUrl rejects non-http links', () => {
  assert.equal(httpUrl('javascript:alert(1)'), null);
  assert.equal(httpUrl('ftp://example.com/file'), null);
  assert.equal(httpUrl('   '), null);
});

test('intId accepts positive integers and answers 404 for anything else', () => {
  assert.equal(intId('5'), 5);
  for (const bad of ['abc', '0', '-1', '1.5', '99999999999']) {
    assert.throws(() => intId(bad), (e) => e.status === 404);
  }
});
