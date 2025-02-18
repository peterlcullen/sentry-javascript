import type { ClientOptions, Event, EventHint, StackParser } from '@sentry/types';
import { dateTimestampInSeconds, GLOBAL_OBJ, normalize, resolvedSyncPromise, truncate, uuid4 } from '@sentry/utils';

import { DEFAULT_ENVIRONMENT } from '../constants';
import { Scope } from '../scope';

/**
 * Adds common information to events.
 *
 * The information includes release and environment from `options`,
 * breadcrumbs and context (extra, tags and user) from the scope.
 *
 * Information that is already present in the event is never overwritten. For
 * nested objects, such as the context, keys are merged.
 *
 * Note: This also triggers callbacks for `addGlobalEventProcessor`, but not `beforeSend`.
 *
 * @param event The original event.
 * @param hint May contain additional information about the original exception.
 * @param scope A scope containing event metadata.
 * @returns A new event with more information.
 * @hidden
 */
export function prepareEvent(
  options: ClientOptions,
  event: Event,
  hint: EventHint,
  scope?: Scope,
): PromiseLike<Event | null> {
  const { normalizeDepth = 3, normalizeMaxBreadth = 1_000 } = options;
  const prepared: Event = {
    ...event,
    event_id: event.event_id || hint.event_id || uuid4(),
    timestamp: event.timestamp || dateTimestampInSeconds(),
  };
  const integrations = hint.integrations || options.integrations.map(i => i.name);

  applyClientOptions(prepared, options);
  applyIntegrationsMetadata(prepared, integrations);
  applyDebugMetadata(prepared, options.stackParser);

  // If we have scope given to us, use it as the base for further modifications.
  // This allows us to prevent unnecessary copying of data if `captureContext` is not provided.
  let finalScope = scope;
  if (hint.captureContext) {
    finalScope = Scope.clone(finalScope).update(hint.captureContext);
  }

  // We prepare the result here with a resolved Event.
  let result = resolvedSyncPromise<Event | null>(prepared);

  // This should be the last thing called, since we want that
  // {@link Hub.addEventProcessor} gets the finished prepared event.
  //
  // We need to check for the existence of `finalScope.getAttachments`
  // because `getAttachments` can be undefined if users are using an older version
  // of `@sentry/core` that does not have the `getAttachments` method.
  // See: https://github.com/getsentry/sentry-javascript/issues/5229
  if (finalScope) {
    // Collect attachments from the hint and scope
    if (finalScope.getAttachments) {
      const attachments = [...(hint.attachments || []), ...finalScope.getAttachments()];

      if (attachments.length) {
        hint.attachments = attachments;
      }
    }

    // In case we have a hub we reassign it.
    result = finalScope.applyToEvent(prepared, hint);
  }

  return result.then(evt => {
    if (typeof normalizeDepth === 'number' && normalizeDepth > 0) {
      return normalizeEvent(evt, normalizeDepth, normalizeMaxBreadth);
    }
    return evt;
  });
}

/**
 *  Enhances event using the client configuration.
 *  It takes care of all "static" values like environment, release and `dist`,
 *  as well as truncating overly long values.
 * @param event event instance to be enhanced
 */
function applyClientOptions(event: Event, options: ClientOptions): void {
  const { environment, release, dist, maxValueLength = 250 } = options;

  if (!('environment' in event)) {
    event.environment = 'environment' in options ? environment : DEFAULT_ENVIRONMENT;
  }

  if (event.release === undefined && release !== undefined) {
    event.release = release;
  }

  if (event.dist === undefined && dist !== undefined) {
    event.dist = dist;
  }

  if (event.message) {
    event.message = truncate(event.message, maxValueLength);
  }

  const exception = event.exception && event.exception.values && event.exception.values[0];
  if (exception && exception.value) {
    exception.value = truncate(exception.value, maxValueLength);
  }

  const request = event.request;
  if (request && request.url) {
    request.url = truncate(request.url, maxValueLength);
  }
}

/**
 * Applies debug metadata images to the event in order to apply source maps by looking up their debug ID.
 */
