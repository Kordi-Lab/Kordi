// Shapes of the `/v1/cloud/common-ground` routes, camelCase as the server sends them.

export type CgRequestDirection = 'incoming' | 'outgoing';

/** How the viewer is connected to a person. Absent on servers before contact actions. */
export type CgRelationship = {
  contact: boolean;
  request: CgRequestDirection | null;
  requestId: string | null;
  conversationId: string | null;
};

export type CgProfileKind = 'work' | 'health' | 'daily' | 'custom';

/** A card's background: six kind designs (Workshop and Research group are looks, not server kinds), then ten plain colours. */
export const CG_KIND_DESIGNS = ['work', 'health', 'daily', 'workshop', 'research', 'custom'] as const;
export const CG_COLOUR_DESIGNS = ['ocean', 'sky', 'rose', 'coral', 'amber', 'forest', 'lavender', 'graphite', 'mint', 'olive'] as const;
export const CG_CARD_DESIGNS = [...CG_KIND_DESIGNS, ...CG_COLOUR_DESIGNS] as const;
export type CgCardDesign = (typeof CG_CARD_DESIGNS)[number];

/** A card's icon; null draws the design's own glyph. */
export const CG_CARD_ICONS = [
  'briefcase', 'leaf', 'sun', 'flask', 'book', 'microscope', 'graduation', 'pin', 'star',
  'heart', 'chat', 'globe', 'music', 'camera', 'code', 'calendar', 'rocket', 'coffee',
] as const;
export type CgCardIcon = (typeof CG_CARD_ICONS)[number];

/** A card's look as the server keeps it; null design means the kind's default. */
export type CgCardLook = { design: CgCardDesign | null; icon: CgCardIcon | null };

/** The profile someone shares with you in a room or pairing; older servers leave out the look. */
export type CgProfileTag = { profileId: string; kind: CgProfileKind; name: string; design?: CgCardDesign | null; icon?: CgCardIcon | null };

/** One of the owner's profiles, as `GET profiles` lists it (`commonGroundVersion` 2). */
export type CgProfile = CgProfileTag & CgCardLook & {
  focus: string | null;
  position: number;
  hasCard: boolean;
  sharing: boolean;
  builtAt: string | null;
  topicCount: number;
  /** The owner's saved source picks (`commonGroundVersion` 3); null until first saved. */
  sources?: CgSourcePicks | null;
};

/** What a card is built from, as the owner last picked it. Clients keep fields they cannot act on. */
export type CgSourcePicks = {
  memory: boolean;
  /** Connector providers, such as `gmail`. */
  connectors: string[];
  device: CgDeviceSource[];
  agents: boolean;
  /** Attachment ids of the owner's own Kordi documents, up to eight. */
  documents: string[];
  links: string;
  notes: string;
};

/** One of the owner's Markdown documents a card may read. */
export type CgDocument = { attachmentId: string; title: string; updatedAt: string; sizeBytes: number | null };

export type CgProfileInput = { kind: CgProfileKind; name?: string; focus?: string; design?: CgCardDesign; icon?: CgCardIcon };

/** `PUT profiles/:id`: a left-out field is kept; a null look field resets it. */
export type CgProfilePatch = { name?: string; focus?: string; design?: CgCardDesign | null; icon?: CgCardIcon | null; sources?: CgSourcePicks | null };

export type CgPerson = {
  accountId: string;
  name: string;
  avatarUrl: string | null;
  /** Their Kordi handle without the @; absent on older servers. */
  handle?: string | null;
  hasCard?: boolean;
  relationship?: CgRelationship;
  /** The profile they share with you; absent on servers before profiles. */
  profile?: CgProfileTag;
};

export type CgTopicLists = {
  workingOn: string[];
  interests: string[];
  canHelp: string[];
  lookingFor: string[];
};

export type CgTopicKey = keyof CgTopicLists;

export const CG_TOPIC_SECTIONS: Array<[CgTopicKey, string]> = [
  ['workingOn', 'Working on'],
  ['interests', 'Interests'],
  ['canHelp', 'Can help with'],
  ['lookingFor', 'Looking for'],
];

/** One item behind a topic, as the owner's view sends it; `date` is `YYYY-MM-DD` when known. */
export type CgEvidence = { source: string; title: string; date: string | null; url: string | null; snippet: string };

/** The references behind one topic, newest first, and when it was first and last seen. */
export type CgTopicInfo = { refs: string[]; firstSeen: string | null; lastSeen: string | null };

/** One period of the owner's timeline, such as "2026 Q3"; each topic sits in the period it first appeared. */
export type CgTimelinePeriod = { period: string; topics: string[] };

/**
 * The owner's view of a card: `latest` is the topics active now, `timeline` the periods newest first,
 * `earlier` the past topics. Older servers leave any of them out.
 */
export type CgCardProfile = {
  latest?: string[];
  earlier?: string[];
  timeline?: CgTimelinePeriod[];
  topics?: Record<string, CgTopicInfo>;
  evidence?: Record<string, CgEvidence>;
};

export type CgOwnCard = CgTopicLists & {
  hidden: string[];
  revision: number;
  builtAt: string | null;
  profile?: CgCardProfile | null;
};

export type CgBuildStatus = 'idle' | 'building' | 'failed';

