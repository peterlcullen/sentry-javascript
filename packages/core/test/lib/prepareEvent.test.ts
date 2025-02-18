import type { Event } from '@sentry/types';
import { createStackParser, GLOBAL_OBJ } from '@sentry/utils';

import { applyDebugMetadata } from '../../src/utils/prepareEvent';

describe('applyDebugMetadata', () => {
  afterEach(() => {
    GLOBAL_OBJ._sentryDebugIds = undefined;
  });

  it('should put debug source map images in debug_meta field', () => {
    GLOBAL_OBJ._sentryDebugIds = {
      'filename1.js\nfilename1.js': 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa',
      'filename2.js\nfilename2.js': 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbb',
      'filename4.js\nfilename4.js': 'cccccccc-cccc-4ccc-cccc-cccccccccc',
    };

    const stackParser = createStackParser([0, line => ({ filename: line, abs_path: line })]);

    const event: Event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { abs_path: 'filename1.js', filename: 'filename1.js' },
                { abs_path: 'filename2.js', filename: 'filename2.js' },
                { abs_path: 'filename1.js', filename: 'filename1.js' },
                { abs_path: 'filename3.js', filename: 'filename3.js' },
              ],
            },
          },
        ],
      },
    };

    applyDebugMetadata(event, stackParser);

    expect(event.debug_meta?.images).toContainEqual({
      type: 'sourcemap',
      code_file: 'filename1.js',
      debug_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa',
    });

    expect(event.debug_meta?.images).toContainEqual({
      type: 'sourcemap',
      code_file: 'filename2.js',
      debug_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbb',
    });

    // expect not to contain an image for the stack frame that doesn't have a corresponding debug id
    expect(event.debug_meta?.images).not.toContainEqual(
      expect.objectContaining({
        type: 'sourcemap',
        code_file: 'filename3.js',
      }),
    );

    // expect not to contain an image for the debug id mapping that isn't contained in the stack trace
    expect(event.debug_meta?.images).not.toContainEqual(
      expect.objectContaining({
        type: 'sourcemap',
        code_file: 'filename4.js',
        debug_id: 'cccccccc-cccc-4ccc-cccc-cccccccccc',
      }),
    );
  });
});