export function applyDebugMetadata(event: Event, stackParser: StackParser): void {
  const debugIdMap = GLOBAL_OBJ._sentryDebugIds;

  if (!debugIdMap) {
    return;
  }

  // Build a map of abs_path -> debug_id
  const absPathDebugIdMap = Object.keys(debugIdMap).reduce<Record<string, string>>((acc, debugIdStackTrace) => {
    const parsedStack = stackParser(debugIdStackTrace);
    for (const stackFrame of parsedStack) {
      if (stackFrame.abs_path) {
        acc[stackFrame.abs_path] = debugIdMap[debugIdStackTrace];
        break;
      }
    }
    return acc;
  }, {});

  // Get a Set of abs_paths in the stack trace
  const errorAbsPaths = new Set<string>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    event!.exception!.values!.forEach(exception => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      exception.stacktrace!.frames!.forEach(frame => {
        if (frame.abs_path) {
          errorAbsPaths.add(frame.abs_path);
        }
      });
    });
  } catch (e) {
    // To save bundle size we're just try catching here instead of checking for the existence of all the different objects.
  }

  // Fill debug_meta information
  event.debug_meta = event.debug_meta || {};
  event.debug_meta.images = event.debug_meta.images || [];
  const images = event.debug_meta.images;
  errorAbsPaths.forEach(absPath => {
    if (absPathDebugIdMap[absPath]) {
      images.push({
        type: 'sourcemap',
        code_file: absPath,
        debug_id: absPathDebugIdMap[absPath],
      });
    }
  });
}

/**
 * This function adds all used integrations to the SDK info in the event.
 * @param event The event that will be filled with all integrations.
 */
function applyIntegrationsMetadata(event: Event, integrationNames: string[]): void {
  if (integrationNames.length > 0) {
    event.sdk = event.sdk || {};
    event.sdk.integrations = [...(event.sdk.integrations || []), ...integrationNames];
  }
}

/**
 * Applies `normalize` function on necessary `Event` attributes to make them safe for serialization.
 * Normalized keys:
 * - `breadcrumbs.data`
 * - `user`
 * - `contexts`
 * - `extra`
 * @param event Event
 * @returns Normalized event
 */
function normalizeEvent(event: Event | null, depth: number, maxBreadth: number): Event | null {
  if (!event) {
    return null;
  }

  const normalized: Event = {
    ...event,
    ...(event.breadcrumbs && {
      breadcrumbs: event.breadcrumbs.map(b => ({
        ...b,
        ...(b.data && {
          data: normalize(b.data, depth, maxBreadth),
        }),
      })),
    }),
    ...(event.user && {
      user: normalize(event.user, depth, maxBreadth),
    }),
    ...(event.contexts && {
      contexts: normalize(event.contexts, depth, maxBreadth),
    }),
    ...(event.extra && {
      extra: normalize(event.extra, depth, maxBreadth),
    }),
  };

  // event.contexts.trace stores information about a Transaction. Similarly,
  // event.spans[] stores information about child Spans. Given that a
  // Transaction is conceptually a Span, normalization should apply to both
  // Transactions and Spans consistently.
  // For now the decision is to skip normalization of Transactions and Spans,
  // so this block overwrites the normalized event to add back the original
  // Transaction information prior to normalization.
  if (event.contexts && event.contexts.trace && normalized.contexts) {
    normalized.contexts.trace = event.contexts.trace;

    // event.contexts.trace.data may contain circular/dangerous data so we need to normalize it
    if (event.contexts.trace.data) {
      normalized.contexts.trace.data = normalize(event.contexts.trace.data, depth, maxBreadth);
    }
  }

  // event.spans[].data may contain circular/dangerous data so we need to normalize it
  if (event.spans) {
    normalized.spans = event.spans.map(span => {
      // We cannot use the spread operator here because `toJSON` on `span` is non-enumerable
      if (span.data) {
        span.data = normalize(span.data, depth, maxBreadth);
      }
      return span;
    });
  }

  return normalized;
}