export type CgOwnerView = {
  card: CgOwnCard | null;
  sharing: boolean;
  build: { status: CgBuildStatus; errorCode: string | null };
  used?: string[];
  /** The profile this card belongs to; absent before profiles. */
  profile?: (CgProfileTag & { focus: string | null }) | null;
  /** Memories filed to this profile since the card was built (`memoryVersion` 2). */
  memoriesSinceBuild?: number;
};

/** A memory filed to a profile; `everyProfile` marks a schedule memory every fixed-kind profile lists. */
export type CgRoutedMemory = {
  memoryId: string;
  text: string;
  category: string | null;
  updatedAt: string;
  profileId: string | null;
  /** The cards the memory feeds, in profile order (`memoryVersion` 3); empty from older servers. */
  profileIds: string[];
  everyProfile: boolean;
};

export type CgDeviceSource = 'calendar' | 'reminders';
export type CgDeviceItem = { title: string; date: string | null };

/** An agent instruction or memory file from this Mac; `label` is the path under the home directory. */
export type CgAgentFile = { label: string; text: string };

export type CgBuildRequest = {
  memory: boolean;
  /** True when any connector is on; before version 3 the server reads all of them. */
  connectors: boolean;
  device: Array<{ source: string; items: CgDeviceItem[] }>;
  links: string;
  notes: string;
  /** Sent only when the Agents on this Mac switch is on. */
  agents?: CgAgentFile[];
  /** `commonGroundVersion` 3: the providers to read, the documents, and the picks to save. */
  connectorProviders?: string[];
  documents?: string[];
  picks?: CgSourcePicks;
};

/** The server sends `relationship` beside `person`; the client folds it into `person`. */
export type CgPersonCard = { person: CgPerson; card: CgTopicLists; relationship?: CgRelationship };

/** A pairing code to show, valid until `expiresAt` and once; `profileId` is the profile it shares. */
export type CgPairCode = { code: string; expiresAt: string; profileId?: string };

/** `profileId` is the viewer's profile the match was found through. */
export type CgRecentEntry = {
  person: CgPerson;
  score: number | null;
  headline: string | null;
  openedAt?: string;
  relationship?: CgRelationship;
  profileId?: string;
};

/** What a join sends: the room name and kind apply only when this join opens the room. */
export type CgJoinInput = { name?: string; kind?: CgProfileKind; profileId?: string };

/** `POST rooms`: opens a meetup on a free code; the reply is the room with its new `code`. */
export type CgCreateRoomInput = { name: string; kind: CgProfileKind; profileId?: string };

/** `GET rooms/:code/preview`: a room before joining it; `member` is true when you are already in it. Null fields are unknown (older servers). */
/**
 * `GET rooms/:code/preview`. A member gets `profileId`, the card already shared there; anyone else
 * gets `suggestedProfileId`, the card a join would use. Older servers send neither.
 */
export type CgRoomPreview = {
  code: string;
  name: string;
  kind: CgProfileKind | null;
  memberCount: number | null;
  member?: boolean;
  profileId?: string;
  suggestedProfileId?: string;
};

export type CgGroup = {
  groupSpaceId: string;
  conversationId: string;
  name: string;
  memberCount: number;
  createdBy?: CgPerson;
  joined?: boolean;
  /** The topic the group was started from; null on older servers. */
  topic?: string | null;
  /** Humans only, creator first, up to eight; missing on older servers. */
  members?: CgPerson[];
};

export type CgInvitation = { invitationRef: string; groupSpaceId: string; name: string; from: CgPerson; createdAt: string };

export type CgRoom = {
  roomId: string;
  code: string;
  name: string;
  openedByYou: boolean;
  expiresAt: string;
  /** False once the room has closed; absent on older servers. */
  open?: boolean;
  /** The profile kind the room suggests, and the profile you share in it. */
  kind?: CgProfileKind | null;
  profileId?: string | null;
  members: CgPerson[];
  groups?: CgGroup[];
  invitations?: CgInvitation[];
};

/** A room the viewer joined and has not left, open or closed. */
export type CgRoomSummary = {
  code: string;
  name: string;
  open: boolean;
  memberCount: number;
  joinedAt: string;
  lastActivityAt: string;
  themeCount: number;
  kind?: CgProfileKind | null;
  profileId?: string | null;
};

export type CgTheme = { label: string; people: CgPerson[] };
export type CgRankedPerson = { person: CgPerson; score: number; headline: string; relationship?: CgRelationship };
export type CgMatchStatus = 'ready' | 'matching' | 'failed';

export type CgResults = {
  status: CgMatchStatus;
  people: CgRankedPerson[];
  topics: CgTheme[];
  suggestion: CgTheme | null;
  /** Your profile shared in the room. */
  profileId?: string;
  groups?: CgGroup[];
  invitations?: CgInvitation[];
};

export type CgReason = { topic: string; theirTopic: string; why: string };
export type CgTrade = { topic: string; for: string; why: string };

export type CgMatch = {
  status: CgMatchStatus;
  person: CgPerson;
  score?: number;
  headline?: string;
  shared?: CgReason[];
  youBring?: CgTrade[];
  theyBring?: CgTrade[];
  nextStep?: string;
  relationship?: CgRelationship;
  profileId?: string;
};

export type CgMeetInput = { title?: string; startAt: string; endAt?: string; location?: string };

export type CgCreatedGroup = { group: CgGroup; added: CgPerson[]; invited: CgPerson[] };
