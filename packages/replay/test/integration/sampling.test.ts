import { mockRrweb, mockSdk } from '../index';
import { useFakeTimers } from '../utils/use-fake-timers';

useFakeTimers();

describe('Integration | sampling', () => {
  it('does nothing if not sampled', async () => {
    const { record: mockRecord } = mockRrweb();
    const { replay } = await mockSdk({
      replayOptions: {
        stickySession: true,
      },
      sentryOptions: {
        replaysSessionSampleRate: 0.0,
        replaysOnErrorSampleRate: 0.0,
      },
    });

    // @ts-ignore private API
    const spyAddListeners = jest.spyOn(replay, '_addListeners');
    jest.runAllTimers();

    expect(replay.session?.sampled).toBe(false);
    expect(replay.getContext()).toEqual(
      expect.objectContaining({
        initialTimestamp: expect.any(Number),
        initialUrl: 'http://localhost/',
      }),
    );
    expect(mockRecord).not.toHaveBeenCalled();
    expect(spyAddListeners).not.toHaveBeenCalled();
  });
});
