import { expect } from '@playwright/test';

import { sentryTest } from '../../../../utils/fixtures';
import { envelopeRequestParser, waitForErrorRequest } from '../../../../utils/helpers';
import {
  expectedClickBreadcrumb,
  expectedConsoleBreadcrumb,
  getExpectedReplayEvent,
} from '../../../../utils/replayEventTemplates';
import {
  getReplayEvent,
  getReplayRecordingContent,
  isReplayEvent,
  shouldSkipReplayTest,
  waitForReplayRequest,
} from '../../../../utils/replayHelpers';

sentryTest(
  '[error-mode] should start recording and switch to session mode once an error is thrown',
  async ({ getLocalTestPath, page }) => {
    if (shouldSkipReplayTest()) {
      sentryTest.skip();
    }

    let callsToSentry = 0;
    let errorEventId: string | undefined;
    const reqPromise0 = waitForReplayRequest(page, 0);
    const reqPromise1 = waitForReplayRequest(page, 1);
    const reqPromise2 = waitForReplayRequest(page, 2);
    const reqErrorPromise = waitForErrorRequest(page);

    await page.route('https://dsn.ingest.sentry.io/**/*', route => {
      const event = envelopeRequestParser(route.request());
      // error events have no type field
      if (event && !event.type && event.event_id) {
        errorEventId = event.event_id;
      }
      // We only want to count errors & replays here
      if (event && (!event.type || isReplayEvent(event))) {
        callsToSentry++;
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-id' }),
      });
    });

    const url = await getLocalTestPath({ testDir: __dirname });

    await page.goto(url);
    await page.click('#go-background');
    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(callsToSentry).toEqual(0);

    await page.click('#error');
    const req0 = await reqPromise0;

    await page.click('#go-background');
    const req1 = await reqPromise1;
    await reqErrorPromise;

    expect(callsToSentry).toEqual(3); // 1 error, 2 replay events

    await page.click('#log');
    await page.click('#go-background');
    const req2 = await reqPromise2;

    const event0 = getReplayEvent(req0);
    const content0 = getReplayRecordingContent(req0);

    const event1 = getReplayEvent(req1);
    const content1 = getReplayRecordingContent(req1);

    const event2 = getReplayEvent(req2);
    const content2 = getReplayRecordingContent(req2);

    expect(callsToSentry).toBe(4); // 1 error, 3 replay events

    expect(event0).toEqual(
      getExpectedReplayEvent({
        contexts: { replay: { error_sample_rate: 1, session_sample_rate: 0 } },
        error_ids: [errorEventId!],
        replay_type: 'error',
      }),
    );

    // The first event should have both, full and incremental snapshots,
    // as we recorded and kept all events in the buffer
    expect(content0.fullSnapshots).toHaveLength(1);
    // We don't know how many incremental snapshots we'll have (also browser-dependent),
    // but we know that we have at least 5
    expect(content0.incrementalSnapshots.length).toBeGreaterThan(5);
    // We want to make sure that the event that triggered the error was recorded.
    expect(content0.breadcrumbs).toEqual(
      expect.arrayContaining([
        {
          ...expectedClickBreadcrumb,
          message: 'body > button#error',
        },
      ]),
    );

    expect(event1).toEqual(
      getExpectedReplayEvent({
        contexts: { replay: { error_sample_rate: 1, session_sample_rate: 0 } },
        replay_type: 'error', // although we're in session mode, we still send 'error' as replay_type
        replay_start_timestamp: undefined,
        segment_id: 1,
        urls: [],
      }),
    );

    // Also the second snapshot should have a full snapshot, as we switched from error to session
    // mode which triggers another checkout
    expect(content1.fullSnapshots).toHaveLength(1);

    // The next event should just be a normal replay event as we're now in session mode and
    // we continue recording everything
    expect(event2).toEqual(
      getExpectedReplayEvent({
        contexts: { replay: { error_sample_rate: 1, session_sample_rate: 0 } },
        replay_type: 'error',
        replay_start_timestamp: undefined,
        segment_id: 2,
        urls: [],
      }),
    );

    expect(content2.breadcrumbs).toEqual(
      expect.arrayContaining([
        { ...expectedClickBreadcrumb, message: 'body > button#log' },
        { ...expectedConsoleBreadcrumb, level: 'log', message: 'Some message' },
      ]),
    );
  },
);
