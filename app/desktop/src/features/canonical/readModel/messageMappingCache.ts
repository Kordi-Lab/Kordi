import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  Message,
} from '@/kordi-app/types';
import { mapCanonicalMessage, type MapCanonicalMessageContext } from './messageMapping';

// Identities rarely change while messages arrive, and the per-message view
// model cache below keys on this table. Rebuilding it per pass would retire
// every cached message, so it is derived once per identity list.
const identityIndexes = new WeakMap<
  CanonicalSessionState['identities'],
  Map<string, CanonicalIdentity>
>();

export function identityIndex(
  identities: CanonicalSessionState['identities'],
): Map<string, CanonicalIdentity> {
  const cached = identityIndexes.get(identities);
  if (cached) return cached;
  const index = new Map(identities.map((identity) => [identity.id, identity]));
  identityIndexes.set(identities, index);
  return index;
}

// Every read-model rebuild remaps the whole transcript, so an incoming message
// used to rebuild a view model for all of its history and hand rendering a set
// of fresh objects. Canonical messages are immutable, so a message that still
// resolves the same context can keep its previous result and let rendering skip
// it. Reads are recorded during a miss and revalidated on a hit, so only the
// context a message actually consulted can invalidate it.
type ContextMap = ReadonlyMap<string, string>;
type ContextMapName = keyof MapCanonicalMessageContext;
type RecordedRead = { map: ContextMapName; key: string; value: string | undefined };
type MappedMessageCacheEntry = {
  identityById: Map<string, CanonicalIdentity>;
  profileHumanIdentityId: string | null | undefined;
  reads: RecordedRead[];
  result: Message | null;
};

const mappedMessages = new WeakMap<CanonicalSessionMessage, MappedMessageCacheEntry>();

// A caller that passes no map reads it as empty, so recording against an empty
// map lets a table that appears on a later pass retire the entry like any
// other changed read.
const emptyContextMap: ContextMap = new Map();

// Records which entries a mapping consults. Every other member delegates to the
// caller's map, so the mapper still holds a complete ReadonlyMap rather than an
// object that only answers get().
function recordingContextMap(
  map: ContextMap | null | undefined,
  name: ContextMapName,
  reads: RecordedRead[],
): ContextMap {
  const source = map ?? emptyContextMap;
  const recorder: ContextMap = {
    get(key: string) {
      const value = source.get(key);
      reads.push({ map: name, key, value });
      return value;
    },
    has: (key: string) => source.has(key),
    get size() {
      return source.size;
    },
    forEach(callback: (value: string, key: string, map: ContextMap) => void, thisArg?: unknown) {
      source.forEach((value, key) => callback.call(thisArg, value, key, recorder));
    },
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  };
  return recorder;
}

export function mapCanonicalMessageCached(
  message: CanonicalSessionMessage,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  context: MapCanonicalMessageContext = {},
): Message | null {
  const cached = mappedMessages.get(message);
  if (
    cached
    && cached.identityById === identityById
    && cached.profileHumanIdentityId === profileHumanIdentityId
    && cached.reads.every((read) => context[read.map]?.get(read.key) === read.value)
  ) return cached.result;
  const reads: RecordedRead[] = [];
  const result = mapCanonicalMessage(message, identityById, profileHumanIdentityId, {
    senderIdentityIdByMessageId: recordingContextMap(
      context.senderIdentityIdByMessageId,
      'senderIdentityIdByMessageId',
      reads,
    ),
    visibleReplyTargetByMessageId: recordingContextMap(
      context.visibleReplyTargetByMessageId,
      'visibleReplyTargetByMessageId',
      reads,
    ),
  });
  mappedMessages.set(message, { identityById, profileHumanIdentityId, reads, result });
  return result;
}
