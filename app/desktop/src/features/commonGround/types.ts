// Shapes of the `/v1/cloud/common-ground` routes, camelCase as the server sends them.

export type CgRequestDirection = 'incoming' | 'outgoing';

/** How the viewer is connected to a person. Absent on servers before contact actions. */
export type CgRelationship = {
  contact: boolean;
  request: CgRequestDirection | null;
  requestId: string | null;
  conversationId: string | null;
};

export type CgPerson = {
  accountId: string;
  name: string;
  avatarUrl: string | null;
  hasCard?: boolean;
  relationship?: CgRelationship;
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
};

export type CgDeviceSource = 'calendar' | 'reminders';
export type CgDeviceItem = { title: string; date: string | null };

export type CgBuildRequest = {
  memory: boolean;
  connectors: boolean;
  device: Array<{ source: string; items: CgDeviceItem[] }>;
  links: string;
  notes: string;
};

export type CgPersonCard = { person: CgPerson; card: CgTopicLists };

export type CgPairCode = { code: string; expiresAt: string };

export type CgRecentEntry = { person: CgPerson; score: number | null; headline: string | null; openedAt?: string };

export type CgGroup = {
  groupSpaceId: string;
  conversationId: string;
  name: string;
  memberCount: number;
  createdBy?: CgPerson;
  joined?: boolean;
};

export type CgInvitation = { invitationRef: string; groupSpaceId: string; name: string; from: CgPerson; createdAt: string };

export type CgRoom = {
  roomId: string;
  code: string;
  name: string;
  openedByYou: boolean;
  expiresAt: string;
  members: CgPerson[];
  groups?: CgGroup[];
  invitations?: CgInvitation[];
};

export type CgTheme = { label: string; people: CgPerson[] };
export type CgRankedPerson = { person: CgPerson; score: number; headline: string };
export type CgMatchStatus = 'ready' | 'matching' | 'failed';

export type CgResults = {
  status: CgMatchStatus;
  people: CgRankedPerson[];
  topics: CgTheme[];
  suggestion: CgTheme | null;
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
};

export type CgMeetInput = { title?: string; startAt: string; endAt?: string; location?: string };

export type CgCreatedGroup = { group: CgGroup; added: CgPerson[]; invited: CgPerson[] };
