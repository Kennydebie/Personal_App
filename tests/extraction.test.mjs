import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCalendarEvent, extractGmailThread } from '../src/lib/extraction.ts';

const me = 'kenny@example.com';

function message(overrides = {}) {
  return {
    id: 'm1',
    from: 'persoon@example.org',
    to: me,
    cc: '',
    subject: 'Documenten',
    date: '2026-09-20T10:00:00.000Z',
    body: 'Kun je het formulier voor 30 september 2026 ondertekenen?',
    bulk: false,
    attachmentNames: [],
    ...overrides,
  };
}

function thread(...messages) {
  return { id: 'thread-1', messages };
}

test('a direct concrete request is actionable with an evidenced date', () => {
  const result = extractGmailThread(thread(message()), me);
  assert.equal(result.candidate?.status, 'actie_nodig');
  assert.equal(result.candidate?.dueAt, '2026-09-30');
  assert.equal(result.candidate?.sourceRefs[0].kind, 'gmail');
});

test('a sent completion closes a previous request', () => {
  const result = extractGmailThread(thread(
    message(),
    message({ id: 'm2', from: me, to: 'persoon@example.org', date: '2026-09-21T10:00:00.000Z', body: 'Ik heb het formulier ondertekend en verstuurd.' }),
  ), me);
  assert.equal(result.resolved, true);
  assert.equal(result.candidate, null);
});

test('a sent answer alone does not prove that the case is finished', () => {
  const result = extractGmailThread(thread(
    message(),
    message({ id: 'm2', from: me, to: 'persoon@example.org', date: '2026-09-21T10:00:00.000Z', body: 'Bedankt, ik kijk ernaar.' }),
  ), me);
  assert.equal(result.candidate?.status, 'controleren');
});

test('sending something in the current message is not an unfinished promise', () => {
  const result = extractGmailThread(thread(message({
    from: me,
    to: 'persoon@example.org',
    body: 'Ik stuur hierbij het formulier.',
  })), me);
  assert.equal(result.candidate, null);
});

test('an invoice without payment confirmation needs verification', () => {
  const result = extractGmailThread(thread(message({ subject: 'Factuur', body: 'Hierbij de factuur met betaalgegevens.' })), me);
  assert.equal(result.candidate?.status, 'controleren');
  assert.match(result.candidate?.uncertainty ?? '', /betaalbevestiging/i);
});

test('a message only in cc and work content are excluded', () => {
  assert.equal(extractGmailThread(thread(message({ to: 'ander@example.org', cc: me })), me).candidate, null);
  assert.equal(extractGmailThread(thread(message({ subject: 'ASML werkzaamheden' })), me).candidate, null);
});

test('case keys match only for a distinctive subject and the same correspondent', () => {
  const specificSubject = 'Offerte project referentie 482719';
  const first = extractGmailThread({ id: 'thread-a', messages: [message({ subject: specificSubject })] }, me).candidate;
  const sameCase = extractGmailThread({ id: 'thread-b', messages: [message({ subject: specificSubject })] }, me).candidate;
  const otherPerson = extractGmailThread({ id: 'thread-c', messages: [message({ subject: specificSubject, from: 'ander@example.org' })] }, me).candidate;
  assert.ok(first?.caseKey);
  assert.equal(first.caseKey, sameCase?.caseKey);
  assert.notEqual(first.caseKey, otherPerson?.caseKey);
});

function event(overrides = {}) {
  return {
    id: 'event-1',
    calendarId: 'primary',
    title: 'Afspraak',
    description: '',
    start: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    end: null,
    updated: new Date().toISOString(),
    status: 'confirmed',
    eventType: 'default',
    selfResponse: 'accepted',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=test',
    organizerEmail: 'persoon@example.org',
    ...overrides,
  };
}

test('a calendar appointment is planned, explicit preparation needs action', () => {
  assert.equal(extractCalendarEvent(event(), me).candidate?.status, 'gepland');
  assert.equal(extractCalendarEvent(event({ description: 'Neem je identiteitsbewijs mee.' }), me).candidate?.status, 'actie_nodig');
});

test('a cancelled appointment is resolved', () => {
  const result = extractCalendarEvent(event({ status: 'cancelled' }), me);
  assert.equal(result.candidate, null);
  assert.equal(result.resolved, true);
});

test('work calendar details are excluded without permission', () => {
  const result = extractCalendarEvent(event({ title: 'ASML teamoverleg' }), me);
  assert.equal(result.candidate, null);
});
