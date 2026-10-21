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

/** The profile someone shares with you in a room or pairing. */
export type CgProfileTag = { profileId: string; kind: CgProfileKind; name: string };

/** One of the owner's profiles, as `GET profiles` lists it (`commonGroundVersion` 2). */
export type CgProfile = CgProfileTag & {
  focus: string | null;
  position: number;
  hasCard: boolean;
  sharing: boolean;
  builtAt: string | null;
  topicCount: number;
};

export type CgProfileInput = { kind: CgProfileKind; name?: string; focus?: string };

export type CgPerson = {
  accountId: string;
  name: string;
  avatarUrl: string | null;
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

export type CgOwnCard = CgTopicLists & {
  hidden: string[];
  revision: number;
  builtAt: string | null;
  profile?: { latest?: string[] } | null;
};

export type CgBuildStatus = 'idle' | 'building' | 'failed';

export type CgOwnerView = {
  card: CgOwnCard | null;
  sharing: boolean;
  build: { status: CgBuildStatus; errorCode: string | null };
  used?: string[];
  /** The profile this card belongs to; absent before profiles. */
  profile?: (CgProfileTag & { focus: string | null }) | null;
};

export type CgDeviceSource = 'calendar' | 'reminders';
export type CgDeviceItem = { title: string; date: string | null };

/** An agent instruction or memory file from this Mac; `label` is the path under the home directory. */
export type CgAgentFile = { label: string; text: string };

export type CgBuildRequest = {
  memory: boolean;
  /** True when any connector is connected; the server reads events for all of them. */
  connectors: boolean;
  device: Array<{ source: string; items: CgDeviceItem[] }>;
  links: string;
  notes: string;
  /** Sent only when the Agents on this Mac switch is on. */
  agents?: CgAgentFile[];
};

/** The server sends `relationship` beside `person`; the client folds it into `person`. */
export type CgPersonCard = { person: CgPerson; card: CgTopicLists; relationship?: CgRelationship };

export type CgPairCode = { code: string; expiresAt: string };

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
